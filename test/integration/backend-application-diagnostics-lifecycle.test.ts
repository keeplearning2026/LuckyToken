import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
} from "@token/application-control-plane/control-plane";
import { afterEach, describe, expect, it } from "vitest";

import {
  startTokenApplication,
  type RunningTokenApplication,
  type StartTokenApplicationOptions,
  type StartTokenApplicationResult,
} from "../../src/application.js";
import { createControlPlaneDiscovery } from "../../src/control-plane-discovery.js";
import type {
  DiagnosticsConfiguration,
  DiagnosticsManagementAuthority,
  JourneyCapturePolicySource,
  RequestJourneyBeginInput,
  RequestJourneyCloseInput,
} from "../../src/diagnostics/index.js";
import { createInstanceAuthority } from "../../src/instance-authority.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve: (value: T) => resolvePromise?.(value),
  });
}

interface DiagnosticsAuthorityFactoryInput {
  readonly configuration: DiagnosticsConfiguration;
  readonly runtimeId: string;
  readonly journeyCapturePolicy: JourneyCapturePolicySource;
}

type DiagnosticsAuthorityFactory = (
  input: DiagnosticsAuthorityFactoryInput,
) => Promise<DiagnosticsManagementAuthority>;

type DiagnosticsApplicationTestSeam = StartTokenApplicationOptions & {
  readonly diagnosticsAuthorityFactory: DiagnosticsAuthorityFactory;
};

const startWithDiagnosticsFactory = startTokenApplication as (
  options: DiagnosticsApplicationTestSeam,
) => Promise<StartTokenApplicationResult>;

const roots: string[] = [];
const applications: RunningTokenApplication[] = [];

afterEach(async () => {
  await Promise.allSettled(
    applications.splice(0).map((application) => application.close()),
  );
  await Promise.allSettled(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind a TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) =>
      error === undefined ? resolveClose() : reject(error),
    );
  });
  return port;
}

async function fixture(): Promise<{
  readonly root: string;
  readonly configPath: string;
  readonly descriptorPath: string;
  readonly port: number;
}> {
  const root = await mkdtemp(join(tmpdir(), "Token-diagnostics-app-"));
  roots.push(root);
  const port = await freePort();
  const configPath = join(root, "config.json");
  const descriptorPath = join(root, "control-plane.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: "token-config-v2",
        server: { port },
        clientProtocols: {
          "anthropic-messages": {
            conversion: {
              request: {
                unknownContent: "error",
              },
            },
          },
        },
        providerPackages: {},
        diagnostics: {
          directory: "state/request-diagnostics",
          maxJsonArtifactBytes: 67_108_864,
          maxJourneyArtifactBytes: 536_870_912,
          maxArtifactDiskBytes: 5_368_709_120,
          artifactRetentionAgeMs: 604_800_000,
          maxArtifactJourneys: 1_000,
        },
        pi: { directory: "pi" },
        limits: { maxRequestBytes: 1_048_576, requestTimeoutMs: 120_000 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, configPath, descriptorPath, port };
}

async function readControlPlaneDescriptor(path: string) {
  const endpoint = await createControlPlaneDiscovery({ path }).read();
  if (endpoint === undefined) throw new Error("Expected Control Plane descriptor");
  return endpoint;
}

async function sendUnknownModelRequest(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "diagnostics-lifecycle-unknown-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "diagnostics lifecycle" }],
    }),
  });
  expect(response.status).toBe(400);
  await response.arrayBuffer();
}

interface LegacyTreeEntry {
  readonly kind: "directory" | "file";
  readonly relativePath: string;
  readonly mtimeMs: number;
  readonly bytes?: string;
}

interface LegacyStorageFixture {
  readonly roots: readonly string[];
  readonly snapshot: readonly LegacyTreeEntry[];
}

async function snapshotTrees(
  storageRoots: readonly string[],
): Promise<readonly LegacyTreeEntry[]> {
  const entries: LegacyTreeEntry[] = [];
  const visit = async (root: string, path: string): Promise<void> => {
    const metadata = await stat(path);
    const relativePath = path.slice(root.length).replaceAll("\\", "/") || ".";
    if (metadata.isDirectory()) {
      entries.push({ kind: "directory", relativePath: `${root}:${relativePath}`, mtimeMs: metadata.mtimeMs });
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        await visit(root, join(path, child.name));
      }
      return;
    }
    entries.push({
      kind: "file",
      relativePath: `${root}:${relativePath}`,
      mtimeMs: metadata.mtimeMs,
      bytes: (await readFile(path)).toString("base64"),
    });
  };
  for (const root of storageRoots) await visit(root, root);
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

