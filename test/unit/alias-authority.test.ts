import { describe, expect, it } from "vitest";

import type {
  AliasCommandResult,
  AliasFileError,
} from "@luckytoken/application-control-plane/control-plane";

import {
  createAliasRegistryAuthority,
  type AliasCatalogFacts,
  type AliasRegistryAuthority,
  type AliasRegistryFileSystem,
} from "../../src/aliases/authority.js";
import type { AliasCatalogTarget } from "../../src/aliases/domain.js";

/**
 * Provider Activation Spec §23.4: the single locked, revision-checked,
 * atomic persistence/hot-apply owner of the model-aliases.json user
 * overrides. Generated `provider/model` defaults are the lower layer and
 * never persist. All tests use an in-memory file system and a no-op lock.
 */

function memoryFileSystem(initial?: Record<string, string>): {
  readonly fileSystem: AliasRegistryFileSystem;
  readonly files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const fileSystem: AliasRegistryFileSystem = {
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
  return { fileSystem, files };
}

const path = "C:\\app\\model-aliases.json";

const catalogTargets: readonly AliasCatalogTarget[] = Object.freeze([
  { provider: "openai", model: "gpt-4o" },
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "openai", model: "gpt-4.1" },
  { provider: "anthropic", model: "claude-opus-4-8" },
  { provider: "anthropic", model: "claude-sonnet-4" },
  { provider: "deepseek", model: "deepseek-v4-flash" },
  { provider: "opencode-go", model: "deepseek-v4-flash" },
]);

function knownTargets(entries: readonly [string, string][]): ReadonlySet<string> {
  return new Set(entries.map(([provider, model]) => `${provider}\u0000${model}`));
}

const catalogFacts: AliasCatalogFacts = {
  catalogVersion: 11,
  targets: catalogTargets,
  knownTargets: knownTargets(
    catalogTargets.map((target) => [target.provider, target.model] as const),
  ),
};

function createAuthority(options?: {
  readonly fileSystem?: AliasRegistryFileSystem;
  readonly files?: Record<string, string>;
  readonly catalogVersion?: number;
  readonly catalog?: AliasCatalogFacts;
}): { readonly authority: AliasRegistryAuthority; readonly setCatalog: (facts: AliasCatalogFacts) => void } {
  const fs =
    options?.fileSystem ??
    (options?.files === undefined
      ? memoryFileSystem().fileSystem
      : memoryFileSystem(options.files).fileSystem);
  let facts: AliasCatalogFacts = options?.catalog ?? {
    catalogVersion: options?.catalogVersion ?? catalogFacts.catalogVersion,
    targets: catalogTargets,
    knownTargets: catalogFacts.knownTargets,
  };
  const authority = createAliasRegistryAuthority({
    path,
    fileSystem: fs,
    lock: { acquire: async () => async () => undefined },
    catalogFacts: () => facts,
  });
  return {
    authority,
    setCatalog: (next: AliasCatalogFacts) => {
      facts = next;
    },
  };
}

/** The aliases record as it is serialized on disk by the authority. */
const userRecord = {
  "openai/my-gpt": { provider: "openai", model: "gpt-4o-mini" },
};

