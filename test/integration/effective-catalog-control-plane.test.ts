import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createModelsControlPlaneHandler } from "../../src/models-config/control-plane.js";
import {
  createModelsJsonAuthority,
  type ModelsJsonAuthorityOptions,
} from "../../src/models-config/authority.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";
import { PI_COMPATIBILITY_BASELINE } from "../../src/providers/pi-baseline.js";

/**
 * Ticket 09 public seam: the effective catalog through the versioned
 * Control Plane models commands. Every case drives the real authority
 * against a real file and asserts through the pipe client, so the
 * apply/query hot-update path, the UI/CLI write equivalence, and the
 * invalid-file isolation are all exercised end to end.
 */
describe("effective catalog through the Control Plane", () => {
  const roots: string[] = [];
  const hosts: RunningControlPlane[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function startCatalogControlPlane(options: {
    readonly directory: string;
    readonly file?: string;
    readonly compose?: ModelsJsonAuthorityOptions["compose"];
  }): Promise<{
    readonly host: RunningControlPlane;
    readonly client: Awaited<ReturnType<typeof connectControlPlane>>;
    readonly path: string;
  }> {
    const path = options.file ?? join(options.directory, "models.json");
    const authority = createModelsJsonAuthority({
      path,
      compose:
        options.compose ?? ((providers) => composeEffectiveCatalog(providers)),
    });
    const endpoint: ControlPlaneEndpoint = {
      address: `\\\\.\\pipe\\luckytoken-catalog-${process.pid}-${++nextPipe}`,
      capability: "catalog-test-capability-0123456789012345678901",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      modelsCommandHandler: createModelsControlPlaneHandler(authority),
      modelsProjection: () => authority.snapshot(),
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `catalog-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await client.hello(4);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }
    return { host, client, path };
  }

  it("queries the built-in base layer with no user file and identifies the pinned baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-catalog-cp-"));
    roots.push(directory);

    const { client } = await startCatalogControlPlane({ directory });

    const result = await client.executeModelsCommand({ command: "query" });
    expect(result.outcome).toBe("ok");
    expect(result.state).toMatchObject({
      revision: 0,
      present: false,
      valid: false,
      raw: "",
    });
    expect(result.state.catalog).toBeUndefined();

    // A valid-for-creation state carries no catalog yet, but the
    // structured creation immediately exposes the effective base layer.
    const created = await client.executeModelsCommand({
      command: "write_structured",
      revision: 0,
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [{ id: "llama3.1:8b" }],
        },
      },
    });
    expect(created.outcome).toBe("ok");
    const catalog = created.state.catalog;
    expect(catalog?.schemaVersion).toBe("luckytoken-effective-catalog-v1");
    expect(catalog?.baseline).toEqual(PI_COMPATIBILITY_BASELINE);
    expect(catalog?.compositionErrors).toEqual([]);
    const openai = catalog?.providers.find(
      (provider) => provider.id === "openai",
    );
    expect(openai?.layer).toBe("builtin");
    expect(openai?.models[0]).toMatchObject({
      id: "gpt-4",
      api: "openai-responses",
      layer: "builtin",
    });
    const ollama = catalog?.providers.find(
      (provider) => provider.id === "ollama",
    );
    expect(ollama?.layer).toBe("user");
    expect(ollama?.models[0]).toMatchObject({
      id: "llama3.1:8b",
      layer: "user",
      contextWindow: 128000,
      maxTokens: 16384,
    });
    // Custom providers follow every built-in provider.
    const ids = catalog?.providers.map((provider) => provider.id) ?? [];
    expect(ids.indexOf("openai")).toBeLessThan(ids.indexOf("ollama"));
  });

  it("hot-updates the effective catalog after apply and keeps UI and CLI writes equivalent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-catalog-cp-"));
    roots.push(directory);

    const { client } = await startCatalogControlPlane({ directory });

    // CLI origin: a raw write of the authoritative file.
    const rawContent = `{
  "providers": {
    "openai": {
      "baseUrl": "https://gateway.example.com/v1",
      "name": "OpenAI via Gateway",
      "modelOverrides": { "gpt-4": { "name": "GPT-4 via Gateway" } }
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "models": [{ "id": "llama3.1:8b", "contextWindow": 65536 }]
    }
  }
}
`;
    const rawWrite = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: rawContent,
    });
    expect(rawWrite.outcome).toBe("ok");

    // UI origin: the structured editor writes the same providers record.
    const providers = {
      openai: {
        baseUrl: "https://gateway.example.com/v1",
        name: "OpenAI via Gateway",
        modelOverrides: { "gpt-4": { name: "GPT-4 via Gateway" } },
      },
      local: {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        models: [{ id: "llama3.1:8b", contextWindow: 65536 }],
      },
    };
    const structuredWrite = await client.executeModelsCommand({
      command: "write_structured",
      revision: 1,
      providers,
    });
    expect(structuredWrite.outcome).toBe("ok");

    const queried = await client.executeModelsCommand({ command: "query" });
    expect(queried.state.revision).toBe(2);
    const catalog = queried.state.catalog;
    const openai = catalog?.providers.find(
      (provider) => provider.id === "openai",
    );
    expect(openai?.layer).toBe("overlaid");
    expect(openai?.name).toBe("OpenAI via Gateway");
    expect(openai?.models.find((model) => model.id === "gpt-4")).toMatchObject({
      layer: "overridden",
      name: "GPT-4 via Gateway",
      baseUrl: "https://gateway.example.com/v1",
      contextWindow: 8192,
    });
    const local = catalog?.providers.find((provider) => provider.id === "local");
    expect(local?.models[0]).toMatchObject({
      id: "llama3.1:8b",
      layer: "user",
      contextWindow: 65536,
    });

    // Equivalence: a raw write of the identical providers record produces
    // the identical effective catalog (deterministic composition).
    const rawRewrite = `${JSON.stringify({ providers }, null, 2)}\n`;
    const rawWrite2 = await client.executeModelsCommand({
      command: "write_raw",
      revision: 2,
      content: rawRewrite,
    });
    expect(rawWrite2.outcome).toBe("ok");
    const reQueried = await client.executeModelsCommand({ command: "query" });
    expect(reQueried.state.catalog).toEqual(catalog);
  });

  it("isolates invalid files: no catalog, exact error, and no secrets anywhere", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-catalog-cp-"));
    roots.push(directory);
    const content = JSON.stringify({
      providers: {
        "secret-gateway": {
          baseUrl: "https://gateway.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-control-plane-secret-9999",
          models: [{ id: "m", contextWindow: -1 }],
        },
      },
    });
    await writeFile(join(directory, "models.json"), content, "utf8");

    const { client } = await startCatalogControlPlane({ directory });
    const events: unknown[] = [];
    await client.subscribe((event) => events.push(event));

    const result = await client.executeModelsCommand({ command: "query" });
    // Schema-valid but semantically broken: the file itself is valid, so the
    // authority reports it valid and the catalog records the pinned error
    // with the Provider excluded — never a guessed repair.
    expect(result.state).toMatchObject({ revision: 0, valid: true });
    expect(result.state.catalog?.compositionErrors).toEqual([
      {
        providerId: "secret-gateway",
        message:
          'Provider secret-gateway, model m: invalid contextWindow',
      },
    ]);
    expect(
      result.state.catalog?.providers.some(
        (provider) => provider.id === "secret-gateway",
      ),
    ).toBe(false);

    // The snapshot projection and every event stay credential-free. The
    // snapshot re-merges on publish, so a successful write (carrying the
    // apiKey in its raw bytes, as the raw editor round-trips) publishes.
    const next = `{
  "providers": {
    "secret-gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-completions",
      "apiKey": "sk-control-plane-secret-9999",
      "models": [{ "id": "m" }]
    }
  }
}
`;
    const written = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: next,
    });
    expect(written.outcome).toBe("ok");
    await expect.poll(() => events.length).toBeGreaterThan(0);
    const snapshot = await client.getStatus();
    expect(snapshot.models).toMatchObject({ revision: 1, valid: true });
    expect(JSON.stringify(snapshot)).not.toContain("sk-control-plane-secret-9999");
    expect(JSON.stringify(events)).not.toContain("sk-control-plane-secret-9999");
    // The catalog in the written state stays credential-free even though
    // the raw bytes (raw editor) carry the key.
    expect(JSON.stringify(written.state.catalog)).not.toContain(
      "sk-control-plane-secret-9999",
    );
    expect(JSON.stringify(written.state.catalog)).not.toContain("apiKey");
  });

  it("queries the Radius baseline swap: only configured models compose", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-catalog-cp-"));
    roots.push(directory);

    const { client } = await startCatalogControlPlane({ directory });

    // Same-id built-in + oauth radius + baseUrl: the built-in model list is
    // swapped for the empty Radius baseline; only configured models appear.
    const written = await client.executeModelsCommand({
      command: "write_structured",
      revision: 0,
      providers: {
        anthropic: {
          baseUrl: "https://gateway.example.com",
          oauth: "radius",
          api: "anthropic-messages",
          models: [{ id: "claude-opus-4-7", contextWindow: 99999 }],
        },
      },
    });
    expect(written.outcome).toBe("ok");
    const anthropic = written.state.catalog?.providers.find(
      (provider) => provider.id === "anthropic",
    );
    expect(anthropic?.models.map((model) => model.id)).toEqual([
      "claude-opus-4-7",
    ]);
    expect(anthropic?.models[0]).toMatchObject({
      layer: "user",
      contextWindow: 99999,
      maxTokens: 16384,
      reasoning: false,
    });
    // The built-in claude models are gone.
    expect(anthropic?.models.some((model) => model.id === "claude-haiku-4-5")).toBe(false);
    expect(written.state.catalog?.compositionErrors).toEqual([]);

    // A Radius model without api has no built-in defaults: exact pinned
    // error, empty Radius fallback, no guessing.
    const broken = await client.executeModelsCommand({
      command: "write_structured",
      revision: 1,
      providers: {
        anthropic: {
          baseUrl: "https://gateway.example.com",
          oauth: "radius",
          models: [{ id: "m" }],
        },
      },
    });
    expect(broken.outcome).toBe("ok");
    expect(broken.state.catalog?.compositionErrors).toEqual([
      {
        providerId: "anthropic",
        message:
          'Provider anthropic, model m: no "api" specified. Set at provider or model level.',
      },
    ]);
    const fallback = broken.state.catalog?.providers.find(
      (provider) => provider.id === "anthropic",
    );
    expect(fallback?.models).toEqual([]);
    expect(fallback?.baseUrl).toBeUndefined();
  });

  it("keeps the invalid-file error isolation for parse and schema failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-catalog-cp-"));
    roots.push(directory);
    await writeFile(
      join(directory, "models.json"),
      '{ "providers": { "broken": { "baseUrl": 42 } } }',
      "utf8",
    );

    const { client } = await startCatalogControlPlane({ directory });

    const result = await client.executeModelsCommand({ command: "query" });
    expect(result.state).toMatchObject({ present: true, valid: false });
    expect(result.state.error?.kind).toBe("schema");
    expect(result.state.catalog).toBeUndefined();
    expect(result.state.providers).toBeUndefined();
    // The useful public error never echoes values (the dotted path may
    // contain the provider id — that is the actionable location).
    expect(result.state.error?.message).not.toContain("42");
  });
});
