import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type ControlPlaneClient,
} from "@token/application-control-plane/control-plane";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import {
  startTokenApplication as startProductionTokenApplication,
  type RunningTokenApplication,
  type StartTokenApplicationOptions,
} from "../../src/application.js";
import { createInstanceAuthority } from "../../src/instance-authority.js";
import { createControlPlaneDiscovery } from "../../src/control-plane-discovery.js";

const roots: string[] = [];
const applications: RunningTokenApplication[] = [];

function startTokenApplication(
  options: Omit<StartTokenApplicationOptions, "instanceAuthority">,
) {
  return startProductionTokenApplication({
    ...options,
    instanceAuthority: createInstanceAuthority({
      path: join(dirname(options.configPath), "instance.sqlite"),
    }),
  });
}

afterEach(async () => {
  await Promise.allSettled(applications.splice(0).map((app) => app.close()));
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

async function fixture(options: { readonly port?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "Token-activation-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  const descriptorPath = join(root, "control-plane.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: "token-config-v2",
    server: { port: options.port ?? (await freePort()) },
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
    diagnostics: { directory: "state/request-diagnostics" },
    pi: { directory: "pi" },
    limits: { maxRequestBytes: 1_048_576, requestTimeoutMs: 120_000 },
  }, null, 2)}\n`, "utf8");
  return { configPath, descriptorPath, root };
}

async function startClient(descriptorPath: string): Promise<ControlPlaneClient> {
  const endpoint = await createControlPlaneDiscovery({ path: descriptorPath }).read();
  if (endpoint === undefined) throw new Error("Expected Control Plane descriptor");
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  if ((await client.hello(controlPlaneVersion)).type !== "compatible") {
    throw new Error("Control Plane hello failed");
  }
  return client;
}

async function addCommandCodeProfile(client: ControlPlaneClient, key: string) {
  const query = await client.executeProviderProfileAuthCommand({ command: "query" });
  const revision = query.state.providers.find(
    (provider) => provider.providerId === "commandcode-private",
  )?.revision;
  if (revision === undefined) throw new Error("Expected Provider revision");
  return client.executeProviderProfileAuthCommand({
    command: "login",
    providerId: "commandcode-private",
    authType: "api_key",
    displayName: "Primary",
    useNow: true,
    expectedRevision: revision,
  }, (event) => {
    if (event.type === "prompt" && event.kind === "secret") {
      void client.respondAuthInteraction({
        type: "prompt_response",
        promptId: event.promptId,
        value: key,
      }).catch(() => undefined);
    }
  });
}

describe("Provider Profiles remain independent of Gateway lifecycle", () => {
  it("queries Profile options and Catalog while the Data Plane is stopped", async () => {
    const { configPath, descriptorPath } = await fixture();
    const started = await startTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);
    const client = await startClient(descriptorPath);
    try {
      expect((await client.executeRuntimeCommand("stop")).outcome).toBe("completed");
      const auth = await client.executeProviderProfileAuthCommand({ command: "query" });
      const providers = auth.options?.providers ?? [];
      expect(providers.find((row) => row.providerId === "commandcode-private")?.source)
        .toBe("token_bundled");
      expect(new Set(
        providers.filter((row) => row.source === "pi_builtin").map((row) => row.providerId),
      )).toEqual(new Set(builtinProviders().map((provider) => provider.id)));
      expect((await client.executeCatalogCommand({ command: "query" })).outcome)
        .toBe("ok");
    } finally {
      await client.close();
    }
  });

  it("persists one Provider record while stopped and reuses it after Gateway restart", async () => {
    const { configPath, descriptorPath, root } = await fixture();
    const started = await startTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);
    const client = await startClient(descriptorPath);
    try {
      await client.executeRuntimeCommand("stop");
      const added = await addCommandCodeProfile(client, "sk-profile-lifecycle");
      expect(added.outcome).toBe("ok");
      const provider = added.state.providers.find(
        (candidate) => candidate.providerId === "commandcode-private",
      );
      expect(provider?.profiles).toHaveLength(1);
      expect(provider?.activeCredentialId).toBe(provider?.profiles[0]?.credentialId);

      const record = JSON.parse(await readFile(join(
        root,
        "pi",
        "credential-profiles",
        "commandcode-private.json",
      ), "utf8")) as { profiles: Array<{ credential: { key: string } }> };
      expect(record.profiles[0]?.credential.key).toBe("sk-profile-lifecycle");
      await expect(access(join(root, "pi", "auth.json"))).rejects.toThrow();

      expect((await client.executeRuntimeCommand("start")).outcome).toBe("completed");
      expect((await client.executeRuntimeCommand("restart")).outcome).toBe("completed");
      const after = await client.executeCredentialProfilesCommand({
        command: "query",
        providerIds: ["commandcode-private"],
      });
      expect(after.state.providers[0]?.profiles[0]?.displayName).toBe("Primary");
    } finally {
      await client.close();
    }
  });

  it("keeps Profile and Catalog queries available after Gateway startup failure", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("blocker did not bind");
    }
    const { configPath, descriptorPath } = await fixture({ port: address.port });
    const started = await startTokenApplication({
      configPath,
      descriptorOverride: descriptorPath,
      ownerKind: "cli",
    });
    expect(started.kind).toBe("running");
    if (started.kind !== "running") return;
    applications.push(started.application);
    const client = await startClient(descriptorPath);
    try {
      expect((await client.getStatus()).modelDataPlane).toBe("failed");
      expect((await client.executeProviderProfileAuthCommand({ command: "query" })).outcome)
        .toBe("ok");
      expect((await client.executeCatalogCommand({ command: "query" })).outcome)
        .toBe("ok");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