async function seedLegacyStorage(root: string): Promise<LegacyStorageFixture> {
  const invocationRoot = join(root, "logs", "failed-requests");
  const requestLedgerRoot = join(root, "state", "request-ledger");
  const deepCaptureRoot = join(root, "state", "deep-diagnostics");
  const runtimeDiagnosticsRoot = join(root, "state", "diagnostics");
  const seededFiles = [
    {
      path: join(
        invocationRoot,
        "2026-08-22",
        "53000000-0000-4000-8000-000000000001.json",
      ),
      canary: "legacy-invocation-journal-canary",
    },
    {
      path: join(requestLedgerRoot, "ledger.sqlite3"),
      canary: "legacy-request-ledger-canary",
    },
    {
      path: join(deepCaptureRoot, "capture.sqlite3"),
      canary: "legacy-deep-capture-canary",
    },
    {
      path: join(runtimeDiagnosticsRoot, "diagnostics.sqlite3"),
      canary: "legacy-runtime-diagnostics-canary",
    },
  ] as const;
  const fixedMtime = new Date("2026-08-22T12:34:56.000Z");
  for (const file of seededFiles) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, Buffer.from(file.canary, "utf8"));
    await utimes(file.path, fixedMtime, fixedMtime);
  }
  const legacyRoots = Object.freeze([
    invocationRoot,
    requestLedgerRoot,
    deepCaptureRoot,
    runtimeDiagnosticsRoot,
  ]);
  return Object.freeze({
    roots: legacyRoots,
    snapshot: await snapshotTrees(legacyRoots),
  });
}

