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
import {
  generatedDefaultAlias,
  type AliasCatalogTarget,
} from "../../src/aliases/domain.js";

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
  "my-gpt": { provider: "openai", model: "gpt-4o-mini" },
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
      catalogTargets.map((target) => generatedDefaultAlias(target)).sort(),
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
    expect(byAlias.get("my-gpt")?.layer).toBe("user");
    expect(byAlias.get("openai/gpt-4o")?.layer).toBe("default");
    // The user override suppresses the target's generated default.
    expect(byAlias.get("openai/gpt-4o-mini")).toBeUndefined();
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
      aliases: { "another": "openai/gpt-4o" },
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
        "broken": "gpt-4o", // ambiguous: no Provider named
        "ghost": { provider: "openai", model: "does-not-exist" },
      },
    });
    expect(result.outcome).toBe("invalid");
    const entries = result.error?.entries ?? [];
    expect(entries.map((entry) => entry.code)).toEqual(["ambiguous", "unknown"]);
    expect(entries.map((entry) => entry.alias)).toEqual(["broken", "ghost"]);
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
      aliases: { "ok": { provider: "openai" } },
    });
    expect(result.outcome).toBe("invalid");
    expect(result.error?.kind).toBe("validation");
    expect(result.error?.entries).toEqual([
      expect.objectContaining({ alias: "ok", code: "invalid" }),
    ]);
  });

  it("detects an external manual edit on query and bumps the revision", async () => {
    const { fileSystem, files } = memoryFileSystem();
    const { authority } = createAuthority({ fileSystem });
    await authority.query();
    files.set(
      path,
      `${JSON.stringify({ aliases: { "manual": "anthropic/claude-sonnet-4" } }, null, 2)}\n`,
    );
    const state = await authority.query();
    expect(state.revision).toBe(1);
    expect(state.aliases).toEqual({ manual: "anthropic/claude-sonnet-4" });
    expect(state.effective?.aliases.some((entry) => entry.alias === "manual")).toBe(
      true,
    );
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
      aliases: { "gpt-4o": { provider: "openai", model: "gpt-4.1" } },
    });
    const second = authority.resolver();
    expect(second.fileRevision).toBe(1);
    expect(second.resolve("gpt-4o")).toEqual({
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
      aliases: { "my-gpt": { provider: "openai", model: "gpt-4o-mini" } },
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
    expect(after.resolve("my-gpt")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("keeps a configured mapping resolvable after a catalog swap removes its target (unavailable taxonomy)", async () => {
    const { authority, setCatalog } = createAuthority();
    await authority.query();
    await authority.write({
      revision: 0,
      aliases: { "my-gpt": { provider: "openai", model: "gpt-4o-mini" } },
    });
    expect(authority.resolver().resolve("my-gpt")).toEqual({
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
    expect(after.resolve("my-gpt")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(after.resolve("openai/gpt-4o-mini")).toBeUndefined();
    expect(after.entries().map((entry) => entry.alias)).toContain("my-gpt");
  });

  it("enumerates configured mappings through entries() including generated defaults", async () => {
    const { fileSystem } = memoryFileSystem({
      [path]: `${JSON.stringify(
        {
          aliases: {
            "good": { provider: "openai", model: "gpt-4o" },
            "slash-id": { provider: "deepseek", model: "deepseek-v4-flash" },
            "broken": "no-slash-target",
            "duplicate": "openai/gpt-4o",
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
      alias: "good",
      target: { providerId: "openai", modelId: "gpt-4o" },
    });
    expect(entries).toContainEqual({
      alias: "slash-id",
      target: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
    });
    // Generated defaults for unclaimed targets are served too.
    expect(entries.map((entry) => entry.alias)).toContain("openai/gpt-4.1");
    expect(entries.map((entry) => entry.alias)).toContain(
      "anthropic/claude-opus-4-8",
    );
    expect(entries.map((entry) => entry.alias)).not.toContain("broken");
    expect(entries.map((entry) => entry.alias)).not.toContain("duplicate");
    expect(authority.resolver().resolve("broken")).toBeUndefined();
    expect(authority.resolver().resolve("duplicate")).toBeUndefined();
  });

  it("an unknown target never resolves until a valid mapping is persisted", async () => {
    const { authority, setCatalog } = createAuthority();
    await authority.query();
    await authority.write({
      revision: 0,
      aliases: { "sonnet": { provider: "anthropic", model: "claude-sonnet-5" } },
    });
    expect(authority.resolver().resolve("sonnet")).toBeUndefined();
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
    expect(authority.resolver().resolve("sonnet")).toBeUndefined();
    await authority.write({
      revision: 0,
      aliases: { "sonnet": { provider: "anthropic", model: "claude-sonnet-5" } },
    });
    expect(authority.resolver().resolve("sonnet")).toEqual({
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
    expect(before.resolve("external")).toBeUndefined();
    files.set(
      path,
      `${JSON.stringify({ aliases: { "external": "openai/gpt-4o" } }, null, 2)}\n`,
    );
    await authority.query();
    expect(authority.resolver().resolve("external")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });
});

describe("target-scoped alias mutations (Spec §15.5)", () => {
  it("setForModel replaces the generated default for one target", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const result = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      alias: "sonnet",
    });
    expect(result.outcome).toBe("ok");
    const byAlias = new Map(
      result.state.effective?.aliases.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("sonnet")).toEqual({
      alias: "sonnet",
      target: { provider: "anthropic", model: "claude-sonnet-4" },
      layer: "user",
    });
    expect(byAlias.get("anthropic/claude-sonnet-4")).toBeUndefined();
    // The file stores ONLY the override.
    expect(result.state.aliases).toEqual({
      sonnet: { provider: "anthropic", model: "claude-sonnet-4" },
    });
  });

  it("setForModel replaces an existing override for the same target", async () => {
    const { authority } = createAuthority();
    await authority.query();
    await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      alias: "sonnet",
    });
    const result = await authority.setForModel({
      revision: 1,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      alias: "claude-fast",
    });
    expect(result.outcome).toBe("ok");
    expect(result.state.aliases).toEqual({
      "claude-fast": { provider: "anthropic", model: "claude-sonnet-4" },
    });
    expect(
      result.state.effective?.aliases.some((entry) => entry.alias === "sonnet"),
    ).toBe(false);
  });

  it("setForModel fails closed for an unknown target and a stale revision", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const unknown = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-does-not-exist",
      alias: "ghost",
    });
    expect(unknown.outcome).toBe("invalid");
    expect(unknown.error?.entries?.[0]?.code).toBe("unknown");

    const stale = await authority.setForModel({
      revision: 99,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      alias: "sonnet",
    });
    expect(stale.outcome).toBe("conflict");
  });

  it("setForModel rejects a collision with another target's generated default", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const result = await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      alias: "openai/gpt-4o-mini",
    });
    expect(result.outcome).toBe("invalid");
    expect(result.error?.entries?.[0]?.code).toBe("duplicate");
    // The previous effective registry stays active.
    expect(
      authority.resolver().resolve("openai/gpt-4o-mini"),
    ).toEqual({ providerId: "openai", modelId: "gpt-4o-mini" });
    expect(authority.resolver().resolve("anthropic/claude-sonnet-4")).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  it("resetForModel restores the generated default and writes nothing when absent", async () => {
    const { authority } = createAuthority();
    await authority.query();
    await authority.setForModel({
      revision: 0,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      alias: "sonnet",
    });
    const reset = await authority.resetForModel({
      revision: 1,
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
    });
    expect(reset.outcome).toBe("ok");
    // The file is emptied (only the override was removed) and the
    // generated default is effective again.
    expect(reset.state.aliases).toEqual({});
    expect(
      reset.state.effective?.aliases.some(
        (entry) => entry.alias === "anthropic/claude-sonnet-4",
      ),
    ).toBe(true);
    // Resetting a target without an override is a no-op.
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
