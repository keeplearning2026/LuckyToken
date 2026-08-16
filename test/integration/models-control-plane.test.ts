import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type ModelsJsonFileSystem,
} from "../../src/models-config/authority.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";

/**
 * Ticket 08 public seam: the versioned Control Plane models catalog commands.
 * Every case drives the real authority against a real file in a temp
 * directory and asserts through the pipe client plus the on-disk bytes.
 */
describe("models.json through the Control Plane", () => {
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

  async function startModelsControlPlane(options: {
    readonly directory: string;
    readonly file?: string;
    readonly fileSystem?: ModelsJsonFileSystem;
  }): Promise<{
    readonly host: RunningControlPlane;
    readonly client: Awaited<ReturnType<typeof connectControlPlane>>;
    readonly path: string;
    readonly authority: ReturnType<typeof createModelsJsonAuthority>;
  }> {
    const path = options.file ?? join(options.directory, "models.json");
    const authority = createModelsJsonAuthority({
      path,
      compose: (providers) => composeEffectiveCatalog(providers),
      ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
    });
    const endpoint: ControlPlaneEndpoint = {
      pipeName: `\\\\.\\pipe\\luckytoken-models-${process.pid}-${++nextPipe}`,
      capability: "models-test-capability-0123456789012345678901",
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
      createRequestId: () => `models-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    const hello = await client.hello(1);
    if (hello.type !== "compatible") {
      throw new Error("Control Plane hello failed");
    }
    return { host, client, path, authority };
  }

  const validConfig = (): string =>
    JSON.stringify(
      {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [
              { id: "llama3.1:8b" },
              { id: "qwen2.5-coder:7b", reasoning: true, contextWindow: 65536 },
            ],
          },
        },
      },
      null,
      2,
    );

  it("queries the full state of a valid models.json file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const content = validConfig();
    await writeFile(join(directory, "models.json"), content, "utf8");

    const { client, path } = await startModelsControlPlane({ directory });

    const result = await client.executeModelsCommand({ command: "query" });
    expect(result.outcome).toBe("ok");
    expect(result.state).toMatchObject({
      revision: 0,
      path,
      present: true,
      valid: true,
      raw: content,
    });
    expect(result.state.providers).toEqual({
      ollama: {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        models: [
          { id: "llama3.1:8b" },
          {
            id: "qwen2.5-coder:7b",
            reasoning: true,
            contextWindow: 65536,
          },
        ],
      },
    });
    expect(result.state.error).toBeUndefined();
  });

  it("reports an absent models.json as an empty, valid-for-creation state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);

    const { client, path } = await startModelsControlPlane({ directory });

    const result = await client.executeModelsCommand({ command: "query" });
    expect(result.outcome).toBe("ok");
    expect(result.state).toMatchObject({
      revision: 0,
      path,
      present: false,
      valid: false,
      raw: "",
    });
    expect(result.state.providers).toBeUndefined();
    expect(result.state.error).toBeUndefined();
  });

  it("reports invalid JSON with the exact source location and keeps the bytes untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const broken =
      '{\n  "providers": {\n    "ollama": {\n      "baseUrl": "http://localhost:11434/v1",\n      "models": [\n        { "id": "llama3.1:8b" },\n        { "id": "qwen2.5-coder:7b", "reasoning": tru }\n      ]\n    }\n  }\n}';
    await writeFile(join(directory, "models.json"), broken, "utf8");

    const { client, path } = await startModelsControlPlane({ directory });

    const result = await client.executeModelsCommand({ command: "query" });
    expect(result.outcome).toBe("ok");
    expect(result.state).toMatchObject({
      revision: 0,
      path,
      present: true,
      valid: false,
      raw: broken,
    });
    const error = result.state.error;
    expect(error).toBeDefined();
    expect(error?.kind).toBe("parse");
    // The offending `tru` literal sits on line 7, column 50.
    expect(error?.location).toEqual({
      line: 7,
      column: 50,
      position: 181,
    });
    // The error message never echoes the raw content.
    expect(error?.message).not.toContain("llama3.1:8b");
    expect(error?.message).not.toContain("qwen2.5-coder");
    // The invalid file stays byte-for-byte untouched.
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      broken,
    );
  });

  it("reports schema errors with actionable dotted paths without echoing values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const content = JSON.stringify({
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [
            { id: "llama3.1:8b" },
            { name: "missing id", apiKey: "sk-SECRET-VALUE-12345" },
            { id: "bad-input", input: ["video"] },
          ],
        },
      },
    });
    await writeFile(join(directory, "models.json"), content, "utf8");

    const { client } = await startModelsControlPlane({ directory });

    const result = await client.executeModelsCommand({ command: "query" });
    expect(result.state.valid).toBe(false);
    expect(result.state.error?.kind).toBe("schema");
    expect(result.state.error?.message).toContain(
      "providers.ollama.models.1.id",
    );
    expect(result.state.error?.message).toContain(
      "providers.ollama.models.2.input.0",
    );
    // Value-free errors: the secret placed in a wrong-typed spot never leaks.
    expect(result.state.error?.message).not.toContain("SECRET");
    expect(result.state.error?.message).not.toContain("missing id");
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      content,
    );
  });

  it("accepts the pinned Pi syntax extensions: comments and trailing commas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const content =
      '{\n  // local models (pinned Pi strips comments)\n  "providers": {\n    "ollama": {\n      "baseUrl": "http://localhost:11434/v1",\n      "api": "openai-completions",\n      "models": [\n        { "id": "llama3.1:8b" },\n      ],\n    },\n  },\n}\n';
    await writeFile(join(directory, "models.json"), content, "utf8");

    const { client } = await startModelsControlPlane({ directory });

    const result = await client.executeModelsCommand({ command: "query" });
    expect(result.state).toMatchObject({ present: true, valid: true });
    expect(result.state.providers).toEqual({
      ollama: {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        models: [{ id: "llama3.1:8b" }],
      },
    });
  });

  it("reports an unreadable models.json as a load error without echoing content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const path = join(directory, "models.json");
    await writeFile(path, validConfig(), "utf8");

    const { client } = await startModelsControlPlane({
      directory,
      fileSystem: {
        readFile: async () => {
          throw Object.assign(new Error("EACCES: permission denied"), {
            code: "EACCES",
          });
        },
        writeFile: async () => undefined,
        rename: async () => undefined,
        mkdir: async () => undefined,
        rm: async () => undefined,
      },
    });

    const result = await client.executeModelsCommand({ command: "query" });
    expect(result.state).toMatchObject({ present: true, valid: false });
    expect(result.state.error?.kind).toBe("load");
    expect(result.state.error?.message).toContain("EACCES");
    expect(result.state.raw).toBe("");
  });

  it("validates a raw write before replacing and rejects invalid content without touching the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const original = validConfig();
    await writeFile(join(directory, "models.json"), original, "utf8");

    const { client } = await startModelsControlPlane({ directory });

    const invalid = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: '{ "providers": { "ollama": { "baseUrl": 42 } } }',
    });
    expect(invalid.outcome).toBe("invalid");
    expect(invalid.error?.kind).toBe("schema");
    expect(invalid.error?.message).toContain("providers.ollama.baseUrl");
    expect(invalid.error?.message).not.toContain("42");
    // The current file state is still the last valid content.
    expect(invalid.state).toMatchObject({ revision: 0, valid: true });
    // The last valid file is untouched byte-for-byte.
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      original,
    );

    const broken = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: "{ not json",
    });
    expect(broken.outcome).toBe("invalid");
    expect(broken.error?.kind).toBe("parse");
    expect(broken.error?.location).toMatchObject({ line: 1, column: 3 });
    expect(broken.error?.message).not.toContain("not json");
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      original,
    );
  });

  it("applies a valid raw write atomically, publishes the revision, and rejects stale writes with a conflict", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const original = validConfig();
    await writeFile(join(directory, "models.json"), original, "utf8");

    const { client } = await startModelsControlPlane({ directory });
    const events: unknown[] = [];
    await client.subscribe((event) => events.push(event));

    const next =
      '{\n  "providers": {\n    "ollama": {\n      "baseUrl": "http://localhost:11434/v1",\n      "api": "openai-completions",\n      "models": [\n        { "id": "llama3.1:8b", "name": "Llama 3.1 8B (Local)", "reasoning": false }\n      ]\n    }\n  }\n}\n';
    const applied = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: next,
    });
    expect(applied.outcome).toBe("ok");
    expect(applied.state).toMatchObject({ revision: 1, valid: true });
    expect(applied.state.raw).toBe(next);
    // The file on disk holds the new content.
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      next,
    );

    // The successful edit published a status event carrying the new models
    // projection (revision 1), never the raw content.
    await expect.poll(() => events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain('"revision":1');
    expect(JSON.stringify(events)).not.toContain("llama3.1:8b");
    const snapshot = await client.getStatus();
    expect(snapshot.models).toMatchObject({ revision: 1, valid: true });
    expect(JSON.stringify(snapshot)).not.toContain("llama3.1:8b");

    // A stale write (revision 0) is an explicit conflict and loses nothing.
    const stale = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: '{ "providers": { "other": { "baseUrl": "http://x", "api": "openai-completions", "models": [{ "id": "m" }] } } }',
    });
    expect(stale.outcome).toBe("conflict");
    expect(stale.state.revision).toBe(1);
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      next,
    );
  });

  it("keeps the last valid bytes when the file write itself fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const original = validConfig();
    await writeFile(join(directory, "models.json"), original, "utf8");

    const realFs = await import("node:fs/promises");
    const failingFileSystem = {
      readFile: (path: string) => realFs.readFile(path, "utf8"),
      writeFile: async (path: string, content: string) => {
        void path;
        void content;
        throw new Error("EIO: simulated disk failure");
      },
      rename: realFs.rename,
      mkdir: async (path: string) => {
        await realFs.mkdir(path, { recursive: true });
      },
      rm: realFs.rm,
    };
    const { client } = await startModelsControlPlane({
      directory,
      fileSystem: failingFileSystem,
    });

    const attempted = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: validConfig().replace("llama3.1:8b", "llama4:8b"),
    });
    expect(attempted.outcome).toBe("storage_failure");
    expect(attempted.error?.kind).toBe("storage");
    expect(attempted.error?.message).toContain("EIO");
    expect(attempted.error?.message).not.toContain("llama4");
    expect(attempted.state.revision).toBe(0);
    // The previous bytes survive the failed replacement untouched.
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      original,
    );
    // No temporary file is left behind.
    const leftovers = await realFs.readdir(directory);
    expect(leftovers).toEqual(["models.json"]);
  });

  it("keeps raw and structured editors coherent on one authoritative revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    // A raw file that carries provider and model extension data that the
    // pinned schema does not declare: the structured editor must preserve it.
    const rawContent = JSON.stringify(
      {
        providers: {
          "my-gateway": {
            baseUrl: "https://gateway.example.com/v1",
            api: "anthropic-messages",
            apiKey: "$GATEWAY_KEY",
            headers: { "x-tenant": "acme" },
            vendorExtension: { routing: ["primary", "fallback"] },
            models: [
              {
                id: "claude-sonnet",
                reasoning: true,
                contextWindow: 200000,
                vendorModelFlag: "experimental",
              },
            ],
          },
        },
      },
      null,
      2,
    );
    await writeFile(join(directory, "models.json"), rawContent, "utf8");

    const { client } = await startModelsControlPlane({ directory });

    // The structured view carries the extension fields verbatim.
    const queried = await client.executeModelsCommand({ command: "query" });
    expect(queried.state.providers).toMatchObject({
      "my-gateway": {
        vendorExtension: { routing: ["primary", "fallback"] },
        models: [{ id: "claude-sonnet", vendorModelFlag: "experimental" }],
      },
    });

    // A structured edit (drop the second header, keep extensions) succeeds
    // on the same revision and both views see the same authoritative state.
    const providers = {
      "my-gateway": {
        baseUrl: "https://gateway.example.com/v1",
        api: "anthropic-messages",
        apiKey: "$GATEWAY_KEY",
        vendorExtension: { routing: ["primary", "fallback"] },
        models: [
          {
            id: "claude-sonnet",
            reasoning: true,
            contextWindow: 200000,
            vendorModelFlag: "experimental",
          },
          {
            id: "claude-opus-4",
            reasoning: true,
            contextWindow: 400000,
            vendorModelFlag: "new",
          },
        ],
      },
    };
    const structured = await client.executeModelsCommand({
      command: "write_structured",
      revision: 0,
      providers,
    });
    expect(structured.outcome).toBe("ok");
    expect(structured.state.revision).toBe(1);
    expect(structured.state.providers).toEqual(providers);

    // The raw view of the same revision parses to the identical providers,
    // including every extension field.
    const reQueried = await client.executeModelsCommand({ command: "query" });
    expect(reQueried.state.revision).toBe(1);
    expect(reQueried.state.providers).toEqual(providers);
    expect(reQueried.state.raw).toContain("vendorExtension");
    expect(reQueried.state.raw).toContain("vendorModelFlag");
    const onDisk = JSON.parse(
      await readFile(join(directory, "models.json"), "utf8"),
    );
    expect(onDisk).toEqual({ providers });

    // The raw editor can then rewrite the same revision and the structured
    // view follows: one authoritative file, one revision stream.
    const rawRewrite = JSON.stringify({ providers }, null, 2);
    const raw = await client.executeModelsCommand({
      command: "write_raw",
      revision: 1,
      content: rawRewrite,
    });
    expect(raw.outcome).toBe("ok");
    expect(raw.state.revision).toBe(2);
    const final = await client.executeModelsCommand({ command: "query" });
    expect(final.state.providers).toEqual(providers);
    expect(final.state.raw).toBe(rawRewrite);
  });

  it("keeps query side-effect free and publishes exactly when a write mutates the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    await writeFile(join(directory, "models.json"), validConfig(), "utf8");

    const { client } = await startModelsControlPlane({ directory });
    const events: unknown[] = [];
    await client.subscribe((event) => events.push(event));

    // Reads never publish: queries must not bump the sequence or broadcast.
    const before = await client.getStatus();
    await client.executeModelsCommand({ command: "query" });
    await client.executeModelsCommand({ command: "query" });
    await expect.poll(() => events.length, { timeout: 250, interval: 25 }).toBe(0);
    expect((await client.getStatus()).sequence).toBe(before.sequence);

    // A successful raw write publishes exactly one status_changed event.
    const next =
      '{\n  "providers": {\n    "ollama": {\n      "baseUrl": "http://localhost:11434/v1",\n      "api": "openai-completions",\n      "models": [\n        { "id": "llama3.1:8b", "name": "Llama 3.1 8B (Local)" }\n      ]\n    }\n  }\n}\n';
    const rawWrite = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: next,
    });
    expect(rawWrite.outcome).toBe("ok");
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "status_changed" });
    const afterRaw = await client.getStatus();
    expect(afterRaw.sequence).toBe(before.sequence + 1);

    // A successful structured write publishes exactly one more event.
    const structured = await client.executeModelsCommand({
      command: "write_structured",
      revision: 1,
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [{ id: "llama3.1:8b" }],
        },
      },
    });
    expect(structured.outcome).toBe("ok");
    await expect.poll(() => events.length).toBe(2);

    // A byte-identical no-op write is not a mutation and must not publish.
    const current = (await client.executeModelsCommand({ command: "query" })).state;
    const noop = await client.executeModelsCommand({
      command: "write_raw",
      revision: current.revision,
      content: current.raw,
    });
    expect(noop.outcome).toBe("ok");
    expect(noop.state.revision).toBe(current.revision);
    await expect
      .poll(() => events.length, { timeout: 250, interval: 25 })
      .toBe(2);
  });

  it("creates an absent models.json from revision 0 with a structured write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);

    const { client, path } = await startModelsControlPlane({ directory });

    const queried = await client.executeModelsCommand({ command: "query" });
    expect(queried.state).toMatchObject({
      revision: 0,
      present: false,
      valid: false,
      raw: "",
    });

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
    expect(created.state).toMatchObject({ revision: 1, present: true, valid: true });
    await expect(readFile(path, "utf8")).resolves.toBe(
      '{\n  "providers": {\n    "ollama": {\n      "baseUrl": "http://localhost:11434/v1",\n      "api": "openai-completions",\n      "models": [\n        {\n          "id": "llama3.1:8b"\n        }\n      ]\n    }\n  }\n}\n',
    );
  });

  it("lets an explicit structured write repair an invalid existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const broken = '{ "providers": { "ollama": { "baseUrl": 42 } } }';
    await writeFile(join(directory, "models.json"), broken, "utf8");

    const { client } = await startModelsControlPlane({ directory });

    // A read-only query never touches the invalid bytes.
    const queried = await client.executeModelsCommand({ command: "query" });
    expect(queried.state).toMatchObject({ revision: 0, valid: false });
    expect(queried.state.error?.kind).toBe("schema");
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      broken,
    );

    // An explicit user save (CAS on the observed revision) replaces the
    // invalid file with the valid structured content.
    const repaired = await client.executeModelsCommand({
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
    expect(repaired.outcome).toBe("ok");
    expect(repaired.state).toMatchObject({ revision: 1, valid: true });
    const onDisk = JSON.parse(
      await readFile(join(directory, "models.json"), "utf8"),
    );
    expect(onDisk.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");

    // A stale write against the invalid revision still conflicts.
    const stale = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: validConfig(),
    });
    expect(stale.outcome).toBe("conflict");
  });

  it("detects external file edits as new revisions and never overwrites them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-cp-"));
    roots.push(directory);
    const original = validConfig();
    await writeFile(join(directory, "models.json"), original, "utf8");

    const { client } = await startModelsControlPlane({ directory });

    // The client observes the file at revision 0 before the edit.
    const before = await client.executeModelsCommand({ command: "query" });
    expect(before.state).toMatchObject({ revision: 0, valid: true });

    // An external editor replaces the file while the Control Plane runs.
    const external =
      '{ "providers": { "external": { "baseUrl": "http://external", "api": "openai-completions", "models": [{ "id": "ext-1" }] } } }';
    await writeFile(join(directory, "models.json"), external, "utf8");

    const queried = await client.executeModelsCommand({ command: "query" });
    expect(queried.state).toMatchObject({ revision: 1, valid: true });
    expect(queried.state.raw).toBe(external);

    // A write based on the pre-edit revision conflicts; the external bytes
    // are never overwritten.
    const stale = await client.executeModelsCommand({
      command: "write_raw",
      revision: 0,
      content: original,
    });
    expect(stale.outcome).toBe("conflict");
    await expect(readFile(join(directory, "models.json"), "utf8")).resolves.toBe(
      external,
    );
  });
});
