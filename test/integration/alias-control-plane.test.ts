import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type AliasStatusProjection,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createAliasRegistryAuthority } from "../../src/aliases/authority.js";
import { createAliasControlPlaneHandler } from "../../src/aliases/control-plane.js";
import {
  generatedDefaultAlias,
  type AliasCatalogTarget,
} from "../../src/aliases/domain.js";

/**
 * Ticket 14 Control Plane seam: versioned alias commands and the sanitized
 * model-aliases.json status projection. Every case drives the real
 * authority through the versioned pipe client with deterministic catalog
 * snapshot facts and an in-memory file system, so the UI/CLI can observe
 * queries, compare-and-swap writes, rejections and status events without
 * any implementation internals.
 */

interface AliasPlaneFixture {
  readonly host: RunningControlPlane;
  readonly client: Awaited<ReturnType<typeof connectControlPlane>>;
  readonly authority: ReturnType<typeof createAliasRegistryAuthority>;
  readonly close: () => Promise<void>;
}

const fixtures: AliasPlaneFixture[] = [];
let nextPipe = 0;
let nextRequest = 0;

const catalogTargets: readonly AliasCatalogTarget[] = Object.freeze([
  { provider: "openai", model: "gpt-4o" },
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "openai", model: "gpt-4.1" },
  { provider: "anthropic", model: "claude-opus-4-8" },
  { provider: "anthropic", model: "claude-sonnet-4" },
  { provider: "deepseek", model: "deepseek-v4-flash" },
  { provider: "opencode-go", model: "deepseek-v4-flash" },
]);

const knownTargets = new Set(
  catalogTargets.map(
    (target) => `${target.provider}\u0000${target.model}`,
  ),
);

