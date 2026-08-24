/**
 * The Worker is created with `eval: true` so the same source works both from
 * TypeScript tests and from compiled JavaScript without a second build asset.
 * This function must remain self-contained: only its serialized body runs in
 * the Worker isolate.
 */
function diagnosticsWorkerMain(): void {
  /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports -- the serialized eval Worker has no module-scope imports */
  const { parentPort, workerData } = require("node:worker_threads") as typeof import("node:worker_threads");
  const { chmodSync, mkdirSync, readFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const { join } = require("node:path") as typeof import("node:path");
  const { backup, DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */

  if (parentPort === null) throw new Error("Diagnostics Worker has no parent port");
  const port = parentPort;
  const data = workerData as {
    readonly directory: string;
    readonly runtimeId: string;
    readonly artifactRetentionAgeMs: number;
    readonly maxArtifactJourneys: number;
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
  mkdirSync(data.directory, { recursive: true });
  const database = new DatabaseSync(join(data.directory, "diagnostics.sqlite3"));
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
      existingSchema.value !== "luckytoken_diagnostics"
    ) {
      permanentStartupFailure();
      return;
    }
    const existingVersion = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { readonly value: number } | undefined;
    if (existingVersion === undefined || Number(existingVersion.value) !== 1) {
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
        "usage_completeness",
        "usage_input",
        "usage_cache_read",
        "usage_cache_write",
        "usage_output",
        "usage_reasoning",
        "usage_normalized_total",
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
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_name', 'luckytoken_diagnostics');
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', 1);
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
      usage_completeness TEXT,
      usage_input INTEGER,
      usage_cache_read INTEGER,
      usage_cache_write INTEGER,
      usage_output INTEGER,
      usage_reasoning INTEGER,
      usage_normalized_total INTEGER
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
      body BLOB,
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

  const evictArtifactBodies = (
    requestId: string,
    time: number,
  ): void => {
    const rows = database
      .prepare(
        `SELECT artifact_id AS artifactId, descriptor_json AS descriptorJson
           FROM request_journey_artifacts
          WHERE request_id = ? AND body IS NOT NULL
          ORDER BY artifact_id`,
      )
      .all(requestId) as Array<{
      readonly artifactId: string;
      readonly descriptorJson: string;
    }>;
    for (const row of rows) {
      const descriptor = JSON.parse(row.descriptorJson) as Record<string, unknown>;
      database
        .prepare(
          `UPDATE request_journey_artifacts
              SET descriptor_json = ?, body = NULL
            WHERE request_id = ? AND artifact_id = ? AND body IS NOT NULL`,
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
  };

  const enforceArtifactRetention = (time: number): void => {
    const ageExpired = database
      .prepare(
        `SELECT DISTINCT a.request_id AS requestId
           FROM request_journey_artifacts a
           JOIN request_journeys j ON j.request_id = a.request_id
          WHERE a.body IS NOT NULL AND j.accepted_at < ?
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
            WHERE a.body IS NOT NULL
            ORDER BY acceptedAt DESC, recordId DESC
            LIMIT -1 OFFSET ?
         ) ORDER BY acceptedAt, recordId`,
      )
      .all(maxArtifactJourneys) as Array<{ readonly requestId: string }>;
    for (const row of countExpired) evictArtifactBodies(row.requestId, time);
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

  const projectSummary = (row: {
    readonly id: number;
    readonly runtimeId: string;
    readonly requestId: string;
    readonly operation: string;
    readonly protocol: string | null;
    readonly lane: string | null;
    readonly outcome: string;
    readonly completeness: string;
    readonly createdAt: number;
    readonly closedAt: number | null;
    readonly admissionJson: string;
    readonly primaryFailureId: string | null;
    readonly primaryFailureJson: string | null;
  }): Record<string, unknown> => {
    const primaryFailure =
      row.primaryFailureJson === null
        ? undefined
        : (JSON.parse(row.primaryFailureJson) as Record<string, unknown>);
    const primaryFailureLocation = primaryFailure?.location;
    return {
      id: Number(row.id),
      runtimeId: row.runtimeId,
      requestId: row.requestId,
      operation: row.operation,
      ...(row.protocol === null ? {} : { protocol: row.protocol }),
      ...(row.lane === null ? {} : { lane: row.lane }),
      outcome: row.outcome,
      completeness: row.completeness,
      createdAt: Number(row.createdAt),
      ...(row.closedAt === null ? {} : { closedAt: Number(row.closedAt) }),
      ...(typeof primaryFailureLocation === "object" &&
      primaryFailureLocation !== null
        ? { primaryFailureLocation }
        : {}),
    };
  };

  const summarySelect = `
    SELECT r.id AS id, r.runtime_id AS runtimeId,
           j.request_id AS requestId, j.operation AS operation,
           j.protocol AS protocol, j.lane AS lane, j.outcome AS outcome,
           r.completeness AS completeness, r.created_at AS createdAt,
           r.closed_at AS closedAt, j.admission_json AS admissionJson,
           j.primary_failure_id AS primaryFailureId,
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
        completeness: string;
        input: number;
        cacheRead: number;
        cacheWrite: number;
        output: number;
        reasoning: number | null;
        normalizedTotal: number | null;
      }>
    | undefined => {
    if (!isRecord(value)) return undefined;
    const completeness = value.completeness;
    if (
      completeness !== "complete" &&
      completeness !== "partial" &&
      completeness !== "unavailable"
    ) {
      return undefined;
    }
    const input = value.input;
    const cacheRead = value.cacheRead;
    const cacheWrite = value.cacheWrite;
    const output = value.output;
    const reasoning = value.reasoning;
    const normalizedTotal = value.normalizedTotal;
    if (
      !isSafeFact(value.api, 128) ||
      !isNonNegativeSafeInteger(input) ||
      !isNonNegativeSafeInteger(cacheRead) ||
      !isNonNegativeSafeInteger(cacheWrite) ||
      !isNonNegativeSafeInteger(output) ||
      (reasoning !== undefined &&
        (!isNonNegativeSafeInteger(reasoning) || reasoning > output)) ||
      (normalizedTotal !== undefined &&
        !isNonNegativeSafeInteger(normalizedTotal))
    ) {
      return undefined;
    }
    if (
      completeness === "complete" &&
      normalizedTotal !== input + cacheRead + cacheWrite + output
    ) {
      return undefined;
    }
    if (completeness !== "complete" && normalizedTotal !== undefined) {
      return undefined;
    }
    return {
      completeness,
      input,
      cacheRead,
      cacheWrite,
      output,
      reasoning: reasoning === undefined ? null : reasoning,
      normalizedTotal:
        normalizedTotal === undefined ? null : normalizedTotal,
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
    readonly artifactBody?: Uint8Array;
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
      return message.artifactBody === undefined &&
        (payload.level === "info" ||
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
    if (
      message.artifactBody !== undefined &&
      !(message.artifactBody instanceof Uint8Array)
    ) {
      return "invalid_append_artifact_body";
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
    readonly usageCompleteness: string | null;
    readonly usageInput: number | null;
    readonly usageCacheRead: number | null;
    readonly usageCacheWrite: number | null;
    readonly usageOutput: number | null;
    readonly usageReasoning: number | null;
    readonly usageNormalizedTotal: number | null;
  }

  interface AnalyticsAccumulator {
    total: number;
    success: number;
    failed: number;
    aborted: number;
    other: number;
    pending: number;
    participating: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    reasoningReported: boolean;
    normalizedTotal: number;
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
    participating: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    reasoningReported: false,
    normalizedTotal: 0,
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
    if (row.usageCompleteness !== "complete") return;
    const input = row.usageInput ?? 0;
    const cacheRead = row.usageCacheRead ?? 0;
    const cacheWrite = row.usageCacheWrite ?? 0;
    const output = row.usageOutput ?? 0;
    accumulator.participating += 1;
    accumulator.input += input;
    accumulator.cacheRead += cacheRead;
    accumulator.cacheWrite += cacheWrite;
    accumulator.output += output;
    accumulator.normalizedTotal += row.usageNormalizedTotal ?? 0;
    if (row.usageReasoning !== null) {
      accumulator.reasoning += row.usageReasoning;
      accumulator.reasoningReported = true;
    }
    if (
      row.executionStartedAt !== null &&
      row.executionTerminalAt !== null
    ) {
      const duration = row.executionTerminalAt - row.executionStartedAt;
      if (duration > 0) {
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
      participating: accumulator.participating,
      totalRequests: total,
      excluded: total - accumulator.participating,
      inputTokens: accumulator.input,
      cacheReadTokens: accumulator.cacheRead,
      cacheWriteTokens: accumulator.cacheWrite,
      outputTokens: accumulator.output,
      ...(accumulator.executionDurationMs > 0
        ? {
            outputTokensPerSecond:
              (accumulator.speedOutput / accumulator.executionDurationMs) *
              1_000,
          }
        : {}),
      ...(accumulator.participating > 0 && accumulator.reasoningReported
        ? { reasoningTokens: accumulator.reasoning }
        : {}),
      ...(accumulator.participating > 0
        ? { normalizedTokenTotal: accumulator.normalizedTotal }
        : {}),
      cacheHitNumerator: accumulator.cacheRead,
      cacheHitDenominator: denominator,
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
              usage_completeness AS usageCompleteness,
              usage_input AS usageInput,
              usage_cache_read AS usageCacheRead,
              usage_cache_write AS usageCacheWrite,
              usage_output AS usageOutput,
              usage_reasoning AS usageReasoning,
              usage_normalized_total AS usageNormalizedTotal
         FROM request_journeys
        WHERE (? IS NULL OR accepted_at >= ?)
          AND (? IS NULL OR accepted_at < ?)
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
    if (query?.version !== 2) throw new Error("Analytics query is invalid");
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
        version: 2,
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
      version: 2,
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
          const leftTotal = (left.summary.totalRequests as number) ?? 0;
          const rightTotal = (right.summary.totalRequests as number) ?? 0;
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
      readonly offset?: number;
      readonly limit?: number;
      readonly sequence?: number;
      readonly time?: number;
      readonly messageKind?: string;
      readonly payload?: Record<string, unknown>;
      readonly artifactBody?: Uint8Array;
      readonly query?: Record<string, unknown>;
      readonly range?: unknown;
    };
    try {
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
        const payload = message.payload!;
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
              database
                .prepare(
                  `INSERT INTO request_journey_artifacts
                     (request_id, artifact_id, descriptor_json, body)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(request_id, artifact_id) DO UPDATE SET
                     descriptor_json = excluded.descriptor_json,
                     body = excluded.body`,
                )
                .run(
                  requestId,
                  descriptor.artifactId,
                  JSON.stringify(descriptor),
                  message.artifactBody ?? null,
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
                     SET usage_completeness = ?, usage_input = ?,
                         usage_cache_read = ?, usage_cache_write = ?,
                         usage_output = ?, usage_reasoning = ?,
                         usage_normalized_total = ?
                     WHERE request_id = ? AND usage_completeness IS NULL`,
                  )
                  .run(
                    usage.completeness,
                    usage.input,
                    usage.cacheRead,
                    usage.cacheWrite,
                    usage.output,
                    usage.reasoning,
                    usage.normalizedTotal,
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
            enforceArtifactRetention(time);
          }
          database.exec("COMMIT");
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
        const rows = database
          .prepare(`${summarySelect} WHERE r.id > ? ORDER BY r.id LIMIT ?`)
          .all(afterId, limit + 1) as Array<Parameters<typeof projectSummary>[0]>;
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
            `SELECT body
             FROM request_journey_artifacts
             WHERE request_id = ? AND artifact_id = ?`,
          )
          .get(message.requestId, message.artifactId) as
          | { readonly body: Uint8Array | null }
          | undefined;
        if (artifact === undefined || artifact.body === null) {
          port.postMessage({
            type: "command_error",
            commandId: message.commandId,
            message: "Request artifact body is unavailable",
          });
          return;
        }
        const offset = message.offset!;
        const limit = message.limit!;
        const body = new Uint8Array(artifact.body);
        const nextOffset = Math.min(body.byteLength, offset + limit);
        const chunk =
          offset >= body.byteLength
            ? new Uint8Array()
            : body.subarray(offset, nextOffset);
        port.postMessage({
          type: "result",
          commandId: message.commandId,
          value: {
            requestId: message.requestId,
            artifactId: message.artifactId,
            offset,
            nextOffset,
            complete: nextOffset >= body.byteLength,
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
        message: error instanceof Error ? error.message : "Diagnostics Worker failed",
      });
    }
  };

  let actor = Promise.resolve();
  port.on("message", (raw: unknown) => {
    actor = actor.then(() => handleMessage(raw));
  });

  port.postMessage({ type: "ready" });
}

export const DIAGNOSTICS_WORKER_SOURCE = `(${diagnosticsWorkerMain.toString()})()`;