describe("alias registry authority persistence", () => {
  it("serves an absent file as the generated-defaults-only registry at revision 0", async () => {
    const { authority } = createAuthority();
    const state = await authority.query();
    expect(state).toMatchObject({
      revision: 0,
      path,
      present: false,
      valid: false,
      raw: "",
    });
    // Every catalog target receives its generated default; nothing is
    // persisted (the file stays absent).
    expect(state.effective?.aliases.map((entry) => entry.alias).sort()).toEqual(
      [
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
        "openai/gpt-4.1",
        "anthropic/claude-opus-4-8",
        "anthropic/claude-sonnet-4",
        "deepseek/deepseek-v4-flash",
        "opencode-go/deepseek-v4-flash",
      ].sort(),
    );
    expect(
      state.effective?.aliases.every((entry) => entry.layer === "default"),
    ).toBe(true);
    expect(state.effective?.errors).toEqual([]);
  });

  it("writes a valid user override atomically with a revision bump", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const result = await authority.write({
      revision: 0,
      aliases: userRecord,
    });
    expect(result.outcome).toBe("ok");
    expect(result.state.revision).toBe(1);
    expect(result.state.present).toBe(true);
    expect(result.state.valid).toBe(true);
    expect(result.state.aliases).toEqual(userRecord);
    const byAlias = new Map(
      result.state.effective?.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("openai/my-gpt")?.layer).toBe("user");
    expect(byAlias.get("openai/gpt-4o")?.layer).toBe("default");
    // The user override suppresses the target's generated default.
    expect(byAlias.get("openai/gpt-4o-mini")).toBeUndefined();
  });

  it("rejects a raw user override outside the target Provider namespace and keeps the generated default", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const result = await authority.write({
      revision: 0,
      aliases: {
        fast: { provider: "openai", model: "gpt-4o" },
      },
    });
    expect(result.outcome).toBe("invalid");
    expect(result.error?.entries).toEqual([
      expect.objectContaining({ alias: "fast", code: "invalid" }),
    ]);
    expect(authority.resolver().resolve("fast")).toBeUndefined();
    expect(authority.resolver().resolve("openai/gpt-4o")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });

  it("rejects a stale revision with a conflict and never touches the file", async () => {
    const { fileSystem, files } = memoryFileSystem({
      [path]: `${JSON.stringify({ aliases: userRecord }, null, 2)}\n`,
    });
    const { authority } = createAuthority({ fileSystem });
    const state = await authority.query();
    expect(state.revision).toBe(0);
    const result = await authority.write({
      revision: 99,
      aliases: { "openai/another": "openai/gpt-4o" },
    });
    expect(result.outcome).toBe("conflict");
    expect(result.state.revision).toBe(0);
    expect(files.get(path)).toBe(`${JSON.stringify({ aliases: userRecord }, null, 2)}\n`);
  });

  it("rejects an invalid proposal without replacing the active registry", async () => {
    const { authority } = createAuthority();
    await authority.write({ revision: 0, aliases: userRecord });
    const active = await authority.query();
    const result = await authority.write({
      revision: 1,
      aliases: {
        ...userRecord,
        "openai/broken": "gpt-4o", // ambiguous target: no Provider named
        "openai/ghost": { provider: "openai", model: "does-not-exist" },
      },
    });
    expect(result.outcome).toBe("invalid");
    const entries = result.error?.entries ?? [];
    expect(entries.map((entry) => entry.code)).toEqual(["ambiguous", "unknown"]);
    expect(entries.map((entry) => entry.alias)).toEqual([
      "openai/broken",
      "openai/ghost",
    ]);
    const after = await authority.query();
    expect(after.revision).toBe(active.revision);
    expect(after.aliases).toEqual(active.aliases);
    expect(after.effective).toEqual(active.effective);
  });

  it("rejects a structurally broken proposal with per-entry invalid errors", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const result = await authority.write({
      revision: 0,
      aliases: { "openai/ok": { provider: "openai" } },
    });
    expect(result.outcome).toBe("invalid");
    expect(result.error?.kind).toBe("validation");
    expect(result.error?.entries).toEqual([
      expect.objectContaining({ alias: "openai/ok", code: "invalid" }),
    ]);
  });

  it("detects an external manual edit on query and bumps the revision", async () => {
    const { fileSystem, files } = memoryFileSystem();
    const { authority } = createAuthority({ fileSystem });
    await authority.query();
    files.set(
      path,
      `${JSON.stringify({ aliases: { "anthropic/manual": "anthropic/claude-sonnet-4" } }, null, 2)}\n`,
    );
    const state = await authority.query();
    expect(state.revision).toBe(1);
    expect(state.aliases).toEqual({
      "anthropic/manual": "anthropic/claude-sonnet-4",
    });
    expect(
      state.effective?.aliases.some(
        (entry) => entry.alias === "anthropic/manual",
      ),
    ).toBe(true);
  });

  it("keeps generated defaults effective when a manually edited file is broken, with a value-free error", async () => {
    const { fileSystem, files } = memoryFileSystem();
    const { authority } = createAuthority({ fileSystem });
    await authority.query();
    files.set(path, "{ this is not json");
    const state = await authority.query();
    expect(state.valid).toBe(false);
    expect(state.error?.kind).toBe("parse");
    expect(
      state.effective?.aliases.every((entry) => entry.layer === "default"),
    ).toBe(true);
  });

  it("reports storage failures without modifying the file", async () => {
    const failing: AliasRegistryFileSystem = {
      readFile: async () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
      writeFile: async () => {
        throw new Error("disk full");
      },
      rename: async () => {
        throw new Error("disk full");
      },
      mkdir: async () => undefined,
      rm: async () => undefined,
    };
    const { authority } = createAuthority({ fileSystem: failing });
    await authority.query();
    const result = await authority.write({
      revision: 0,
      aliases: userRecord,
    });
    expect(result.outcome).toBe("storage_failure");
    expect((result.error as AliasFileError).kind).toBe("storage");
  });

  it("a successful write is a compare-and-swap under the lock", async () => {
    let acquired = 0;
    const authority = createAliasRegistryAuthority({
      path,
      fileSystem: memoryFileSystem().fileSystem,
      lock: {
        acquire: async () => {
          acquired += 1;
          return async () => undefined;
        },
      },
      catalogFacts: () => catalogFacts,
    });
    await authority.query();
    await authority.write({ revision: 0, aliases: userRecord });
    expect(acquired).toBe(1);
  });
});

