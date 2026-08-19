import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
} from "@luckytoken/application-control-plane/control-plane";

import {
  startLuckyTokenApplication,
  type RunningLuckyTokenApplication,
} from "../../src/application.js";
import { readControlPlaneDescriptor } from "../../src/control-plane-discovery.js";

const roots: string[] = [];
const applications: RunningLuckyTokenApplication[] = [];

afterEach(async () => {
  await Promise.allSettled(applications.splice(0).map((application) => application.close()));
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind a TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function fixture(): Promise<{ configPath: string; descriptorPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-application-"));
  const port = await freePort();
  roots.push(root);
  const configPath = join(root, "config.json");
  const descriptorPath = join(root, "control-plane.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
            conversion: {
              request: {
                unknownContent: "error",
                unresolvedToolCall: "xrepair",
                localCacheControl: "ignore",
              },
              response: { unknownPiContent: "error" },
            },
          },
        },
        providerPackages: {},
        failureLogging: {
          directory: "logs/failed-requests",
          detail: "safe",
          maxFileBytes: 1048576,
          retentionDays: 30,
          maxFiles: 1000,
          logCancellation: true,
        },
        runtimeDiagnostics: { directory: "state/diagnostics" },
        deepDiagnostics: {
          directory: "state/deep-diagnostics",
          enabled: false,
          maxCaptureBytes: 4194304,
          retentionAgeMs: 604800000,
          maxCaptures: 1000,
        },
        pi: { directory: "pi" },
        limits: { maxRequestBytes: 1048576, requestTimeoutMs: 120000 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { configPath, descriptorPath };
}

describe("Backend Application public lifecycle seam", () => {
  it("rebuilds legacy v1 client auth as fresh v2 and keeps global-token management available while the Router is stopped", async () => {
    const { configPath, descriptorPath } = await fixture();
    const authPath = join(dirname(configPath), "client-auth", "anthropic-messages.json");
    const legacyToken = "legacy-v1-token-canary";
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        schemaVersion: "luckytoken-client-auth-v1",
        global: legacyToken,
        projects: {},
      }),
      "utf8",
    );

    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      const stopped = await client.executeRuntimeCommand("stop");
      expect(stopped.snapshot.modelDataPlane).toBe("stopped");

      const listed = await client.executeClientTokenCommand({
        command: "list",
        protocolId: "anthropic-messages",
      });
      expect(listed.outcome).toBe("ok");
      expect(listed.scopes?.some((scope) => scope.type === "global")).toBe(true);
      const revealed = await client.executeClientTokenCommand({
        command: "reveal",
        protocolId: "anthropic-messages",
      });
      expect(revealed.outcome).toBe("ok");
      expect(revealed.token).toBeDefined();
      expect(revealed.token).not.toBe(legacyToken);

      const onDisk = JSON.parse(await readFile(authPath, "utf8")) as {
        schemaVersion: string;
        global: string;
        revision: number;
        globalDeleted: boolean;
        projects: Record<string, string>;
      };
      expect(onDisk).toEqual({
        schemaVersion: "luckytoken-client-auth-v2",
        global: revealed.token,
        projects: {},
        revision: 1,
        globalDeleted: false,
      });
    } finally {
      await client.close();
    }
  });

  it("starts normal serving, exposes the Control Plane, and closes idempotently", async () => {
    const { configPath, descriptorPath } = await fixture();

    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await expect(client.hello(controlPlaneVersion)).resolves.toMatchObject({
        type: "compatible",
      });
      await expect(client.getStatus()).resolves.toMatchObject({
        modelDataPlane: "running",
      });
    } finally {
      await client.close();
    }

    await started.application.close();
    await expect(started.application.close()).resolves.toBeUndefined();
    await expect(started.application.exited).resolves.toMatchObject({
      reason: "closed",
    });
  });

  it("does not let a desktop lease take ownership of a CLI-owned Backend", async () => {
    const { configPath, descriptorPath } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      await expect(
        client.executeApplicationCommand({
          command: "desktop_owner",
          action: "claim",
          leaseId: "desktop-must-not-own-cli",
        }),
      ).resolves.toMatchObject({
        command: "desktop_owner",
        outcome: "unsupported",
        snapshot: { ownership: { owner: { kind: "cli" } } },
      });
    } finally {
      await client.close();
    }
  });

  it("starts incompatible configuration in recovery-only mode", async () => {
    const { configPath, descriptorPath } = await fixture();
    await writeFile(configPath, "{ invalid json", "utf8");

    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      await expect(client.getStatus()).resolves.toMatchObject({
        modelDataPlane: "stopped",
        recovery: { mode: "incompatible_configuration" },
      });
    } finally {
      await client.close();
    }
  });

  it("attaches a second start attempt to the active application", async () => {
    const { configPath, descriptorPath } = await fixture();
    const first = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(first.kind).toBe("running");
    if (first.kind !== "running") return;
    applications.push(first.application);

    const second = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "desktop",
    });

    expect(second.kind).toBe("attached");
    if (second.kind === "attached") {
      expect(second.ownership?.owner.pid).toBe(process.pid);
      expect(second.ownership?.owner.kind).toBe("cli");
    }
  });

  it("delivers an ownership-aware quit result before the application exits", async () => {
    const { configPath, descriptorPath } = await fixture();
    const started = await startLuckyTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);

    const endpoint = await readControlPlaneDescriptor(descriptorPath);
    const client = await connectControlPlane(endpoint, {
      createRequestId: randomUUID,
      pipeConnector: createNodePipeTransport(),
    });
    try {
      await client.hello(controlPlaneVersion);
      const result = await client.executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      });
      expect(result.outcome).toBe("drained");
    } finally {
      await client.close().catch(() => undefined);
    }

    await expect(started.application.exited).resolves.toEqual({
      reason: "drained",
    });
  });
});