describe("Backend Application DiagnosticsAuthority lifecycle", () => {
  it("creates one Backend authority, reuses it across Data Plane restart, and closes it once after drain", async () => {
    const { root, configPath, descriptorPath, port } = await fixture();
    expect(process.env.CODEX_HOME).toBeTruthy();
    expect(resolve(process.env.CODEX_HOME!)).not.toBe(resolve(root));

    const factoryInputs: DiagnosticsAuthorityFactoryInput[] = [];
    const beginInputs: RequestJourneyBeginInput[] = [];
    const journeyCloseInputs: RequestJourneyCloseInput[] = [];
    const targetBeginInputs: RequestJourneyBeginInput[] = [];
    const targetCloseInputs: RequestJourneyCloseInput[] = [];
    const firstJourneyClosed = deferred<void>();
    const secondJourneyClosed = deferred<void>();
    const authorityCloseEntered = deferred<void>();
    const allowAuthorityClose = deferred<void>();
    let authorityCloseCalls = 0;

    const authority: DiagnosticsManagementAuthority = Object.freeze({
      diagnosticsAvailable: () => true,
      begin(input: RequestJourneyBeginInput) {
        beginInputs.push(input);
        if (input.path === "/v1/messages") targetBeginInputs.push(input);
        return Object.freeze({
          requestId: input.requestId,
          observe() {},
          close(closeInput: RequestJourneyCloseInput) {
            journeyCloseInputs.push(closeInput);
            if (input.path !== "/v1/messages") return;
            targetCloseInputs.push(closeInput);
            if (targetCloseInputs.length === 1) firstJourneyClosed.resolve();
            if (targetCloseInputs.length === 2) secondJourneyClosed.resolve();
          },
        });
      },
      observeRuntime() {},
      queryRequestJourneys: () =>
        Promise.resolve(Object.freeze({ records: Object.freeze([]), hasMore: false })),
      getRequestJourney: () =>
        Promise.reject(new Error("not used by this lifecycle test")),
      getRequestArtifact: () =>
        Promise.reject(new Error("not used by this lifecycle test")),
      queryRuntimeEvents: () =>
        Promise.resolve(Object.freeze({ records: Object.freeze([]), hasMore: false })),
      getAnalytics: () => Promise.reject(new Error("not used by this lifecycle test")),
      createBackupSnapshot: () => Promise.reject(new Error("not used by this lifecycle test")),
      countHistory: () => Promise.resolve({ requestJourneys: 0, runtimeEvents: 0 }),
      deleteHistory: () => Promise.resolve({ deleted: { requestJourneys: 0, runtimeEvents: 0 } }),
      subscribeRequestJourneys: () =>
        Object.freeze({ unsubscribe: () => undefined }),
      subscribeRuntimeEvents: () =>
        Object.freeze({ unsubscribe: () => undefined }),
      close() {
        authorityCloseCalls += 1;
        authorityCloseEntered.resolve();
        return allowAuthorityClose.promise;
      },
    });
    const diagnosticsAuthorityFactory: DiagnosticsAuthorityFactory = (input) => {
      factoryInputs.push(input);
      return Promise.resolve(authority);
    };

    await mkdir(dirname(descriptorPath), { recursive: true });
    const started = await startWithDiagnosticsFactory({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
      codexCatalogValidator: { validate: async () => undefined },
      instanceAuthority: createInstanceAuthority({
        path: join(root, "instance.sqlite"),
      }),
      diagnosticsAuthorityFactory,
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    expect(factoryInputs).toHaveLength(1);
    expect(factoryInputs[0]).toMatchObject({
      configuration: {
        directory: resolve(root, "state/request-diagnostics"),
      },
      runtimeId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
    });
    const backendRuntimeId = factoryInputs[0]!.runtimeId;
    expect(factoryInputs[0]!.journeyCapturePolicy.snapshot()).toEqual({
      allRequestsEnabled: false,
      failedRequestsEnabled: true,
    });

    await sendUnknownModelRequest(port);
    await firstJourneyClosed.promise;
    expect(targetBeginInputs).toHaveLength(1);
    expect(targetCloseInputs).toHaveLength(1);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      await expect(
        client.executeSettingsCommand({
          command: "set",
          key: "diagnostics.fullJourneyCapture.enabled",
          value: true,
        }),
      ).resolves.toMatchObject({ outcome: "applied" });
      expect(factoryInputs[0]!.journeyCapturePolicy.snapshot()).toEqual({
        allRequestsEnabled: true,
        failedRequestsEnabled: true,
      });
      await expect(
        client.executeSettingsCommand({
          command: "set",
          key: "diagnostics.failedJourneyCapture.enabled",
          value: false,
        }),
      ).resolves.toMatchObject({ outcome: "applied" });
      expect(factoryInputs[0]!.journeyCapturePolicy.snapshot()).toEqual({
        allRequestsEnabled: true,
        failedRequestsEnabled: false,
      });
      expect((await client.executeRuntimeCommand("restart")).outcome).toBe(
        "completed",
      );
    } finally {
      await client.close();
    }

    expect(factoryInputs).toHaveLength(1);
    expect(factoryInputs[0]!.runtimeId).toBe(backendRuntimeId);
    expect(authorityCloseCalls).toBe(0);

    await sendUnknownModelRequest(port);
    await secondJourneyClosed.promise;
    expect(targetBeginInputs).toHaveLength(2);
    expect(targetCloseInputs).toHaveLength(2);

    const shutdown = started.application.requestShutdown();
    await authorityCloseEntered.promise;
    expect(authorityCloseCalls).toBe(1);
    await expect(sendUnknownModelRequest(port)).rejects.toThrow();
    allowAuthorityClose.resolve();
    await expect(shutdown).resolves.toEqual({ reason: "drained" });

    await started.application.close();
    expect(authorityCloseCalls).toBe(1);
  });

  it("leaves every legacy diagnostics store untouched and creates only the unified database", async () => {
    const { root, configPath, descriptorPath } = await fixture();
    expect(process.env.CODEX_HOME).toBeTruthy();
    expect(resolve(process.env.CODEX_HOME!)).not.toBe(resolve(root));
    const legacy = await seedLegacyStorage(root);

    const started = await startTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
      codexCatalogValidator: { validate: async () => undefined },
      instanceAuthority: createInstanceAuthority({
        path: join(root, "instance.sqlite"),
      }),
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    await started.application.requestShutdown();
    await started.application.close();

    expect(await snapshotTrees(legacy.roots)).toEqual(legacy.snapshot);

    const unifiedDirectory = join(root, "state", "request-diagnostics");
    const unifiedFiles = await readdir(unifiedDirectory)
      .then((entries) => entries.sort())
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
    expect(
      unifiedFiles,
      "the unified DiagnosticsAuthority must create state/request-diagnostics",
    ).toBeDefined();
    if (unifiedFiles === undefined) return;
    expect(unifiedFiles).toContain("diagnostics-v3.sqlite3");
    expect(unifiedFiles).toEqual(
      expect.arrayContaining(["diagnostics-v3.sqlite3", "full-journeys"]),
    );
    expect(
      unifiedFiles.filter(
        (name) =>
          name !== "diagnostics-v3.sqlite3" &&
          name !== "diagnostics-v3.sqlite3-wal" &&
          name !== "diagnostics-v3.sqlite3-shm" &&
          name !== "full-journeys",
      ),
    ).toEqual([]);
  });
});