describe("alias registry snapshots and hot-apply", () => {
  it("captures a resolver snapshot that in-flight work can keep", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const first = authority.resolver();
    expect(first.version).toBeGreaterThanOrEqual(1);
    expect(first.resolve("openai/gpt-4o")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
    await authority.write({
      revision: 0,
      aliases: {
        "openai/routed": { provider: "openai", model: "gpt-4.1" },
      },
    });
    const second = authority.resolver();
    expect(second.fileRevision).toBe(1);
    expect(second.resolve("openai/routed")).toEqual({
      providerId: "openai",
      modelId: "gpt-4.1",
    });
    // In-flight work keeps the captured snapshot: it never remaps.
    expect(first.resolve("openai/gpt-4o")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });

  it("recaptures on catalog snapshot swaps through onCatalogSnapshot", async () => {
    const { authority, setCatalog } = createAuthority();
    await authority.query();
    await authority.write({
      revision: 0,
      aliases: {
        "openai/my-gpt": { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    expect(authority.resolver().catalogVersion).toBe(11);
    const nextTargets: readonly AliasCatalogTarget[] = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "openai", model: "gpt-4.1" },
      { provider: "anthropic", model: "claude-opus-4-8" },
      { provider: "anthropic", model: "claude-sonnet-4" },
    ];
    setCatalog({
      catalogVersion: 12,
      targets: nextTargets,
      knownTargets: knownTargets(
        nextTargets.map((target) => [target.provider, target.model] as const),
      ),
    });
    authority.onCatalogSnapshot();
    const after = authority.resolver();
    expect(after.catalogVersion).toBe(12);
    expect(after.resolve("openai/my-gpt")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("preserves a user model name when catalog growth introduces a colliding default", async () => {
    const initialTargets: readonly AliasCatalogTarget[] = Object.freeze([
      { provider: "p", model: "a/c" },
    ]);
    const { authority, setCatalog } = createAuthority({
      catalog: {
        catalogVersion: 1,
        targets: initialTargets,
        knownTargets: knownTargets(initialTargets.map((target) => [target.provider, target.model])),
      },
    });
    await authority.query();
    const renamed = await authority.setForModel({
      revision: 0,
      providerId: "p",
      modelId: "a/c",
      modelName: "a-b",
    });
    expect(renamed.outcome).toBe("ok");
    expect(authority.resolver().resolve("p/a-b")).toEqual({
      providerId: "p",
      modelId: "a/c",
    });

    const grownTargets: readonly AliasCatalogTarget[] = Object.freeze([
      { provider: "p", model: "a/c" },
      { provider: "p", model: "a/b" },
    ]);
    setCatalog({
      catalogVersion: 2,
      targets: grownTargets,
      knownTargets: knownTargets(grownTargets.map((target) => [target.provider, target.model])),
    });
    authority.onCatalogSnapshot();

    expect(authority.resolver().resolve("p/a-b")).toEqual({
      providerId: "p",
      modelId: "a/c",
    });
    expect(authority.resolver().resolve("p/a-b-2")).toEqual({
      providerId: "p",
      modelId: "a/b",
    });
    expect(authority.resolver().entries()).toHaveLength(2);
  });

  it("keeps a configured mapping resolvable after a catalog swap removes its target (unavailable taxonomy)", async () => {
    const { authority, setCatalog } = createAuthority();
    await authority.query();
    await authority.write({
      revision: 0,
      aliases: {
        "openai/my-gpt": { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    expect(authority.resolver().resolve("openai/my-gpt")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
    const nextTargets: readonly AliasCatalogTarget[] = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4.1" },
    ];
    setCatalog({
      catalogVersion: 12,
      targets: nextTargets,
      knownTargets: knownTargets(
        nextTargets.map((target) => [target.provider, target.model] as const),
      ),
    });
    authority.onCatalogSnapshot();
    const after = authority.resolver();
    expect(after.catalogVersion).toBe(12);
    // The user override stays resolvable (model_unavailable is decided
    // against the live catalog), and its generated default disappears.
    expect(after.resolve("openai/my-gpt")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(after.resolve("openai/gpt-4o-mini")).toBeUndefined();
    expect(after.entries().map((entry) => entry.alias)).toContain(
      "openai/my-gpt",
    );
  });

  it("enumerates configured mappings through entries() including generated defaults", async () => {
    const { fileSystem } = memoryFileSystem({
      [path]: `${JSON.stringify(
        {
          aliases: {
            "openai/good": { provider: "openai", model: "gpt-4o" },
            "deepseek/slash-id": {
              provider: "deepseek",
              model: "deepseek-v4-flash",
            },
            "openai/broken": "no-slash-target",
            "openai/duplicate": "openai/gpt-4o",
          },
        },
        null,
        2,
      )}\n`,
    });
    const { authority } = createAuthority({ fileSystem });
    await authority.query();
    const entries = authority.resolver().entries();
    expect(entries).toContainEqual({
      alias: "openai/good",
      target: { providerId: "openai", modelId: "gpt-4o" },
    });
    expect(entries).toContainEqual({
      alias: "deepseek/slash-id",
      target: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
    });
    // Generated defaults for unclaimed targets are served too.
    expect(entries.map((entry) => entry.alias)).toContain("openai/gpt-4.1");
    expect(entries.map((entry) => entry.alias)).toContain(
      "anthropic/claude-opus-4-8",
    );
    expect(entries.map((entry) => entry.alias)).not.toContain("openai/broken");
    expect(entries.map((entry) => entry.alias)).not.toContain(
      "openai/duplicate",
    );
    expect(authority.resolver().resolve("openai/broken")).toBeUndefined();
    expect(authority.resolver().resolve("openai/duplicate")).toBeUndefined();
  });

  it("an unknown target never resolves until a valid mapping is persisted", async () => {
    const { authority, setCatalog } = createAuthority();
    await authority.query();
    await authority.write({
      revision: 0,
      aliases: {
        "anthropic/sonnet": {
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
      },
    });
    expect(authority.resolver().resolve("anthropic/sonnet")).toBeUndefined();
    const nextTargets: readonly AliasCatalogTarget[] = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude-sonnet-4" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ];
    setCatalog({
      catalogVersion: 12,
      targets: nextTargets,
      knownTargets: knownTargets(
        nextTargets.map((target) => [target.provider, target.model] as const),
      ),
    });
    authority.onCatalogSnapshot();
    expect(authority.resolver().resolve("anthropic/sonnet")).toBeUndefined();
    await authority.write({
      revision: 0,
      aliases: {
        "anthropic/sonnet": {
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
      },
    });
    expect(authority.resolver().resolve("anthropic/sonnet")).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
    });
  });

  it("exposes a sanitized status projection without file content", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const snapshot = authority.snapshot();
    expect(snapshot).toMatchObject({
      revision: 0,
      path,
      present: false,
      valid: false,
    });
    expect("raw" in snapshot).toBe(false);
    expect("aliases" in snapshot).toBe(false);
    expect("effective" in snapshot).toBe(false);
  });

  it("query hot-applies external edits for new request snapshots", async () => {
    const { fileSystem, files } = memoryFileSystem();
    const { authority } = createAuthority({ fileSystem });
    await authority.query();
    const before = authority.resolver();
    expect(before.resolve("openai/external")).toBeUndefined();
    files.set(
      path,
      `${JSON.stringify({ aliases: { "openai/external": "openai/gpt-4o" } }, null, 2)}\n`,
    );
    await authority.query();
    expect(authority.resolver().resolve("openai/external")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });
});

describe("target-scoped model-name mutations", () => {
  it("setForModel namespaces the user model name under the Provider", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const result = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "sonnet",
    });
    expect(result.outcome).toBe("ok");
    const byAlias = new Map(
      result.state.effective?.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("anthropic/sonnet")).toEqual({
      alias: "anthropic/sonnet",
      target: { provider: "anthropic", model: "claude-sonnet-4" },
      layer: "user",
    });
    expect(byAlias.get("anthropic/claude-sonnet-4")).toBeUndefined();
    expect(result.state.aliases).toEqual({
      "anthropic/sonnet": { provider: "anthropic", model: "claude-sonnet-4" },
    });
  });

  it("rejects model names containing '/' because the Provider separator is the only alias slash", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const result = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "team/sonnet",
    });
    expect(result.outcome).toBe("invalid");
    expect(result.error?.entries?.[0]).toMatchObject({
      alias: "anthropic/team/sonnet",
      code: "invalid",
    });
    expect(result.state.aliases).toBeUndefined();
  });

  it("setForModel replaces an existing model name for the same target", async () => {
    const { authority } = createAuthority();
    await authority.query();
    await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "sonnet",
    });
    const result = await authority.setForModel({
      revision: 1,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "claude-fast",
    });
    expect(result.outcome).toBe("ok");
    expect(result.state.aliases).toEqual({
      "anthropic/claude-fast": {
        provider: "anthropic",
        model: "claude-sonnet-4",
      },
    });
    expect(
      result.state.effective?.aliases.some(
        (entry) => entry.alias === "anthropic/sonnet",
      ),
    ).toBe(false);
  });

  it("using the canonical model id restores the generated default without persisting an override", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const result = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "claude-sonnet-4",
    });
    expect(result.outcome).toBe("ok");
    expect(result.state.aliases).toBeUndefined();
    expect(
      result.state.effective?.aliases.some(
        (entry) =>
          entry.alias === "anthropic/claude-sonnet-4" &&
          entry.layer === "default",
      ),
    ).toBe(true);
  });

  it("treats a collision-numbered default model name as derived state rather than persisting it", async () => {
    const collisionTargets: readonly AliasCatalogTarget[] = Object.freeze([
      { provider: "p", model: "a/b" },
      { provider: "p", model: "a-b" },
      { provider: "p", model: "a-b-2" },
    ]);
    const { authority } = createAuthority({
      catalog: {
        catalogVersion: 1,
        targets: collisionTargets,
        knownTargets: knownTargets(collisionTargets.map((target) => [target.provider, target.model])),
      },
    });
    await authority.query();
    const result = await authority.setForModel({
      revision: 0,
      providerId: "p",
      modelId: "a/b",
      modelName: "a-b-3",
    });
    expect(result.outcome).toBe("ok");
    expect(result.state.aliases).toBeUndefined();
    expect(result.state.effective?.aliases).toContainEqual({
      alias: "p/a-b-3",
      target: { provider: "p", model: "a/b" },
      layer: "default",
    });
  });

  it("using the canonical model id removes an existing override", async () => {
    const { authority } = createAuthority();
    await authority.query();
    await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "sonnet",
    });
    const result = await authority.setForModel({
      revision: 1,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "claude-sonnet-4",
    });
    expect(result.outcome).toBe("ok");
    expect(result.state.aliases).toEqual({});
  });

  it("rejects invalid model names, unknown targets, and stale revisions", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const invalid = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: " /bad ",
    });
    expect(invalid.outcome).toBe("invalid");

    const unknown = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-does-not-exist",
      modelName: "ghost",
    });
    expect(unknown.outcome).toBe("invalid");
    expect(unknown.error?.entries?.[0]?.code).toBe("unknown");

    const stale = await authority.setForModel({
      revision: 99,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "sonnet",
    });
    expect(stale.outcome).toBe("conflict");
  });

  it("keeps model names in Provider namespaces so names can repeat across Providers", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const anthropic = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "fast",
    });
    expect(anthropic.outcome).toBe("ok");
    const openai = await authority.setForModel({
      revision: 1,
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "fast",
    });
    expect(openai.outcome).toBe("ok");
    expect(authority.resolver().resolve("anthropic/fast")).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
    });
    expect(authority.resolver().resolve("openai/fast")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });

  it("allows a custom model name to reserve another model's generated default and renumbers that default", async () => {
    const { authority } = createAuthority();
    await authority.query();

    const result = await authority.setForModel({
      revision: 0,
      providerId: "openai",
      modelId: "gpt-4.1",
      modelName: "gpt-4o-mini",
    });

    expect(result.outcome).toBe("ok");
    expect(result.state.aliases).toEqual({
      "openai/gpt-4o-mini": { provider: "openai", model: "gpt-4.1" },
    });
    expect(authority.resolver().resolve("openai/gpt-4o-mini")).toEqual({
      providerId: "openai",
      modelId: "gpt-4.1",
    });
    expect(authority.resolver().resolve("openai/gpt-4o-mini-2")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("rejects renaming a model to another model's existing custom name in the same Provider", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const first = await authority.setForModel({
      revision: 0,
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "fast",
    });
    expect(first.outcome).toBe("ok");

    const second = await authority.setForModel({
      revision: 1,
      providerId: "openai",
      modelId: "gpt-4o-mini",
      modelName: "fast",
    });

    expect(second.outcome).toBe("invalid");
    expect(second.error?.entries).toEqual([
      expect.objectContaining({ alias: "openai/fast", code: "duplicate" }),
    ]);
    expect(second.state.revision).toBe(1);
    expect(second.state.aliases).toEqual({
      "openai/fast": { provider: "openai", model: "gpt-4o" },
    });
    expect(authority.resolver().resolve("openai/fast")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
    expect(authority.resolver().resolve("openai/gpt-4o-mini")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("resetForModel restores the generated default and writes nothing when absent", async () => {
    const { authority } = createAuthority();
    await authority.query();
    await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "sonnet",
    });
    const reset = await authority.resetForModel({
      revision: 1,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
    });
    expect(reset.outcome).toBe("ok");
    expect(reset.state.aliases).toEqual({});
    expect(
      reset.state.effective?.aliases.some(
        (entry) => entry.alias === "anthropic/claude-sonnet-4",
      ),
    ).toBe(true);
    const noop = await authority.resetForModel({
      revision: 2,
      providerId: "openai",
      modelId: "gpt-4o",
    });
    expect(noop.outcome).toBe("ok");
    expect(noop.state.revision).toBe(2);
  });
});

/** Keep the result type referenced so contract changes stay visible. */
export type { AliasCommandResult };