async function createAliasPlane(): Promise<AliasPlaneFixture> {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-alias-plane-"));
  const files = new Map<string, string>();
  const fileSystem = {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    rename: async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      files.delete(from);
      files.set(to, content);
    },
    mkdir: async () => undefined,
    rm: async (path: string) => {
      files.delete(path);
    },
  };
  const aliasesPath = join(root, "model-aliases.json");
  const authority = createAliasRegistryAuthority({
    path: aliasesPath,
    fileSystem,
    lock: { acquire: async () => async () => undefined },
    catalogFacts: () => ({
      catalogVersion: 5,
      targets: catalogTargets,
      knownTargets,
    }),
  });
  const endpoint: ControlPlaneEndpoint = {
    address: `\\\\.\\pipe\\luckytoken-alias-plane-${process.pid}-${++nextPipe}`,
    capability: "alias-plane-capability-01234567890123456",
  };
  const host = await startControlPlane({
    endpoint,
    application: { id: "luckytoken", version: "test" },
    initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
    // The exact alias command contract runServe wires (cli.ts).
    aliasCommandHandler: createAliasControlPlaneHandler(authority),
    aliasesProjection: () => authority.snapshot(),
    pipeServerFactory: createNodePipeTransport(),
    access: nodePipeFallbackAccess,
  });
  const client = await connectControlPlane(host.endpoint, {
    createRequestId: () => `alias-plane-request-${++nextRequest}`,
    pipeConnector: createNodePipeTransport(),
  });
  const hello = await client.hello(1);
  if (hello.type !== "compatible") {
    throw new Error("Control Plane hello failed");
  }
  const fixture: AliasPlaneFixture = {
    host,
    client,
    authority,
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

describe("alias commands through the Control Plane", () => {
  afterEach(async () => {
    await Promise.all(
      fixtures.splice(0).map(async (fixture) => {
        await fixture.client.close().catch(() => undefined);
        await fixture.host.close();
        await fixture.close();
      }),
    );
  });

  it("serves alias queries with the authoritative registry state", async () => {
    const fixture = await createAliasPlane();
    const result = await fixture.client.executeAliasCommand({ command: "query" });
    expect(result.outcome).toBe("ok");
    expect(result.state).toMatchObject({
      revision: 0,
      present: false,
      valid: false,
      catalogVersion: 5,
    });
    // The effective registry rides on the state: generated defaults for
    // every catalog target.
    expect(result.state.effective?.aliases.map((entry) => entry.alias).sort()).toEqual(
      catalogTargets.map((target) => generatedDefaultAlias(target)).sort(),
    );
    expect(
      result.state.effective?.aliases.every((entry) => entry.layer === "default"),
    ).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("writes a valid user mapping with compare-and-swap and hot-applies it", async () => {
    const fixture = await createAliasPlane();
    const write = await fixture.client.executeAliasCommand({
      command: "write",
      revision: 0,
      aliases: { "my-gpt": { provider: "openai", model: "gpt-4o-mini" } },
    });
    expect(write.outcome).toBe("ok");
    expect(write.state.revision).toBe(1);
    const byAlias = new Map(
      write.state.effective?.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("my-gpt")?.layer).toBe("user");
    // The captured resolver hot-applies for new request snapshots.
    expect(fixture.authority.resolver().resolve("my-gpt")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
    // A stale revision is a conflict, never an overwrite.
    const conflict = await fixture.client.executeAliasCommand({
      command: "write",
      revision: 0,
      aliases: { "other": "openai/gpt-4o" },
    });
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.state.revision).toBe(1);
  });

  it("rejects invalid proposals with distinguished errors and keeps the active registry", async () => {
    const fixture = await createAliasPlane();
    await fixture.client.executeAliasCommand({
      command: "write",
      revision: 0,
      aliases: { "keep": { provider: "openai", model: "gpt-4o-mini" } },
    });
    const before = await fixture.client.executeAliasCommand({ command: "query" });
    const rejected = await fixture.client.executeAliasCommand({
      command: "write",
      revision: 1,
      aliases: {
        "keep": { provider: "openai", model: "gpt-4o-mini" },
        "bare": "gpt-4o",
        "ghost": { provider: "openai", model: "missing" },
        "dup": "openai/gpt-4o-mini",
        "": { provider: "openai", model: "gpt-4o" },
      },
    });
    expect(rejected.outcome).toBe("invalid");
    const entries = rejected.error?.entries ?? [];
    expect(entries.map((entry) => entry.code)).toEqual([
      "ambiguous",
      "unknown",
      "duplicate",
      "invalid",
    ]);
    expect(entries.map((entry) => entry.alias)).toEqual(["bare", "ghost", "dup", ""]);
    // The active registry was not replaced.
    const after = await fixture.client.executeAliasCommand({ command: "query" });
    expect(after.state.revision).toBe(before.state.revision);
    expect(after.state.aliases).toEqual(before.state.aliases);
    expect(after.state.effective).toEqual(before.state.effective);
  });

  it("merges the sanitized aliases projection into status snapshots", async () => {
    const fixture = await createAliasPlane();
    const status = await fixture.client.getStatus();
    expect(status.aliases).toMatchObject({
      revision: 0,
      present: false,
      valid: false,
    });
    expect("raw" in (status.aliases as AliasStatusProjection)).toBe(false);
    await fixture.client.executeAliasCommand({
      command: "write",
      revision: 0,
      aliases: { "a": "openai/gpt-4o" },
    });
    const after = await fixture.client.getStatus();
    expect(after.aliases?.revision).toBe(1);
    expect(after.aliases?.present).toBe(true);
    expect(after.aliases?.valid).toBe(true);
  });

  it("set_for_model and reset_for_model round-trip through the typed wire", async () => {
    const fixture = await createAliasPlane();
    const set = await fixture.client.executeAliasCommand({
      command: "set_for_model",
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      alias: "sonnet",
    });
    expect(set.outcome).toBe("ok");
    expect(set.state.revision).toBe(1);
    const byAlias = new Map(
      set.state.effective?.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("sonnet")?.layer).toBe("user");
    expect(byAlias.get("anthropic/claude-sonnet-4")).toBeUndefined();

    const reset = await fixture.client.executeAliasCommand({
      command: "reset_for_model",
      revision: 1,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
    });
    expect(reset.outcome).toBe("ok");
    const afterReset = new Map(
      reset.state.effective?.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(afterReset.get("anthropic/claude-sonnet-4")?.layer).toBe("default");
    expect(afterReset.get("sonnet")).toBeUndefined();

    // An unknown target fails closed with a validation error.
    const unknown = await fixture.client.executeAliasCommand({
      command: "set_for_model",
      revision: 2,
      providerId: "anthropic",
      modelId: "not-a-model",
      alias: "ghost",
    });
    expect(unknown.outcome).toBe("invalid");
    expect(unknown.error?.entries?.[0]?.code).toBe("unknown");
  });

  it("publishes a status event when a write changes the authoritative revision", async () => {
    const fixture = await createAliasPlane();
    const events: Array<{
      readonly sequence: number;
      readonly aliases?: AliasStatusProjection;
    }> = [];
    await fixture.client.subscribe((event) => {
      events.push({
        sequence: event.sequence,
        ...(event.snapshot.aliases === undefined
          ? {}
          : { aliases: event.snapshot.aliases }),
      });
    });
    await fixture.client.executeAliasCommand({
      command: "write",
      revision: 0,
      aliases: { "a": "openai/gpt-4o" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.some((event) => event.aliases?.revision === 1)).toBe(true);
  });

  it("rejects malformed alias commands through the wire", async () => {
    const fixture = await createAliasPlane();
    const transport = createNodePipeTransport();
    const raw = await transport.connect(fixture.host.endpoint.address);
    await raw.write(
      encodeRawFrame({
        type: "hello",
        requestId: "raw-alias-hello",
        contractVersion: 1,
        capability: fixture.host.endpoint.capability,
      }),
    );
    expect(await readRawFrame(raw)).toMatchObject({
      type: "hello_result",
      result: { type: "compatible" },
    });
    // A write without a revision is rejected before reaching the handler.
    await raw.write(
      encodeRawFrame({
        type: "alias_command",
        requestId: "bad-revision",
        command: { command: "write", aliases: {} },
      }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "bad-revision",
      code: "invalid_request",
    });
    // A non-object command is rejected.
    await raw.write(
      encodeRawFrame({
        type: "alias_command",
        requestId: "bad-shape",
        command: "garbage",
      }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "bad-shape",
      code: "invalid_request",
    });
    // A valid query succeeds on the same connection.
    await raw.write(
      encodeRawFrame({
        type: "alias_command",
        requestId: "good-query",
        command: { command: "query" },
      }),
    );
    const result = await readRawFrame(raw);
    expect(result).toMatchObject({
      type: "alias_command_result",
      requestId: "good-query",
      result: { outcome: "ok" },
    });
    await raw.close();
  });
});

function encodeRawFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function readExact(
  connection: Awaited<ReturnType<ReturnType<typeof createNodePipeTransport>["connect"]>>,
  byteLength: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let received = 0;
  while (received < byteLength) {
    const chunk = await connection.read(byteLength - received);
    if (chunk === null) return null;
    chunks.push(chunk);
    received += chunk.length;
  }
  return Buffer.concat(chunks);
}

async function readRawFrame(
  connection: Awaited<ReturnType<ReturnType<typeof createNodePipeTransport>["connect"]>>,
): Promise<unknown> {
  const header = await readExact(connection, 4);
  if (header === null) return undefined;
  const body = await readExact(connection, header.readUInt32BE(0));
  return body === null ? undefined : JSON.parse(body.toString("utf8"));
}
