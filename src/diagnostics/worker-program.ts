/**
 * The diagnostics actor is created with an eval source so the same program
 * works both from TypeScript tests and from compiled JavaScript without a
 * second build asset. Production runs it in an independent child process;
 * the worker_threads transport remains only as a test adapter while the
 * process-isolation cutover is completed.
 * This function must remain self-contained: only its serialized body runs in
 * the Worker isolate.
 */
function diagnosticsWorkerMain(): void {
  /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports -- the serialized eval Worker has no module-scope imports */
  const { parentPort, workerData } = require("node:worker_threads") as typeof import("node:worker_threads");
  const {
    chmodSync,
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    rmdirSync,
    statSync,
    writeFileSync,
  } = require("node:fs") as typeof import("node:fs");
  const { createHash, randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const { basename, dirname, join, resolve, sep } = require("node:path") as typeof import("node:path");
  const { backup, DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */

  const processData = process.env.TOKEN_DIAGNOSTICS_PROCESS_DATA;
  const port = parentPort ?? {
    postMessage(message: unknown): void {
      if (typeof process.send === "function") process.send(message);
    },
    on(event: "message", listener: (message: unknown) => void): void {
      process.on(event, listener);
    },
  };
  if (parentPort === null && processData === undefined) {
    throw new Error("Diagnostics process has no parent IPC data");
  }
  const data = (parentPort === null
    ? JSON.parse(processData!)
    : workerData) as {
    readonly directory: string;
    readonly runtimeId: string;
    readonly artifactRetentionAgeMs: number;
    readonly maxArtifactJourneys: number;
    readonly maxArtifactDiskBytes: number;
    readonly maxJsonArtifactBytes: number;
    readonly maxJourneyArtifactBytes: number;
    /** @internal Bounded-page test seam; production uses the fixed default. */
    readonly analyticsPageSize?: number;
  };
  const analyticsPageSize =
    typeof data.analyticsPageSize === "number" &&
    Number.isSafeInteger(data.analyticsPageSize) &&
    data.analyticsPageSize > 0 &&
    data.analyticsPageSize <= 1_000
      ? data.analyticsPageSize
      : 1_000;
  const artifactRetentionAgeMs =
    Number.isSafeInteger(data.artifactRetentionAgeMs) &&
    data.artifactRetentionAgeMs > 0
      ? data.artifactRetentionAgeMs
      : 604_800_000;
  const maxArtifactJourneys =
    Number.isSafeInteger(data.maxArtifactJourneys) &&
    data.maxArtifactJourneys > 0
      ? data.maxArtifactJourneys
      : 1_000;
  const maxArtifactDiskBytes =
    Number.isSafeInteger(data.maxArtifactDiskBytes) &&
    data.maxArtifactDiskBytes > 0
      ? data.maxArtifactDiskBytes
      : 5_368_709_120;
  const maxJsonArtifactBytes =
    Number.isSafeInteger(data.maxJsonArtifactBytes) &&
    data.maxJsonArtifactBytes > 0 &&
    data.maxJsonArtifactBytes <= 64 * 1_024 * 1_024
      ? data.maxJsonArtifactBytes
      : 64 * 1_024 * 1_024;
  const maxActiveArtifactBytes =
    Number.isSafeInteger(data.maxJourneyArtifactBytes) &&
    data.maxJourneyArtifactBytes > 0 &&
    data.maxJourneyArtifactBytes <= 512 * 1_024 * 1_024
      ? data.maxJourneyArtifactBytes
      : 512 * 1_024 * 1_024;
  const activeArtifacts = new Map<string, {
    readonly descriptor: Readonly<Record<string, unknown>>;
    readonly chunks: Uint8Array[];
    receivedBytes: number;
    nextChunkIndex: number;
  }>();
  const completedArtifacts = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  let activeArtifactBytes = 0;
  mkdirSync(data.directory, { recursive: true });
  const fullJourneyDirectory = join(data.directory, "full-journeys");
  const inflightDirectory = join(fullJourneyDirectory, ".inflight");
  mkdirSync(inflightDirectory, { recursive: true });
  const database = new DatabaseSync(join(data.directory, "diagnostics-v3.sqlite3"));
  const permanentStartupFailure = (): void => {
    database.close();
    port.postMessage({
      type: "startup_failure",
      classification: "diagnostics_schema_incompatible",
    });
  };

  const existingObjects = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ readonly name: string }>;
  const hasMeta = existingObjects.some((entry) => entry.name === "meta");
  if (existingObjects.length > 0 && !hasMeta) {
    permanentStartupFailure();
    return;
  }
  if (hasMeta) {
    const existingSchema = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_name'")
      .get() as { readonly value: string } | undefined;
    if (
      existingSchema === undefined ||
      existingSchema.value !== "TOKEN_diagnostics"
    ) {
      permanentStartupFailure();
      return;
    }
    const existingVersion = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { readonly value: number } | undefined;
    if (existingVersion === undefined || Number(existingVersion.value) !== 3) {
      permanentStartupFailure();
      return;
    }
    if (existingObjects.some((entry) => entry.name === "records")) {
      const columns = database
        .prepare("PRAGMA table_info(records)")
        .all() as Array<{ readonly name: string }>;
      if (!columns.some((column) => column.name === "record_id")) {
        permanentStartupFailure();
        return;
      }
    }
    if (existingObjects.some((entry) => entry.name === "request_journeys")) {
      const columns = database
        .prepare("PRAGMA table_info(request_journeys)")
        .all() as Array<{ readonly name: string }>;
      const requiredColumns = [
        "accepted_at",
        "provider_id",
        "real_model_id",
        "client_session_id",
        "effective_session_id",
        "profile_id",
        "profile_display_name",
        "analytics_outcome",
        "execution_started_at",
        "execution_terminal_at",
        "usage_terminal_class",
        "usage_input",
        "usage_cache_read",
        "usage_output",
      ];
      if (
        requiredColumns.some(
          (requiredColumn) =>
            !columns.some((column) => column.name === requiredColumn),
        )
      ) {
        permanentStartupFailure();
        return;
      }
    }
  } else {
    database.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value NOT NULL
      );
    `);
  }
  database.exec(`
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_name', 'TOKEN_diagnostics');
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', 3);
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_kind TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      record_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      closed_at INTEGER,
      completeness TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_journeys (
      record_id INTEGER PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL,
      protocol TEXT,
      lane TEXT,
      outcome TEXT NOT NULL,
      admission_json TEXT NOT NULL,
      primary_failure_id TEXT,
      transport TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      provider_id TEXT,
      real_model_id TEXT,
      client_session_id TEXT,
      effective_session_id TEXT,
      profile_id TEXT,
      profile_display_name TEXT,
      analytics_outcome TEXT NOT NULL,
      execution_started_at INTEGER,
      execution_terminal_at INTEGER,
      usage_terminal_class TEXT,
      usage_input INTEGER,
      usage_cache_read INTEGER,
      usage_output INTEGER
    );
    CREATE INDEX IF NOT EXISTS request_journeys_accepted_at_record
      ON request_journeys (accepted_at, record_id);
    CREATE TABLE IF NOT EXISTS request_journey_events (
      runtime_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      time INTEGER NOT NULL,
      kind TEXT NOT NULL,
      phase TEXT NOT NULL,
      lane TEXT,
      direction TEXT,
      step TEXT NOT NULL,
      subject TEXT,
      source_path TEXT,
      attempt INTEGER,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (runtime_id, request_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS request_journey_events_request_sequence
      ON request_journey_events (request_id, sequence);
    CREATE TABLE IF NOT EXISTS request_journey_artifacts (
      request_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      descriptor_json TEXT NOT NULL,
      body_path TEXT,
      PRIMARY KEY (request_id, artifact_id)
    );
    CREATE TABLE IF NOT EXISTS artifact_evictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      time INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_events (
      runtime_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      time INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (runtime_id, record_id, sequence),
      FOREIGN KEY (record_id) REFERENCES records(record_id) ON DELETE CASCADE
    );
  `);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");

  const storageRoot = resolve(data.directory);
  const canonicalStorageRoot = realpathSync(storageRoot);
  const storagePath = (relativePath: string): string => {
    const absolutePath = resolve(storageRoot, relativePath);
    if (
      absolutePath === storageRoot ||
      !absolutePath.startsWith(`${storageRoot}${sep}`)
    ) {
      throw new Error("Diagnostics artifact path escaped its storage root");
    }
    return absolutePath;
  };
  const existingStorageFile = (relativePath: string): string => {
    const canonicalPath = realpathSync(storagePath(relativePath));
    if (
      canonicalPath === canonicalStorageRoot ||
      !canonicalPath.startsWith(`${canonicalStorageRoot}${sep}`) ||
      !statSync(canonicalPath).isFile()
    ) {
      throw new Error("Diagnostics artifact is not a managed file");
    }
    return canonicalPath;
  };
  const opaqueSegment = (prefix: string, value: string): string =>
    `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
  const readableArtifactSegment = (artifactId: string): string => {
    const slug = artifactId
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "capture";
    const hash = createHash("sha256")
      .update(artifactId)
      .digest("hex")
      .slice(0, 8);
    return `${slug}-${hash}`;
  };
  const inflightJourneyRelative = (
    runtimeId: string,
    requestId: string,
  ): string =>
    join(
      "full-journeys",
      ".inflight",
      opaqueSegment("runtime", runtimeId),
      opaqueSegment("request", requestId),
    );
  const artifactBodyRelative = (
    runtimeId: string,
    requestId: string,
    artifactId: string,
    suffix: ".part" | ".json" | ".jsonl" | ".sse",
  ): string =>
    join(
      inflightJourneyRelative(runtimeId, requestId),
      "artifacts",
      `${readableArtifactSegment(artifactId)}${suffix}`,
    );
  const artifactKey = (
    runtimeId: string,
    requestId: string,
    artifactId: string,
  ): string => `${runtimeId}\u0000${requestId}\u0000${artifactId}`;
  const discardActiveArtifact = (key: string): void => {
    const active = activeArtifacts.get(key);
    if (active === undefined) return;
    activeArtifactBytes = Math.max(
      0,
      activeArtifactBytes - active.receivedBytes,
    );
    activeArtifacts.delete(key);
  };
  const writeSanitizedArtifact = (
    runtimeId: string,
    requestId: string,
    artifactId: string,
    bytes: Uint8Array,
  ): void => {
    const relativePath = artifactBodyRelative(
      runtimeId,
      requestId,
      artifactId,
      ".part",
    );
    const absolutePath = storagePath(relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, bytes, { flag: "w", mode: 0o600 });
  };
  const completeArtifactBody = (
    runtimeId: string,
    requestId: string,
    artifactId: string,
    descriptor: Readonly<Record<string, unknown>>,
  ): string | null => {
    const partRelative = artifactBodyRelative(
      runtimeId,
      requestId,
      artifactId,
      ".part",
    );
    const mediaType = typeof descriptor.mediaType === "string"
      ? descriptor.mediaType.split(";", 1)[0]!.trim().toLowerCase()
      : "";
    const extension = mediaType === "text/event-stream"
      ? ".sse"
      : mediaType === "application/jsonl" ||
          mediaType === "application/x-jsonlines" ||
          mediaType === "application/ndjson" ||
          mediaType === "application/x-ndjson"
        ? ".jsonl"
        : ".json";
    const finalRelative = artifactBodyRelative(
      runtimeId,
      requestId,
      artifactId,
      extension,
    );
    const partPath = storagePath(partRelative);
    const finalPath = storagePath(finalRelative);
    const bodyAvailable =
      (descriptor.state === "captured" || descriptor.state === "partial") &&
      typeof descriptor.capturedBytes === "number" &&
      descriptor.capturedBytes > 0;
    if (!bodyAvailable) {
      rmSync(partPath, { force: true });
      rmSync(finalPath, { force: true });
      return null;
    }
    try {
      renameSync(partPath, finalPath);
    } catch {
      const existing = statSync(finalPath);
      if (existing.size !== descriptor.capturedBytes) throw new Error(
        "Diagnostics artifact file length is inconsistent",
      );
    }
    if (statSync(finalPath).size !== descriptor.capturedBytes) {
      rmSync(finalPath, { force: true });
      throw new Error("Diagnostics artifact file is incomplete");
    }
    return finalRelative;
  };
  const finalizeJourneyFiles = (requestId: string): void => {
    const journey = database
      .prepare(
        `SELECT r.runtime_id AS runtimeId, j.accepted_at AS acceptedAt,
                j.operation AS operation, j.protocol AS protocol,
                j.lane AS lane, j.outcome AS outcome
           FROM request_journeys j
           JOIN records r ON r.id = j.record_id
          WHERE j.request_id = ?`,
      )
      .get(requestId) as
      | {
          readonly runtimeId: string;
          readonly acceptedAt: number;
          readonly operation: string;
          readonly protocol: string | null;
          readonly lane: string | null;
          readonly outcome: string;
        }
      | undefined;
    if (journey === undefined) return;
    const artifacts = database
      .prepare(
        `SELECT artifact_id AS artifactId, descriptor_json AS descriptorJson,
                body_path AS bodyPath
           FROM request_journey_artifacts
          WHERE request_id = ? ORDER BY artifact_id`,
      )
      .all(requestId) as Array<{
      readonly artifactId: string;
      readonly descriptorJson: string;
      readonly bodyPath: string | null;
    }>;
    const inflightRelative = inflightJourneyRelative(
      journey.runtimeId,
      requestId,
    );
    const inflightPath = storagePath(inflightRelative);
    const removeEmptyRuntimeDirectory = (): void => {
      try {
        rmdirSync(dirname(inflightPath));
      } catch {
        // Concurrent Journeys keep the runtime directory non-empty. It is
        // removed by the last closer or by startup orphan recovery.
      }
    };
    if (!artifacts.some((artifact) => artifact.bodyPath !== null)) {
      try {
        rmSync(inflightPath, { recursive: true, force: true });
        removeEmptyRuntimeDirectory();
      } catch {
        // A policy-rejected body has no index reference. Empty-directory
        // cleanup remains best effort inside the diagnostics process.
      }
      return;
    }

    const date = new Date(Number(journey.acceptedAt))
      .toISOString()
      .slice(0, 10);
    const finalRelative = join(
      "full-journeys",
      date,
      opaqueSegment("request", requestId),
    );
    const finalPath = storagePath(finalRelative);
    const manifest = {
      schema: "Token.full-journey.v1",
      requestId,
      runtimeId: journey.runtimeId,
      acceptedAt: Number(journey.acceptedAt),
      operation: journey.operation,
      ...(journey.protocol === null ? {} : { protocol: journey.protocol }),
      ...(journey.lane === null ? {} : { lane: journey.lane }),
      outcome: journey.outcome,
      artifacts: artifacts.map((artifact) => ({
        ...(JSON.parse(artifact.descriptorJson) as Record<string, unknown>),
        ...(artifact.bodyPath === null
          ? {}
          : {
              file: join("artifacts", basename(artifact.bodyPath)).replaceAll(
                "\\",
                "/",
              ),
            }),
      })),
    };
    mkdirSync(inflightPath, { recursive: true });
    const manifestTemporary = join(inflightPath, "manifest.json.tmp");
    writeFileSync(manifestTemporary, JSON.stringify(manifest, null, 2), {
      flag: "w",
      mode: 0o600,
    });
    renameSync(manifestTemporary, join(inflightPath, "manifest.json"));
    mkdirSync(dirname(finalPath), { recursive: true });
    try {
      renameSync(inflightPath, finalPath);
    } catch {
      // A replay after a successful rename reaches the already finalized
      // directory. Any other filesystem failure is surfaced to the actor and
      // remains contained by the diagnostics process boundary.
      statSync(finalPath);
    }
    removeEmptyRuntimeDirectory();
    for (const artifact of artifacts) {
      if (artifact.bodyPath === null) continue;
      const finalBodyPath = join(
        finalRelative,
        "artifacts",
        basename(artifact.bodyPath),
      );
      database
        .prepare(
          `UPDATE request_journey_artifacts SET body_path = ?
            WHERE request_id = ? AND artifact_id = ?`,
        )
        .run(finalBodyPath, requestId, artifact.artifactId);
    }
  };

  const evictArtifactBodies = (
    requestId: string,
    time: number,
  ): void => {
    const rows = database
      .prepare(
        `SELECT artifact_id AS artifactId, descriptor_json AS descriptorJson,
                body_path AS bodyPath
           FROM request_journey_artifacts
          WHERE request_id = ? AND body_path IS NOT NULL
          ORDER BY artifact_id`,
      )
      .all(requestId) as Array<{
      readonly artifactId: string;
      readonly descriptorJson: string;
      readonly bodyPath: string;
    }>;
    const journeyDirectories = new Set<string>();
    for (const row of rows) {
      const descriptor = JSON.parse(row.descriptorJson) as Record<string, unknown>;
      try {
        journeyDirectories.add(dirname(dirname(storagePath(row.bodyPath))));
      } catch {
        // Invalid stored paths are treated as unavailable, never followed.
      }
      database
        .prepare(
          `UPDATE request_journey_artifacts
              SET descriptor_json = ?, body_path = NULL
            WHERE request_id = ? AND artifact_id = ? AND body_path IS NOT NULL`,
        )
        .run(
          JSON.stringify({
            ...descriptor,
            state: "unavailable",
            reason: "expired",
          }),
          requestId,
          row.artifactId,
        );
      database
        .prepare(
          `INSERT INTO artifact_evictions
             (request_id, artifact_id, time, reason)
           VALUES (?, ?, ?, 'expired')`,
        )
        .run(requestId, row.artifactId, time);
    }
    for (const journeyDirectory of journeyDirectories) {
      try {
        rmSync(journeyDirectory, { recursive: true, force: true });
      } catch {
        // Retention cleanup failure cannot invalidate the index update or
        // escape the diagnostics process.
      }
    }
  };

  const enforceArtifactRetention = (time: number): void => {
    const ageExpired = database
      .prepare(
        `SELECT DISTINCT a.request_id AS requestId
           FROM request_journey_artifacts a
           JOIN request_journeys j ON j.request_id = a.request_id
          WHERE a.body_path IS NOT NULL AND j.accepted_at < ?
          ORDER BY j.accepted_at, j.record_id`,
      )
      .all(Math.max(0, time - artifactRetentionAgeMs)) as Array<{
      readonly requestId: string;
    }>;
    for (const row of ageExpired) evictArtifactBodies(row.requestId, time);

    const countExpired = database
      .prepare(
        `SELECT requestId FROM (
           SELECT DISTINCT a.request_id AS requestId,
                           j.accepted_at AS acceptedAt,
                           j.record_id AS recordId
             FROM request_journey_artifacts a
             JOIN request_journeys j ON j.request_id = a.request_id
            WHERE a.body_path IS NOT NULL
            ORDER BY acceptedAt DESC, recordId DESC
            LIMIT -1 OFFSET ?
         ) ORDER BY acceptedAt, recordId`,
      )
      .all(maxArtifactJourneys) as Array<{ readonly requestId: string }>;
    for (const row of countExpired) evictArtifactBodies(row.requestId, time);

    let retainedBytes = Number(
      (
        database
          .prepare(
            `SELECT COALESCE(SUM(
                      CAST(json_extract(descriptor_json, '$.capturedBytes') AS INTEGER)
                    ), 0) AS bytes
               FROM request_journey_artifacts
              WHERE body_path IS NOT NULL`,
          )
          .get() as { readonly bytes: number }
      ).bytes,
    );
    if (retainedBytes <= maxArtifactDiskBytes) return;
    const diskCandidates = database
      .prepare(
        `SELECT DISTINCT a.request_id AS requestId,
                         j.accepted_at AS acceptedAt,
                         j.record_id AS recordId
           FROM request_journey_artifacts a
           JOIN request_journeys j ON j.request_id = a.request_id
          WHERE a.body_path IS NOT NULL
          ORDER BY acceptedAt, recordId`,
      )
      .all() as Array<{ readonly requestId: string }>;
    for (const candidate of diskCandidates) {
      const bytes = Number(
        (
          database
            .prepare(
              `SELECT COALESCE(SUM(
                        CAST(json_extract(descriptor_json, '$.capturedBytes') AS INTEGER)
                      ), 0) AS bytes
                 FROM request_journey_artifacts
                WHERE request_id = ? AND body_path IS NOT NULL`,
            )
            .get(candidate.requestId) as { readonly bytes: number }
        ).bytes,
      );
      evictArtifactBodies(candidate.requestId, time);
      retainedBytes = Math.max(0, retainedBytes - bytes);
      if (retainedBytes <= maxArtifactDiskBytes) break;
    }
  };

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `UPDATE records
         SET closed_at = ?, completeness = 'degraded'
         WHERE runtime_id <> ? AND record_kind = 'request_journey' AND closed_at IS NULL`,
      )
      .run(Date.now(), data.runtimeId);
    database
      .prepare(
        `UPDATE request_journeys
         SET outcome = 'interrupted',
             analytics_outcome = CASE
               WHEN analytics_outcome = 'running' THEN 'interrupted'
               ELSE analytics_outcome
             END
         WHERE record_id IN (
           SELECT id FROM records
           WHERE runtime_id <> ? AND record_kind = 'request_journey'
         ) AND outcome = 'running'`,
      )
      .run(data.runtimeId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }

  const recoverableArtifacts = database
    .prepare(
      `SELECT DISTINCT a.request_id AS requestId, a.body_path AS bodyPath
         FROM request_journey_artifacts a
         JOIN request_journeys j ON j.request_id = a.request_id
         JOIN records r ON r.id = j.record_id
        WHERE a.body_path IS NOT NULL AND r.closed_at IS NOT NULL`,
    )
    .all() as Array<{
    readonly requestId: string;
    readonly bodyPath: string;
  }>;
  const inflightPrefix = `${join("full-journeys", ".inflight")}${sep}`;
  for (const requestId of new Set(
    recoverableArtifacts
      .filter((row) => row.bodyPath.startsWith(inflightPrefix))
      .map((row) => row.requestId),
  )) {
    finalizeJourneyFiles(requestId);
  }
  // Anything still under .inflight has no committed closed descriptor and
  // is therefore an orphan from an interrupted diagnostics generation.
  rmSync(inflightDirectory, { recursive: true, force: true });
  mkdirSync(inflightDirectory, { recursive: true });
  enforceArtifactRetention(Date.now());

  const projectSummary = (row: {
    readonly id: number;
    readonly runtimeId: string;
    readonly requestId: string;
    readonly operation: string;
    readonly protocol: string | null;
    readonly lane: string | null;
    readonly requestedModel: string | null;
    readonly providerId: string | null;
    readonly realModelId: string | null;
    readonly clientSessionId: string | null;
    readonly effectiveSessionId: string | null;
    readonly profileId: string | null;
    readonly profileDisplayName: string | null;
    readonly httpStatus: number | null;
    readonly outcome: string;
    readonly completeness: string;
    readonly createdAt: number;
    readonly closedAt: number | null;
    readonly admissionJson: string;
    readonly primaryFailureId: string | null;
    readonly primaryFailureJson: string | null;
    readonly executionStartedAt: number | null;
    readonly executionTerminalAt: number | null;
    readonly usageTerminalClass: string | null;
    readonly usageInput: number | null;
    readonly usageCacheRead: number | null;
    readonly usageOutput: number | null;
  }): Record<string, unknown> => {
    const primaryFailure =
      row.primaryFailureJson === null
        ? undefined
        : (JSON.parse(row.primaryFailureJson) as Record<string, unknown>);
    const primaryFailureLocation = primaryFailure?.location;
    let usage: Record<string, unknown> | undefined;
    if (
      row.usageTerminalClass !== null &&
      row.usageInput !== null &&
      row.usageCacheRead !== null &&
      row.usageOutput !== null
    ) {
      const inputTokens = Number(row.usageInput);
      const cacheReadTokens = Number(row.usageCacheRead);
      const outputTokens = Number(row.usageOutput);
      const cacheHitDenominator = inputTokens + cacheReadTokens;
      const executionDurationMs =
        row.executionStartedAt === null || row.executionTerminalAt === null
          ? undefined
          : Number(row.executionTerminalAt) - Number(row.executionStartedAt);
      usage = {
        terminalClass: row.usageTerminalClass,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        ...(cacheHitDenominator > 0
          ? { cacheHitRate: cacheReadTokens / cacheHitDenominator }
          : {}),
        ...(executionDurationMs !== undefined && executionDurationMs > 0
          ? { outputTokensPerSecond: (outputTokens / executionDurationMs) * 1_000 }
          : {}),
      };
    }
    return {
      id: Number(row.id),
      runtimeId: row.runtimeId,
      requestId: row.requestId,
      operation: row.operation,
      ...(row.protocol === null ? {} : { protocol: row.protocol }),
      ...(row.lane === null ? {} : { lane: row.lane }),
      ...(row.requestedModel === null
        ? {}
        : { requestedModel: row.requestedModel }),
      ...(row.providerId === null ? {} : { providerId: row.providerId }),
      ...(row.realModelId === null ? {} : { realModelId: row.realModelId }),
      ...(row.clientSessionId === null
        ? {}
        : { clientSessionId: row.clientSessionId }),
      ...(row.effectiveSessionId === null
        ? {}
        : { effectiveSessionId: row.effectiveSessionId }),
      ...(row.profileId === null ? {} : { profileId: row.profileId }),
      ...(row.profileDisplayName === null
        ? {}
        : { profileDisplayName: row.profileDisplayName }),
      ...(row.httpStatus === null
        ? {}
        : { httpStatus: Number(row.httpStatus) }),
      outcome: row.outcome,
      completeness: row.completeness,
      createdAt: Number(row.createdAt),
      ...(row.closedAt === null ? {} : { closedAt: Number(row.closedAt) }),
      ...(typeof primaryFailureLocation === "object" &&
      primaryFailureLocation !== null
        ? { primaryFailureLocation }
        : {}),
      ...(usage === undefined ? {} : { usage }),
    };
  };

  const summarySelect = `
    SELECT r.id AS id, r.runtime_id AS runtimeId,
           j.request_id AS requestId, j.operation AS operation,
           j.protocol AS protocol, j.lane AS lane, j.outcome AS outcome,
           j.provider_id AS providerId, j.real_model_id AS realModelId,
           j.client_session_id AS clientSessionId,
           j.effective_session_id AS effectiveSessionId,
           j.profile_id AS profileId,
           j.profile_display_name AS profileDisplayName,
           r.completeness AS completeness, r.created_at AS createdAt,
           r.closed_at AS closedAt, j.admission_json AS admissionJson,
           j.primary_failure_id AS primaryFailureId,
           j.execution_started_at AS executionStartedAt,
           j.execution_terminal_at AS executionTerminalAt,
           j.usage_terminal_class AS usageTerminalClass,
           j.usage_input AS usageInput,
           j.usage_cache_read AS usageCacheRead,
           j.usage_output AS usageOutput,
           (SELECT json_extract(e.payload_json, '$.requestedModel')
              FROM request_journey_events e
             WHERE e.request_id = j.request_id
               AND e.kind = 'model_resolved'
             ORDER BY e.sequence DESC
             LIMIT 1) AS requestedModel,
           (SELECT json_extract(e.payload_json, '$.status')
              FROM request_journey_events e
             WHERE e.request_id = j.request_id
               AND e.kind = 'client_response_prepared'
             ORDER BY e.sequence DESC
             LIMIT 1) AS httpStatus,
           (SELECT e.payload_json
              FROM request_journey_events e
             WHERE e.request_id = j.request_id
               AND e.kind = 'failure_detected'
               AND json_extract(e.payload_json, '$.failureId') =
                   j.primary_failure_id
             ORDER BY e.sequence
             LIMIT 1) AS primaryFailureJson
    FROM records r
    JOIN request_journeys j ON j.record_id = r.id`;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const isSafeFact = (value: unknown, maximumLength = 1_024): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength;

  const isNonNegativeSafeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

  const parseHistoryRange = (
    value: unknown,
  ): Readonly<{ readonly fromMs?: number; readonly toMs?: number }> => {
    if (value === "all") return Object.freeze({});
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => key !== "fromMs" && key !== "toMs",
      ) ||
      (value.fromMs === undefined && value.toMs === undefined) ||
      (value.fromMs !== undefined &&
        !isNonNegativeSafeInteger(value.fromMs)) ||
      (value.toMs !== undefined && !isNonNegativeSafeInteger(value.toMs)) ||
      (typeof value.fromMs === "number" &&
        typeof value.toMs === "number" &&
        value.fromMs > value.toMs)
    ) {
      throw new Error("Diagnostics history range is invalid");
    }
    return Object.freeze({
      ...(value.fromMs === undefined ? {} : { fromMs: value.fromMs }),
      ...(value.toMs === undefined ? {} : { toMs: value.toMs }),
    });
  };

  const historyRangeSql = (
    range: Readonly<{ readonly fromMs?: number; readonly toMs?: number }>,
    column: string,
  ): Readonly<{ readonly sql: string; readonly parameters: readonly number[] }> => {
    const conditions: string[] = [];
    const parameters: number[] = [];
    if (range.fromMs !== undefined) {
      conditions.push(`${column} >= ?`);
      parameters.push(range.fromMs);
    }
    if (range.toMs !== undefined) {
      conditions.push(`${column} < ?`);
      parameters.push(range.toMs);
    }
    return Object.freeze({
      sql: conditions.length === 0 ? "1 = 1" : conditions.join(" AND "),
      parameters: Object.freeze(parameters),
    });
  };

  const projectTerminalUsage = (
    value: unknown,
  ):
    | Readonly<{
        terminalClass: string;
        input: number;
        cacheRead: number;
        output: number;
      }>
    | undefined => {
    if (!isRecord(value)) return undefined;
    const terminalClass = value.terminalClass;
    if (
      terminalClass !== "done" &&
      terminalClass !== "failed" &&
      terminalClass !== "aborted" &&
      terminalClass !== "unsupported"
    ) {
      return undefined;
    }
    const input = value.input;
    const cacheRead = value.cacheRead;
    const output = value.output;
    if (
      !isNonNegativeSafeInteger(input) ||
      !isNonNegativeSafeInteger(cacheRead) ||
      !isNonNegativeSafeInteger(output)
    ) {
      return undefined;
    }
    return {
      terminalClass,
      input,
      cacheRead,
      output,
    };
  };

  const validAppendIdentity = (message: {
    readonly runtimeId?: string;
    readonly requestId?: string;
    readonly recordId?: string;
    readonly sequence?: number;
    readonly time?: number;
    readonly messageKind?: string;
  }): boolean =>
    typeof message.runtimeId === "string" &&
    message.runtimeId.length > 0 &&
    (message.messageKind === "runtime_event"
      ? typeof message.recordId === "string" && message.recordId.length > 0
      : typeof message.requestId === "string" && message.requestId.length > 0) &&
    Number.isSafeInteger(message.sequence) &&
    message.sequence! >= 0 &&
    typeof message.time === "number" &&
    Number.isFinite(message.time);

  const invalidAppendClassification = (message: {
    readonly messageKind?: string;
    readonly payload?: Record<string, unknown>;
  }): string | undefined => {
    if (
      message.messageKind !== "begin" &&
      message.messageKind !== "observation" &&
      message.messageKind !== "close" &&
      message.messageKind !== "runtime_event"
    ) {
      return "invalid_append_message_kind";
    }
    if (!isRecord(message.payload)) return "invalid_append_payload";
    const payload = message.payload;
    if (message.messageKind === "runtime_event") {
      return (payload.level === "info" ||
          payload.level === "warning" ||
          payload.level === "error" ||
          payload.level === "critical") &&
        typeof payload.classification === "string" &&
        payload.classification.length > 0 &&
        typeof payload.safeMessage === "string" &&
        payload.safeMessage.length > 0
        ? undefined
        : "invalid_append_runtime_event";
    }
    try {
      if (JSON.stringify(payload) === undefined) {
        return "invalid_append_payload";
      }
    } catch {
      return "invalid_append_payload";
    }
    if (message.messageKind === "begin") {
      return typeof message.payload.operationCandidate === "string" &&
        typeof message.payload.transport === "string" &&
        typeof message.payload.method === "string" &&
        typeof message.payload.path === "string" &&
        Number.isSafeInteger(message.payload.acceptedAt) &&
        (message.payload.acceptedAt as number) >= 0
        ? undefined
        : "invalid_append_begin";
    }
    if (message.messageKind === "observation") {
      const location = message.payload.location;
      return typeof message.payload.kind === "string" &&
        isRecord(location) &&
        typeof location.phase === "string" &&
        typeof location.step === "string"
        ? undefined
        : "invalid_append_observation";
    }
    return typeof message.payload.outcome === "string"
      ? undefined
      : "invalid_append_close";
  };

  const exitAfterActorFailure = (error: unknown): void => {
    queueMicrotask(() => {
      throw error instanceof Error
        ? error
        : new Error("Diagnostics Worker append actor failed");
    });
  };

  interface AnalyticsProjectionRow {
    readonly recordId: number;
    readonly acceptedAt: number;
    readonly providerId: string | null;
    readonly realModelId: string | null;
    readonly clientSessionId: string | null;
    readonly profileId: string | null;
    readonly profileDisplayName: string | null;
    readonly protocol: string | null;
    readonly outcome: string;
    readonly executionStartedAt: number | null;
    readonly executionTerminalAt: number | null;
    readonly usageTerminalClass: string | null;
    readonly usageInput: number | null;
    readonly usageCacheRead: number | null;
    readonly usageOutput: number | null;
  }

  interface AnalyticsAccumulator {
    total: number;
    success: number;
    failed: number;
    aborted: number;
    other: number;
    pending: number;
    usageRequests: number;
    speedRequests: number;
    input: number;
    cacheRead: number;
    output: number;
    speedOutput: number;
    executionDurationMs: number;
  }

  const emptyAnalyticsAccumulator = (): AnalyticsAccumulator => ({
    total: 0,
    success: 0,
    failed: 0,
    aborted: 0,
    other: 0,
    pending: 0,
    usageRequests: 0,
    speedRequests: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    speedOutput: 0,
    executionDurationMs: 0,
  });

  const accumulateAnalytics = (
    accumulator: AnalyticsAccumulator,
    row: AnalyticsProjectionRow,
  ): void => {
    accumulator.total += 1;
    switch (row.outcome) {
      case "success":
        accumulator.success += 1;
        break;
      case "failed":
        accumulator.failed += 1;
        break;
      case "aborted":
        accumulator.aborted += 1;
        break;
      case "running":
        accumulator.pending += 1;
        break;
      default:
        accumulator.other += 1;
        break;
    }
    if (
      row.usageTerminalClass === null ||
      row.usageInput === null ||
      row.usageCacheRead === null ||
      row.usageOutput === null
    ) {
      return;
    }
    const input = row.usageInput;
    const cacheRead = row.usageCacheRead;
    const output = row.usageOutput;
    accumulator.usageRequests += 1;
    accumulator.input += input;
    accumulator.cacheRead += cacheRead;
    accumulator.output += output;
    if (
      row.executionStartedAt !== null &&
      row.executionTerminalAt !== null
    ) {
      const duration = row.executionTerminalAt - row.executionStartedAt;
      if (duration > 0) {
        accumulator.speedRequests += 1;
        accumulator.speedOutput += output;
        accumulator.executionDurationMs += duration;
      }
    }
  };

  const analyticsSummary = (
    accumulator: AnalyticsAccumulator,
  ): Record<string, unknown> => {
    const total = accumulator.total;
    const denominator = accumulator.input + accumulator.cacheRead;
    return {
      total,
      success: accumulator.success,
      failed: accumulator.failed,
      aborted: accumulator.aborted,
      other: accumulator.other,
      pending: accumulator.pending,
      successRate: total === 0 ? 0 : accumulator.success / total,
      failureRate: total === 0 ? 0 : accumulator.failed / total,
      abortRate: total === 0 ? 0 : accumulator.aborted / total,
      usageRequests: accumulator.usageRequests,
      missingUsageRequests: total - accumulator.usageRequests,
      speedRequests: accumulator.speedRequests,
      inputTokens: accumulator.input,
      cacheReadTokens: accumulator.cacheRead,
      outputTokens: accumulator.output,
      ...(accumulator.executionDurationMs > 0
        ? {
            outputTokensPerSecond:
              (accumulator.speedOutput / accumulator.executionDurationMs) *
              1_000,
          }
        : {}),
      ...(denominator > 0
        ? { cacheHitRate: accumulator.cacheRead / denominator }
        : {}),
    };
  };

  const visitAnalyticsRows = (
    from: number | undefined,
    to: number | undefined,
    visit: (row: AnalyticsProjectionRow) => void,
  ): void => {
    let afterRecordId = 0;
    const statement = database.prepare(
      `SELECT record_id AS recordId, accepted_at AS acceptedAt,
              provider_id AS providerId, real_model_id AS realModelId,
              client_session_id AS clientSessionId,
              profile_id AS profileId,
              profile_display_name AS profileDisplayName,
              protocol, analytics_outcome AS outcome,
              execution_started_at AS executionStartedAt,
              execution_terminal_at AS executionTerminalAt,
              usage_terminal_class AS usageTerminalClass,
              usage_input AS usageInput,
              usage_cache_read AS usageCacheRead,
              usage_output AS usageOutput
         FROM request_journeys
        WHERE (? IS NULL OR accepted_at >= ?)
          AND (? IS NULL OR accepted_at < ?)
          AND operation NOT IN ('unsupported_transport', 'token_counting')
          AND record_id > ?
        ORDER BY record_id
        LIMIT ?`,
    );
    for (;;) {
      const page = statement.all(
        from ?? null,
        from ?? null,
        to ?? null,
        to ?? null,
        afterRecordId,
        analyticsPageSize,
      ) as unknown as AnalyticsProjectionRow[];
      for (const row of page) visit(row);
      if (page.length < analyticsPageSize) return;
      afterRecordId = Number(page[page.length - 1]!.recordId);
    }
  };

  const validAnalyticsBound = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

  const validAnalyticsValues = (value: unknown): value is readonly string[] =>
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((entry) => isSafeFact(entry));

  const validateAnalyticsFilters = (
    value: unknown,
  ): Record<string, readonly string[]> | undefined => {
    if (value === undefined) return {};
    if (!isRecord(value)) return undefined;
    const allowed = new Set([
      "providers",
      "profiles",
      "models",
      "protocols",
      "sessions",
      "outcomes",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
    const result: Record<string, readonly string[]> = {};
    for (const key of allowed) {
      const candidate = value[key];
      if (candidate === undefined) continue;
      if (!validAnalyticsValues(candidate)) return undefined;
      result[key] = candidate;
    }
    return result;
  };

  const analyticsRowMatches = (
    row: AnalyticsProjectionRow,
    filters: Readonly<Record<string, readonly string[]>>,
  ): boolean => {
    const matches = (key: string, value: string | null): boolean =>
      filters[key] === undefined ||
      (value !== null && filters[key]!.includes(value));
    return (
      matches("providers", row.providerId) &&
      matches("profiles", row.profileId) &&
      matches("models", row.realModelId) &&
      matches("protocols", row.protocol) &&
      matches("sessions", row.clientSessionId) &&
      matches("outcomes", row.outcome)
    );
  };

  const analyticsDimension = (
    row: AnalyticsProjectionRow,
    dimension: string,
  ): string | null => {
    switch (dimension) {
      case "provider":
        return row.providerId;
      case "model":
        return row.realModelId;
      case "protocol":
        return row.protocol;
      case "outcome":
        return row.outcome;
      default:
        return null;
    }
  };

  const sortStrings = (values: ReadonlySet<string>): string[] =>
    [...values].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

  const runAnalyticsQuery = (
    query: Record<string, unknown> | undefined,
  ): Record<string, unknown> => {
    if (query?.version !== 3) throw new Error("Analytics query is invalid");
    if (query.command === "options") {
      if (
        (query.from !== undefined && !validAnalyticsBound(query.from)) ||
        (query.to !== undefined && !validAnalyticsBound(query.to)) ||
        (query.from !== undefined &&
          query.to !== undefined &&
          query.from >= query.to)
      ) {
        throw new Error("Analytics options range is invalid");
      }
      const providers = new Set<string>();
      const models = new Set<string>();
      const protocols = new Set<string>();
      const sessions = new Set<string>();
      const outcomes = new Set<string>();
      const profiles = new Map<
        string,
        Readonly<{
          acceptedAt: number;
          recordId: number;
          profileId: string;
          displayName: string;
          providerId: string;
        }>
      >();
      visitAnalyticsRows(
        query.from as number | undefined,
        query.to as number | undefined,
        (row) => {
          if (row.providerId !== null) providers.add(row.providerId);
          if (row.realModelId !== null) models.add(row.realModelId);
          if (row.protocol !== null) protocols.add(row.protocol);
          if (row.clientSessionId !== null) sessions.add(row.clientSessionId);
          outcomes.add(row.outcome);
          if (
            row.profileId !== null &&
            row.profileDisplayName !== null &&
            row.providerId !== null
          ) {
            const previous = profiles.get(row.profileId);
            if (
              previous === undefined ||
              row.acceptedAt > previous.acceptedAt ||
              (row.acceptedAt === previous.acceptedAt &&
                row.recordId > previous.recordId)
            ) {
              profiles.set(row.profileId, {
                acceptedAt: row.acceptedAt,
                recordId: row.recordId,
                profileId: row.profileId,
                displayName: row.profileDisplayName,
                providerId: row.providerId,
              });
            }
          }
        },
      );
      const profileOptions = [...profiles.values()].sort((left, right) => {
        if (left.displayName !== right.displayName) {
          return left.displayName < right.displayName ? -1 : 1;
        }
        return left.profileId < right.profileId
          ? -1
          : left.profileId > right.profileId
            ? 1
            : 0;
      });
      const cap = 64;
      const truncated =
        providers.size > cap ||
        profiles.size > cap ||
        models.size > cap ||
        protocols.size > cap ||
        sessions.size > cap ||
        outcomes.size > cap;
      return {
        version: 3,
        command: "options",
        providers: sortStrings(providers).slice(0, cap),
        profiles: profileOptions.slice(0, cap).map((profile) => ({
          profileId: profile.profileId,
          displayName: profile.displayName,
          providerId: profile.providerId,
        })),
        models: sortStrings(models).slice(0, cap),
        protocols: sortStrings(protocols).slice(0, cap),
        sessions: sortStrings(sessions).slice(0, cap),
        outcomes: sortStrings(outcomes).slice(0, cap),
        ...(truncated ? { truncated: true } : {}),
      };
    }
    if (
      query.command !== "summary" ||
      !validAnalyticsBound(query.from) ||
      !validAnalyticsBound(query.to) ||
      query.from >= query.to
    ) {
      throw new Error("Analytics summary range is invalid");
    }
    const rangeFrom = query.from;
    const rangeTo = query.to;
    const filters = validateAnalyticsFilters(query.filters);
    if (filters === undefined) throw new Error("Analytics filters are invalid");
    const groupBy = query.groupBy;
    if (
      groupBy !== undefined &&
      groupBy !== "provider" &&
      groupBy !== "model" &&
      groupBy !== "protocol" &&
      groupBy !== "outcome"
    ) {
      throw new Error("Analytics group is invalid");
    }
    let seriesGranularity: "hour" | "day" | undefined;
    if (query.series !== undefined) {
      if (
        !isRecord(query.series) ||
        (query.series.granularity !== "hour" &&
          query.series.granularity !== "day")
      ) {
        throw new Error("Analytics series is invalid");
      }
      seriesGranularity = query.series.granularity;
      const maximumSpan =
        seriesGranularity === "hour"
          ? 31 * 86_400_000
          : 366 * 86_400_000;
      if (rangeTo - rangeFrom > maximumSpan) {
        throw new Error("Analytics series range is too large");
      }
    }
    const totals = emptyAnalyticsAccumulator();
    const groups = new Map<string | null, AnalyticsAccumulator>();
    const omittedGroups = new Map<string, number>();
    const bucketMs =
      seriesGranularity === undefined
        ? undefined
        : seriesGranularity === "hour"
          ? 3_600_000
          : 86_400_000;
    const buckets =
      bucketMs === undefined
        ? undefined
        : Array.from(
            { length: Math.ceil((rangeTo - rangeFrom) / bucketMs) },
            emptyAnalyticsAccumulator,
          );
    visitAnalyticsRows(rangeFrom, rangeTo, (row) => {
      if (!analyticsRowMatches(row, filters)) return;
      accumulateAnalytics(totals, row);
      if (bucketMs !== undefined && buckets !== undefined) {
        const index = Math.floor((row.acceptedAt - rangeFrom) / bucketMs);
        const bucket = buckets[index];
        if (bucket !== undefined) accumulateAnalytics(bucket, row);
      }
      if (typeof groupBy === "string") {
        const value = analyticsDimension(row, groupBy);
        let accumulator = groups.get(value);
        if (accumulator === undefined) {
          if (groups.size >= 200) {
            const key = value ?? "";
            omittedGroups.set(key, (omittedGroups.get(key) ?? 0) + 1);
            return;
          }
          accumulator = emptyAnalyticsAccumulator();
          groups.set(value, accumulator);
        }
        accumulateAnalytics(accumulator, row);
      }
    });
    const result: Record<string, unknown> = {
      version: 3,
      command: "summary",
      totals: analyticsSummary(totals),
    };
    if (typeof groupBy === "string") {
      result.rows = [...groups.entries()]
        .map(([value, accumulator]) => ({
          dimension: groupBy,
          value,
          summary: analyticsSummary(accumulator),
        }))
        .sort((left, right) => {
          const leftTotal = (left.summary.total as number) ?? 0;
          const rightTotal = (right.summary.total as number) ?? 0;
          if (leftTotal !== rightTotal) return rightTotal - leftTotal;
          if (left.value === null) return 1;
          if (right.value === null) return -1;
          return left.value < right.value
            ? -1
            : left.value > right.value
              ? 1
              : 0;
        });
      if (omittedGroups.size > 0) {
        result.truncated = true;
        result.omittedGroupCount = omittedGroups.size;
        result.omittedGroupRequests = [...omittedGroups.values()].reduce(
          (sum, count) => sum + count,
          0,
        );
      }
    }
    if (bucketMs !== undefined && buckets !== undefined) {
      result.buckets = buckets.map((bucket, index) => {
        const start = rangeFrom + index * bucketMs;
        return {
          start,
          end: Math.min(start + bucketMs, rangeTo),
          summary: analyticsSummary(bucket),
        };
      });
    }
    return result;
  };

  const handleMessage = async (raw: unknown): Promise<void> => {
    const message = raw as {
      readonly type: string;
      readonly commandId?: number;
      readonly runtimeId?: string;
      readonly requestId?: string;
      readonly recordId?: string;
      readonly artifactId?: string;
      readonly chunkIndex?: number;
      readonly offset?: number;
      readonly bytes?: Uint8Array;
      readonly descriptor?: Record<string, unknown>;
      readonly originalBytes?: number;
      readonly complete?: boolean;
      readonly reason?: string;
      readonly limit?: number;
      readonly sequence?: number;
      readonly time?: number;
      readonly messageKind?: string;
      readonly payload?: Record<string, unknown>;
      readonly query?: Record<string, unknown>;
      readonly range?: unknown;
    };
    try {
      if (message.type === "artifact_begin") {
        const descriptorBytes = (() => {
          try {
            return Buffer.byteLength(JSON.stringify(message.descriptor), "utf8");
          } catch {
            return Number.POSITIVE_INFINITY;
          }
        })();
        const valid =
          typeof message.runtimeId === "string" &&
          message.runtimeId.length > 0 &&
          typeof message.requestId === "string" &&
          message.requestId.length > 0 &&
          typeof message.artifactId === "string" &&
          message.artifactId.length > 0 &&
          message.chunkIndex === -1 &&
          typeof message.descriptor === "object" &&
          message.descriptor !== null &&
          descriptorBytes <= 64 * 1_024;
        const key = valid
          ? artifactKey(
              message.runtimeId!,
              message.requestId!,
              message.artifactId!,
            )
          : undefined;
        if (!valid || key === undefined || activeArtifacts.has(key)) {
          port.postMessage({
            type: "nack",
            runtimeId: message.runtimeId,
            requestId: message.requestId,
            artifactId: message.artifactId,
            chunkIndex: -1,
            classification: "invalid_artifact_begin",
          });
          return;
        }
        activeArtifacts.set(key, {
          descriptor: Object.freeze({ ...message.descriptor! }),
          chunks: [],
          receivedBytes: 0,
          nextChunkIndex: 0,
        });
        port.postMessage({
          type: "ack",
          runtimeId: message.runtimeId,
          requestId: message.requestId,
          artifactId: message.artifactId,
          chunkIndex: -1,
        });
        return;
      }
      if (message.type === "artifact_chunk") {
        const valid =
          typeof message.runtimeId === "string" &&
          message.runtimeId.length > 0 &&
          typeof message.requestId === "string" &&
          message.requestId.length > 0 &&
          typeof message.artifactId === "string" &&
          message.artifactId.length > 0 &&
          Number.isSafeInteger(message.chunkIndex) &&
          message.chunkIndex! >= 0 &&
          Number.isSafeInteger(message.offset) &&
          message.offset! >= 0 &&
          message.bytes instanceof Uint8Array &&
          message.bytes.byteLength > 0 &&
          message.bytes.byteLength <= 64 * 1_024;
        if (!valid) {
          port.postMessage({
            type: "nack",
            runtimeId: message.runtimeId,
            requestId: message.requestId,
            artifactId: message.artifactId,
            chunkIndex: message.chunkIndex,
            classification: "invalid_artifact_chunk",
          });
          return;
        }
        const key = artifactKey(
          message.runtimeId!,
          message.requestId!,
          message.artifactId!,
        );
        const active = activeArtifacts.get(key);
        if (
          active === undefined ||
          message.chunkIndex !== active.nextChunkIndex ||
          message.offset !== active.receivedBytes ||
          active.receivedBytes + message.bytes!.byteLength >
            maxJsonArtifactBytes ||
          activeArtifactBytes + message.bytes!.byteLength >
            maxActiveArtifactBytes
        ) {
          discardActiveArtifact(key);
          port.postMessage({
            type: "nack",
            runtimeId: message.runtimeId,
            requestId: message.requestId,
            artifactId: message.artifactId,
            chunkIndex: message.chunkIndex,
            classification: "artifact_chunk_capacity_or_order_rejected",
          });
          return;
        }
        try {
          const owned = new Uint8Array(message.bytes!.byteLength);
          owned.set(message.bytes!);
          active.chunks.push(owned);
          active.receivedBytes += owned.byteLength;
          active.nextChunkIndex += 1;
          activeArtifactBytes += owned.byteLength;
          port.postMessage({
            type: "ack",
            runtimeId: message.runtimeId,
            requestId: message.requestId,
            artifactId: message.artifactId,
            chunkIndex: message.chunkIndex,
          });
        } catch {
          port.postMessage({
            type: "nack",
            runtimeId: message.runtimeId,
            requestId: message.requestId,
            artifactId: message.artifactId,
            chunkIndex: message.chunkIndex,
            classification: "artifact_chunk_capture_failed",
          });
        }
        return;
      }
      if (message.type === "artifact_finish") {
        const valid =
          typeof message.runtimeId === "string" &&
          message.runtimeId.length > 0 &&
          typeof message.requestId === "string" &&
          message.requestId.length > 0 &&
          typeof message.artifactId === "string" &&
          message.artifactId.length > 0 &&
          message.chunkIndex === -2 &&
          Number.isSafeInteger(message.originalBytes) &&
          message.originalBytes! >= 0 &&
          typeof message.complete === "boolean";
        const key = valid
          ? artifactKey(
              message.runtimeId!,
              message.requestId!,
              message.artifactId!,
            )
          : undefined;
        const active = key === undefined ? undefined : activeArtifacts.get(key);
        if (!valid || key === undefined || active === undefined) {
          port.postMessage({
            type: "nack",
            runtimeId: message.runtimeId,
            requestId: message.requestId,
            artifactId: message.artifactId,
            chunkIndex: -2,
            classification: "artifact_finish_without_active_capture",
          });
          return;
        }
        try {
          let completed: Readonly<Record<string, unknown>>;
          if (
            !message.complete ||
            active.receivedBytes !== message.originalBytes
          ) {
            completed = Object.freeze({
              ...active.descriptor,
              state: "unavailable",
              originalBytes: message.originalBytes,
              capturedBytes: 0,
              redaction: "failed",
              truncated: true,
              reason: message.reason ?? "artifact_capture_incomplete",
            });
          } else {
            const raw = Buffer.concat(
              active.chunks.map((chunk) => Buffer.from(chunk)),
              active.receivedBytes,
            );
            const result = redactRequestArtifact({
              artifactKind: String(active.descriptor.artifactKind),
              ...(typeof active.descriptor.mediaType === "string"
                ? { mediaType: active.descriptor.mediaType }
                : {}),
              bytes: raw,
              originalBytes: message.originalBytes,
              sourceTruncated: false,
            });
            if (result.kind === "unavailable") {
              completed = Object.freeze({
                ...active.descriptor,
                state: "unavailable",
                originalBytes: message.originalBytes,
                capturedBytes: 0,
                redaction: result.redaction,
                truncated: false,
                reason: result.reason,
              });
            } else {
              writeSanitizedArtifact(
                message.runtimeId!,
                message.requestId!,
                message.artifactId!,
                result.bytes,
              );
              completed = Object.freeze({
                ...active.descriptor,
                state: "captured",
                originalBytes: message.originalBytes,
                capturedBytes: result.bytes.byteLength,
                redaction: result.redaction,
                truncated: false,
              });
            }
          }
          completedArtifacts.set(key, completed);
          discardActiveArtifact(key);
          port.postMessage({
            type: "ack",
            runtimeId: message.runtimeId,
            requestId: message.requestId,
            artifactId: message.artifactId,
            chunkIndex: -2,
          });
        } catch {
          discardActiveArtifact(key);
          port.postMessage({
            type: "nack",
            runtimeId: message.runtimeId,
            requestId: message.requestId,
            artifactId: message.artifactId,
            chunkIndex: -2,
            classification: "artifact_redaction_failed",
          });
        }
        return;
      }
      if (message.type === "append") {
        if (!validAppendIdentity(message)) {
          exitAfterActorFailure(new Error("Diagnostics Worker append identity is invalid"));
          return;
        }
        const classification = invalidAppendClassification(message);
        if (classification !== undefined) {
          port.postMessage({
            type: "nack",
            runtimeId: message.runtimeId,
            ...(message.recordId === undefined
              ? { requestId: message.requestId }
              : { recordId: message.recordId }),
            sequence: message.sequence,
            classification,
          });
          return;
        }
        const runtimeId = message.runtimeId!;
        const requestId = message.requestId;
        const recordId = message.recordId;
        const sequence = message.sequence!;
        const time = message.time!;
        let payload = message.payload!;
        if (
          message.messageKind === "observation" &&
          requestId !== undefined &&
          payload.kind === "artifact_observed" &&
          typeof payload.artifactId === "string"
        ) {
          const key = artifactKey(runtimeId, requestId, payload.artifactId);
          if (
            payload.state === "unavailable" ||
            payload.state === "not_applicable"
          ) {
            discardActiveArtifact(key);
            completedArtifacts.delete(key);
          } else {
            const completed = completedArtifacts.get(key);
            if (completed === undefined) discardActiveArtifact(key);
            payload = completed === undefined
              ? {
                  ...payload,
                  state: "unavailable",
                  capturedBytes: 0,
                  redaction: "failed",
                  reason: "artifact_capture_incomplete",
                }
              : {
                  ...payload,
                  ...completed,
                  location: payload.location,
                };
            completedArtifacts.delete(key);
          }
        }
        let publication: Record<string, unknown> | undefined;
        try {
          database.exec("BEGIN IMMEDIATE");
          if (message.messageKind === "runtime_event") {
            if (recordId === undefined) {
              throw new Error("runtime event record identity is missing");
            }
            database
              .prepare(
                `INSERT OR IGNORE INTO records
                   (record_kind, runtime_id, record_id, created_at, closed_at,
                    completeness)
                 VALUES ('runtime_event', ?, ?, ?, ?, 'complete')`,
              )
              .run(runtimeId, recordId, time, time);
            database
              .prepare(
                `INSERT OR IGNORE INTO runtime_events
                   (runtime_id, record_id, sequence, time, payload_json)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(
                runtimeId,
                recordId,
                sequence,
                time,
                JSON.stringify(payload),
              );
          } else if (message.messageKind === "begin") {
            if (requestId === undefined) {
              throw new Error("request journey identity is missing");
            }
            const journeyRecordId = `request_journey:${requestId}`;
            database
              .prepare(
                `INSERT OR IGNORE INTO records
                   (record_kind, runtime_id, record_id, created_at, completeness)
                 VALUES ('request_journey', ?, ?, ?, 'complete')`,
              )
              .run(runtimeId, journeyRecordId, time);
            const record = database
              .prepare(
                "SELECT id FROM records WHERE record_kind = 'request_journey' AND record_id = ?",
              )
              .get(journeyRecordId) as { readonly id: number } | undefined;
            if (record === undefined) throw new Error("request record was not created");
            database
              .prepare(
                `INSERT OR IGNORE INTO request_journeys
                   (record_id, request_id, operation, outcome, admission_json,
                    transport, method, path, accepted_at, analytics_outcome)
                 VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, 'running')`,
              )
              .run(
                record.id,
                requestId,
                String(payload.operationCandidate),
                JSON.stringify({
                  operationCandidate: payload.operationCandidate,
                  transport: payload.transport,
                  method: payload.method,
                  path: payload.path,
                  acceptedAt: payload.acceptedAt,
                  cancellation: payload.cancellation,
                }),
                String(payload.transport),
                String(payload.method),
                String(payload.path),
                Number(payload.acceptedAt),
              );
          } else if (message.messageKind === "observation") {
            if (requestId === undefined) {
              throw new Error("request journey identity is missing");
            }
            const location = payload.location as Record<string, unknown>;
            const kind = String(payload.kind);
            const laneValue =
              kind === "lane_committed" ? payload.lane : location.lane;
            const eventInsert = database
              .prepare(
                `INSERT OR IGNORE INTO request_journey_events
                   (runtime_id, request_id, sequence, time, kind, phase, lane,
                    direction, step, subject, source_path, attempt, payload_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                runtimeId,
                requestId,
                sequence,
                time,
                kind,
                String(location.phase),
                laneValue === undefined ? null : String(laneValue),
                location.direction === undefined
                  ? null
                  : String(location.direction),
                String(location.step),
                location.subject === undefined ? null : String(location.subject),
                location.sourcePath === undefined
                  ? null
                  : String(location.sourcePath),
                typeof location.attempt === "number" ? location.attempt : null,
                JSON.stringify(payload),
              );
            const eventWasInserted = Number(eventInsert.changes) === 1;
            if (eventWasInserted && kind === "artifact_observed") {
              const descriptor = {
                artifactId: String(payload.artifactId),
                artifactKind: String(payload.artifactKind),
                state: String(payload.state),
                ...(typeof payload.mediaType === "string"
                  ? { mediaType: payload.mediaType }
                  : {}),
                ...(typeof payload.originalBytes === "number"
                  ? { originalBytes: payload.originalBytes }
                  : {}),
                ...(typeof payload.capturedBytes === "number"
                  ? { capturedBytes: payload.capturedBytes }
                  : {}),
                redaction:
                  typeof payload.redaction === "string"
                    ? payload.redaction
                    : "not_required",
                truncated: payload.truncated === true,
                ...(typeof payload.integrityHash === "string"
                  ? { integrityHash: payload.integrityHash }
                  : {}),
                ...(typeof payload.reason === "string"
                  ? { reason: payload.reason }
                  : {}),
            };
              const bodyPath = completeArtifactBody(
                runtimeId,
                requestId,
                descriptor.artifactId,
                descriptor,
              );
              database
                .prepare(
                  `INSERT INTO request_journey_artifacts
                     (request_id, artifact_id, descriptor_json, body_path)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(request_id, artifact_id) DO UPDATE SET
                     descriptor_json = excluded.descriptor_json,
                     body_path = excluded.body_path`,
                )
                .run(
                  requestId,
                  descriptor.artifactId,
                  JSON.stringify(descriptor),
                  bodyPath,
                );
            }
            if (eventWasInserted && kind === "lane_committed") {
              database
                .prepare(
                  "UPDATE request_journeys SET lane = COALESCE(lane, ?) WHERE request_id = ?",
                )
                .run(String(payload.lane), requestId);
            }
            if (
              eventWasInserted &&
              kind === "step_completed" &&
              typeof payload.protocol === "string"
            ) {
              database
                .prepare(
                  "UPDATE request_journeys SET protocol = COALESCE(protocol, ?) WHERE request_id = ?",
                )
                .run(payload.protocol, requestId);
            }
            if (
              eventWasInserted &&
              kind === "step_completed" &&
              typeof payload.operation === "string"
            ) {
              database
                .prepare(
                  "UPDATE request_journeys SET operation = ? WHERE request_id = ?",
                )
                .run(payload.operation, requestId);
            }
            if (
              eventWasInserted &&
              kind === "model_resolved" &&
              isSafeFact(payload.requestedModel) &&
              isSafeFact(payload.providerId, 256) &&
              isSafeFact(payload.modelId, 256)
            ) {
              database
                .prepare(
                  `UPDATE request_journeys
                   SET provider_id = COALESCE(provider_id, ?),
                       real_model_id = COALESCE(real_model_id, ?)
                   WHERE request_id = ?`,
                )
                .run(payload.providerId, payload.modelId, requestId);
            }
            if (
              eventWasInserted &&
              kind === "request_identity_established" &&
              isSafeFact(payload.effectiveSessionId) &&
              (payload.clientSessionId === undefined ||
                isSafeFact(payload.clientSessionId))
            ) {
              database
                .prepare(
                  `UPDATE request_journeys
                   SET effective_session_id = COALESCE(effective_session_id, ?),
                       client_session_id = COALESCE(client_session_id, ?)
                   WHERE request_id = ?`,
                )
                .run(
                  payload.effectiveSessionId,
                  payload.clientSessionId ?? null,
                  requestId,
                );
            }
            if (
              eventWasInserted &&
              kind === "profile_attributed" &&
              isSafeFact(payload.profileId, 256) &&
              isSafeFact(payload.displayName, 512)
            ) {
              database
                .prepare(
                  `UPDATE request_journeys
                   SET profile_id = ?, profile_display_name = ?
                   WHERE request_id = ?`,
                )
                .run(payload.profileId, payload.displayName, requestId);
            }
            if (
              eventWasInserted &&
              kind === "step_entered" &&
              location.phase === "upstream_execution"
            ) {
              database
                .prepare(
                  `UPDATE request_journeys
                   SET execution_started_at = COALESCE(execution_started_at, ?)
                   WHERE request_id = ?`,
                )
                .run(time, requestId);
            }
            if (eventWasInserted && kind === "terminal_usage_observed") {
              const usage = projectTerminalUsage(payload.usage);
              if (usage !== undefined) {
                database
                  .prepare(
                    `UPDATE request_journeys
                     SET usage_terminal_class = ?, usage_input = ?,
                         usage_cache_read = ?, usage_output = ?
                     WHERE request_id = ? AND usage_terminal_class IS NULL`,
                  )
                  .run(
                    usage.terminalClass,
                    usage.input,
                    usage.cacheRead,
                    usage.output,
                    requestId,
                  );
              }
            }
            if (eventWasInserted && kind === "work_outcome_committed") {
              const analyticsOutcome =
                payload.requestOutcome ?? payload.outcome;
              if (
                analyticsOutcome === "success" ||
                analyticsOutcome === "failed" ||
                analyticsOutcome === "aborted" ||
                analyticsOutcome === "rejected-auth" ||
                analyticsOutcome === "unknown-alias" ||
                analyticsOutcome === "unavailable-alias"
              ) {
                database
                  .prepare(
                    `UPDATE request_journeys
                     SET analytics_outcome = ?, execution_terminal_at = ?
                     WHERE request_id = ? AND analytics_outcome = 'running'`,
                  )
                  .run(analyticsOutcome, time, requestId);
              }
            }
          } else if (message.messageKind === "close") {
            if (requestId === undefined) {
              throw new Error("request journey identity is missing");
            }
            database
              .prepare(
                `UPDATE records
                 SET closed_at = ?, completeness = ?
                 WHERE record_kind = 'request_journey'
                   AND record_id = ? AND closed_at IS NULL`,
              )
              .run(
                time,
                payload.completeness === "degraded" ? "degraded" : "complete",
                `request_journey:${requestId}`,
              );
            database
              .prepare(
                `UPDATE request_journeys
                 SET outcome = ?, primary_failure_id = ?,
                     analytics_outcome = CASE
                       WHEN analytics_outcome = 'running' THEN ?
                       ELSE analytics_outcome
                     END
                 WHERE request_id = ? AND outcome = 'running'`,
              )
              .run(
                String(payload.outcome),
                typeof payload.primaryFailureId === "string"
                  ? payload.primaryFailureId
                  : null,
                String(payload.outcome),
                requestId,
              );
          }
          database.exec("COMMIT");
          if (message.messageKind === "close" && requestId !== undefined) {
            // Filesystem publication is deliberately outside the SQLite
            // transaction. A crash at either side is recovered from the
            // closed index row and .inflight path on the next process start.
            finalizeJourneyFiles(requestId);
            enforceArtifactRetention(time);
          }
          if (message.messageKind === "runtime_event") {
            if (recordId === undefined) {
              throw new Error("runtime event record identity is missing");
            }
            const record = database
              .prepare(
                `SELECT id
                   FROM records
                  WHERE record_kind = 'runtime_event' AND record_id = ?`,
              )
              .get(recordId) as { readonly id: number } | undefined;
            if (record === undefined) {
              throw new Error("runtime event record was not created");
            }
            publication = {
              kind: "runtime_event",
              record: {
                kind: "runtime_event",
                id: Number(record.id),
                runtimeId,
                recordId,
                sequence,
                time,
                level: payload.level,
                classification: payload.classification,
                safeMessage: payload.safeMessage,
              },
            };
          } else if (message.messageKind === "close") {
            if (requestId === undefined) {
              throw new Error("request journey identity is missing");
            }
            const row = database
              .prepare(`${summarySelect} WHERE j.request_id = ?`)
              .get(requestId) as
              | Parameters<typeof projectSummary>[0]
              | undefined;
            if (row === undefined) {
              throw new Error("request journey summary was not created");
            }
            publication = {
              kind: "request_journey",
              record: projectSummary(row),
            };
          }
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // The Worker is exiting; the main-thread pending entry remains
            // authoritative for replay by the next Worker generation.
          }
          exitAfterActorFailure(error);
          return;
        }
        port.postMessage({
          type: "ack",
          runtimeId,
          ...(recordId === undefined ? { requestId } : { recordId }),
          sequence,
          ...(publication === undefined ? {} : { publication }),
        });
        return;
      }

      if (message.type === "query") {
        const afterId = Math.max(
          0,
          typeof message.query?.afterId === "number"
            ? message.query.afterId
            : 0,
        );
        const limit = Math.min(
          1_000,
          Math.max(
            1,
            typeof message.query?.limit === "number"
              ? message.query.limit
              : 100,
          ),
        );
        const from =
          typeof message.query?.from === "number" ? message.query.from : undefined;
        const to =
          typeof message.query?.to === "number" ? message.query.to : undefined;
        const excludeOperations = Array.isArray(message.query?.excludeOperations)
          ? message.query.excludeOperations.filter(
              (operation): operation is string => typeof operation === "string",
            )
          : [];
        const clauses = ["r.id > ?"];
        const parameters: Array<number | string> = [afterId];
        if (from !== undefined) {
          clauses.push("j.accepted_at >= ?");
          parameters.push(from);
        }
        if (to !== undefined) {
          clauses.push("j.accepted_at < ?");
          parameters.push(to);
        }
        if (excludeOperations.length > 0) {
          clauses.push(
            `j.operation NOT IN (${excludeOperations.map(() => "?").join(", ")})`,
          );
          parameters.push(...excludeOperations);
        }
        const rows = database
          .prepare(
            `${summarySelect} WHERE ${clauses.join(" AND ")} ORDER BY r.id LIMIT ?`,
          )
          .all(...parameters, limit + 1) as Array<
            Parameters<typeof projectSummary>[0]
          >;
        port.postMessage({
          type: "result",
          commandId: message.commandId,
          value: {
            records: rows.slice(0, limit).map(projectSummary),
            hasMore: rows.length > limit,
          },
        });
        return;
      }

      if (message.type === "query_runtime_events") {
        const afterId = Math.max(
          0,
          typeof message.query?.afterId === "number"
            ? message.query.afterId
            : 0,
        );
        const limit = Math.min(
          1_000,
          Math.max(
            1,
            typeof message.query?.limit === "number"
              ? message.query.limit
              : 100,
          ),
        );
        const rows = database
          .prepare(
            `SELECT r.id AS id, r.runtime_id AS runtimeId,
                    e.record_id AS recordId, e.sequence AS sequence,
                    e.time AS time, e.payload_json AS payloadJson
               FROM records r
               JOIN runtime_events e
                 ON e.runtime_id = r.runtime_id
                AND e.record_id = r.record_id
              WHERE r.record_kind = 'runtime_event' AND r.id > ?
              ORDER BY r.id
              LIMIT ?`,
          )
          .all(afterId, limit + 1) as Array<{
            readonly id: number;
            readonly runtimeId: string;
            readonly recordId: string;
            readonly sequence: number;
            readonly time: number;
            readonly payloadJson: string;
          }>;
        port.postMessage({
          type: "result",
          commandId: message.commandId,
          value: {
            records: rows.slice(0, limit).map((row) => {
              const payload = JSON.parse(row.payloadJson) as Record<
                string,
                unknown
              >;
              return {
                kind: "runtime_event",
                id: Number(row.id),
                runtimeId: row.runtimeId,
                recordId: row.recordId,
                sequence: Number(row.sequence),
                time: Number(row.time),
                level: payload.level,
                classification: payload.classification,
                safeMessage: payload.safeMessage,
              };
            }),
            hasMore: rows.length > limit,
          },
        });
        return;
      }

      if (message.type === "get_analytics") {
        port.postMessage({
          type: "result",
          commandId: message.commandId,
          value: runAnalyticsQuery(message.query),
        });
        return;
      }

      if (message.type === "create_backup_snapshot") {
        const snapshotPath = join(
          data.directory,
          `.diagnostics.backup.${process.pid}.${randomBytes(8).toString("hex")}.sqlite3`,
        );
        const snapshot = await (async (): Promise<Uint8Array<ArrayBuffer>> => {
          try {
            await backup(database, snapshotPath);
            try {
              chmodSync(snapshotPath, 0o600);
            } catch {
              // Permission tightening is best effort on platforms that do not
              // expose POSIX file modes. The snapshot remains Worker-owned.
            }
            const bytes = readFileSync(snapshotPath);
            const ownedBuffer = new ArrayBuffer(bytes.byteLength);
            const ownedBytes = new Uint8Array(ownedBuffer);
            ownedBytes.set(bytes);
            return ownedBytes;
          } finally {
            try {
              rmSync(snapshotPath, { force: true });
            } catch {
              // Cleanup cannot mutate the live diagnostics database or the
              // already materialized snapshot bytes.
            }
          }
        })();
        port.postMessage(
          {
            type: "result",
            commandId: message.commandId,
            value: snapshot,
          },
          [snapshot.buffer],
        );
        return;
      }

      if (message.type === "count_history") {
        const range = parseHistoryRange(message.range);
        const journeyRange = historyRangeSql(range, "j.accepted_at");
        const runtimeRange = historyRangeSql(range, "e.time");
        const journeyCount = database
          .prepare(
            `SELECT COUNT(*) AS count
               FROM request_journeys j
              WHERE ${journeyRange.sql}
                AND EXISTS (
                  SELECT 1 FROM records r
                   WHERE r.id = j.record_id
                     AND r.record_kind = 'request_journey'
                     AND r.closed_at IS NOT NULL
                )`,
          )
          .get(...journeyRange.parameters) as { readonly count: number };
        const runtimeCount = database
          .prepare(
            `SELECT COUNT(*) AS count
               FROM records r
              WHERE r.record_kind = 'runtime_event'
                AND EXISTS (
                  SELECT 1 FROM runtime_events e
                   WHERE e.record_id = r.record_id
                     AND ${runtimeRange.sql}
                )`,
          )
          .get(...runtimeRange.parameters) as { readonly count: number };
        port.postMessage({
          type: "result",
          commandId: message.commandId,
          value: {
            requestJourneys: Number(journeyCount.count),
            runtimeEvents: Number(runtimeCount.count),
          },
        });
        return;
      }

      if (message.type === "delete_history") {
        const range = parseHistoryRange(message.range);
        const journeyRange = historyRangeSql(range, "j.accepted_at");
        const runtimeRange = historyRangeSql(range, "time");
        const artifactRows = database
          .prepare(
            `SELECT DISTINCT a.body_path AS bodyPath
               FROM request_journey_artifacts a
               JOIN request_journeys j ON j.request_id = a.request_id
               JOIN records r ON r.id = j.record_id
              WHERE a.body_path IS NOT NULL
                AND r.record_kind = 'request_journey'
                AND r.closed_at IS NOT NULL
                AND ${journeyRange.sql}`,
          )
          .all(...journeyRange.parameters) as Array<{
          readonly bodyPath: string;
        }>;
        const journeyDirectories = new Set<string>();
        for (const row of artifactRows) {
          try {
            journeyDirectories.add(dirname(dirname(storagePath(row.bodyPath))));
          } catch {
            // Never follow an invalid stored path outside diagnostics root.
          }
        }

        try {
          database.exec("BEGIN IMMEDIATE");
          for (const table of [
            "request_journey_events",
            "request_journey_artifacts",
            "artifact_evictions",
          ] as const) {
            database
              .prepare(
                `DELETE FROM ${table}
                  WHERE request_id IN (
                    SELECT j.request_id FROM request_journeys j
                     WHERE ${journeyRange.sql}
                       AND EXISTS (
                         SELECT 1 FROM records r
                          WHERE r.id = j.record_id
                            AND r.record_kind = 'request_journey'
                            AND r.closed_at IS NOT NULL
                       )
                  )`,
              )
              .run(...journeyRange.parameters);
          }
          const deletedJourneys = database
            .prepare(
              `DELETE FROM records
                WHERE record_kind = 'request_journey'
                  AND closed_at IS NOT NULL
                  AND id IN (
                    SELECT j.record_id FROM request_journeys j
                     WHERE ${journeyRange.sql}
                  )`,
            )
            .run(...journeyRange.parameters).changes;
          const deletedRuntimeEvents = database
            .prepare(
              `DELETE FROM records
                WHERE record_kind = 'runtime_event'
                  AND record_id IN (
                    SELECT record_id FROM runtime_events
                     WHERE ${runtimeRange.sql}
                  )`,
            )
            .run(...runtimeRange.parameters).changes;
          database.exec("COMMIT");
          for (const journeyDirectory of journeyDirectories) {
            try {
              rmSync(journeyDirectory, { recursive: true, force: true });
            } catch {
              // The index deletion is authoritative. A filesystem cleanup
              // failure remains inside diagnostics and is retried by orphan
              // cleanup on a later process start.
            }
          }
          port.postMessage({
            type: "result",
            commandId: message.commandId,
            value: {
              deleted: {
                requestJourneys: Number(deletedJourneys),
                runtimeEvents: Number(deletedRuntimeEvents),
              },
            },
          });
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // The outer command boundary reports the original failure. A
            // failed rollback is contained in this Worker command.
          }
          throw error;
        }
        return;
      }

      if (message.type === "get") {
        if (message.requestId === undefined) {
          throw new Error("Request Journey query requires a request id");
        }
        const row = database
          .prepare(`${summarySelect} WHERE j.request_id = ?`)
          .get(message.requestId) as Parameters<typeof projectSummary>[0] | undefined;
        if (row === undefined) {
          port.postMessage({
            type: "command_error",
            commandId: message.commandId,
            message: "Request Journey was not found",
          });
          return;
        }
        const events = database
          .prepare(
            `SELECT runtime_id AS runtimeId, request_id AS requestId,
                    sequence, time, payload_json AS payloadJson
             FROM request_journey_events
             WHERE request_id = ? ORDER BY sequence`,
          )
          .all(message.requestId) as Array<{
            readonly runtimeId: string;
            readonly requestId: string;
            readonly sequence: number;
            readonly time: number;
            readonly payloadJson: string;
          }>;
        const timeline = events.map((event) => ({
          runtimeId: event.runtimeId,
          requestId: event.requestId,
          sequence: Number(event.sequence),
          time: Number(event.time),
          observation: JSON.parse(event.payloadJson) as unknown,
        }));
        const observations = timeline.map((event) =>
          event.observation as Record<string, unknown>,
        );
        const failures = observations.filter(
          (observation) => observation.kind === "failure_detected",
        );
        const work = observations.findLast(
          (observation) => observation.kind === "work_outcome_committed",
        );
        const presentation = observations.findLast(
          (observation) => observation.kind === "client_response_prepared",
        );
        const handoff = observations.findLast(
          (observation) => observation.kind === "handoff_observed",
        );
        const artifacts = database
          .prepare(
            `SELECT descriptor_json AS descriptorJson
             FROM request_journey_artifacts
             WHERE request_id = ? ORDER BY artifact_id`,
          )
          .all(message.requestId) as Array<{ readonly descriptorJson: string }>;
        const admission = JSON.parse(row.admissionJson) as unknown;
        port.postMessage({
          type: "result",
          commandId: message.commandId,
          value: {
            ...projectSummary(row),
            admission,
            timeline,
            artifacts: artifacts.map((artifact) =>
              JSON.parse(artifact.descriptorJson) as unknown,
            ),
            ...(row.primaryFailureId === null
              ? {}
              : {
                  incident: {
                    primaryFailureId: row.primaryFailureId,
                    failures,
                  },
                }),
            ...(work === undefined
              ? {}
              : {
                  workOutcome: {
                    outcome: work.outcome,
                    ...(typeof work.requestOutcome === "string"
                      ? { requestOutcome: work.requestOutcome }
                      : {}),
                    terminalAuthority: work.terminalAuthority,
                    location: work.location,
                  },
                }),
            ...(presentation === undefined
              ? {}
              : {
                  clientPresentation: {
                    status: presentation.status,
                    ...(typeof presentation.mediaType === "string"
                      ? { mediaType: presentation.mediaType }
                      : {}),
                    location: presentation.location,
                  },
                }),
            ...(handoff === undefined
              ? {}
              : {
                  handoffOutcome: {
                    outcome: handoff.outcome,
                    transport: handoff.transport,
                    ...(typeof handoff.writableFinished === "boolean"
                      ? { writableFinished: handoff.writableFinished }
                      : {}),
                    location: handoff.location,
                  },
                }),
          },
        });
        return;
      }

      if (message.type === "resolve_artifact_file") {
        if (
          message.requestId === undefined ||
          message.artifactId === undefined
        ) {
          throw new Error("Artifact file query requires request and artifact ids");
        }
        const artifact = database
          .prepare(
            `SELECT body_path AS bodyPath
             FROM request_journey_artifacts
             WHERE request_id = ? AND artifact_id = ?`,
          )
          .get(message.requestId, message.artifactId) as
          | { readonly bodyPath: string | null }
          | undefined;
        if (artifact === undefined || artifact.bodyPath === null) {
          port.postMessage({
            type: "command_error",
            commandId: message.commandId,
            message: "Request artifact body is unavailable",
          });
          return;
        }
        port.postMessage({
          type: "result",
          commandId: message.commandId,
          value: {
            requestId: message.requestId,
            artifactId: message.artifactId,
            absolutePath: existingStorageFile(artifact.bodyPath),
          },
        });
        return;
      }

      if (message.type === "get_artifact") {
        if (
          message.requestId === undefined ||
          message.artifactId === undefined
        ) {
          throw new Error("Artifact query requires request and artifact ids");
        }
        if (
          !Number.isSafeInteger(message.offset) ||
          message.offset! < 0 ||
          !Number.isSafeInteger(message.limit) ||
          message.limit! <= 0 ||
          message.limit! > 256 * 1_024
        ) {
          throw new Error("Artifact query range is invalid");
        }
        const artifact = database
          .prepare(
            `SELECT body_path AS bodyPath
             FROM request_journey_artifacts
             WHERE request_id = ? AND artifact_id = ?`,
          )
          .get(message.requestId, message.artifactId) as
          | { readonly bodyPath: string | null }
          | undefined;
        if (artifact === undefined || artifact.bodyPath === null) {
          port.postMessage({
            type: "command_error",
            commandId: message.commandId,
            message: "Request artifact body is unavailable",
          });
          return;
        }
        const offset = message.offset!;
        const limit = message.limit!;
        const absolutePath = existingStorageFile(artifact.bodyPath);
        const bodyBytes = statSync(absolutePath).size;
        const nextOffset = Math.min(bodyBytes, offset + limit);
        const chunk = new Uint8Array(Math.max(0, nextOffset - offset));
        if (chunk.byteLength > 0) {
          const descriptor = openSync(absolutePath, "r");
          try {
            readSync(descriptor, chunk, 0, chunk.byteLength, offset);
          } finally {
            closeSync(descriptor);
          }
        }
        port.postMessage({
          type: "result",
          commandId: message.commandId,
          value: {
            requestId: message.requestId,
            artifactId: message.artifactId,
            offset,
            nextOffset,
            complete: nextOffset >= bodyBytes,
            dataBase64: Buffer.from(chunk).toString("base64"),
          },
        });
        return;
      }

      if (message.type === "close") {
        database.close();
        port.postMessage({ type: "closed", commandId: message.commandId });
        return;
      }
    } catch (error) {
      port.postMessage({
        type: "command_error",
        ...(message.commandId === undefined
          ? {
              runtimeId: message.runtimeId,
              ...(message.recordId === undefined
                ? { requestId: message.requestId }
                : { recordId: message.recordId }),
              sequence: message.sequence,
            }
          : { commandId: message.commandId }),
        message: error instanceof Error ? error.message : "Diagnostics process failed",
      });
    }
  };

  let actor = Promise.resolve();
  port.on("message", (raw: unknown) => {
    actor = actor.then(() => handleMessage(raw));
  });

  port.postMessage({ type: "ready" });
}

export const DIAGNOSTICS_WORKER_SOURCE = `${ARTIFACT_REDACTION_ISOLATE_SOURCE}\n(${diagnosticsWorkerMain.toString()})()`;
import { ARTIFACT_REDACTION_ISOLATE_SOURCE } from "./artifact-redaction.js";

declare const redactRequestArtifact: (
  input: Readonly<{
    artifactKind: string;
    mediaType?: string;
    bytes: Uint8Array;
    originalBytes: number;
    sourceTruncated: boolean;
  }>,
) =>
  | Readonly<{
      kind: "sanitized";
      bytes: Uint8Array;
      redaction: "not_required" | "applied";
      truncated: false;
    }>
  | Readonly<{
      kind: "unavailable";
      redaction: "not_required" | "failed";
      reason: string;
    }>;
