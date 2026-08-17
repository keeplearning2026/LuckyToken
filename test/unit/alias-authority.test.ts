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
import { curatedAliasDefaults } from "../../src/aliases/defaults.js";

/**
 * Ticket 14 authority seam: the single locked, revision-checked, atomic
 * persistence/hot-apply owner of the model-aliases.json user mappings. All
 * tests use an in-memory file system and a no-op lock (the locking
 * semantics are injected and exercised through the CAS + atomic-replace
 * contract); catalog facts are deterministic fixtures.
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

function knownTargets(entries: readonly [string, string][]): ReadonlySet<string> {
  return new Set(entries.map(([provider, model]) => `${provider}\u0000${model}`));
}

const catalogFacts = {
  catalogVersion: 11,
  knownTargets: knownTargets([
    ["openai", "gpt-4o"],
    ["openai", "gpt-4o-mini"],
    ["openai", "gpt-4.1"],
    ["anthropic", "claude-opus-4-8"],
    ["anthropic", "claude-sonnet-4"],
    ["deepseek", "deepseek-v4-flash"],
    ["opencode-go", "deepseek-v4-flash"],
  ]),
};

function createAuthority(options?: {
  readonly fileSystem?: AliasRegistryFileSystem;
  readonly files?: Record<string, string>;
  readonly catalogVersion?: number;
  readonly catalog?: AliasCatalogFacts;
}): { readonly authority: AliasRegistryAuthority; readonly setCatalog: (facts: AliasCatalogFacts) => void } {
  const memory = options?.fileSystem === undefined ? undefined : options.fileSystem;
  const fs =
    memory ??
    (options?.files === undefined
      ? memoryFileSystem().fileSystem
      : memoryFileSystem(options.files).fileSystem);
  let facts: AliasCatalogFacts = options?.catalog ?? {
    catalogVersion: options?.catalogVersion ?? catalogFacts.catalogVersion,
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
  it("serves an absent file as the defaults-only registry at revision 0", async () => {
    const { authority } = createAuthority();
    const state = await authority.query();
    expect(state).toMatchObject({
      revision: 0,
      path,
      present: false,
      valid: false,
      raw: "",
      defaultsVersion: 2,
    });
    // The effective registry is the curated defaults layer.
    expect(state.effective?.aliases.map((entry) => entry.alias)).toEqual(
      curatedAliasDefaults.map((entry) => entry.alias),
    );
    expect(state.effective?.aliases.every((entry) => entry.layer === "default")).toBe(
      true,
    );
  });

  it("writes a valid user mapping atomically with a revision bump", async () => {
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
    expect(byAlias.get("gpt-4o")?.layer).toBe("default");
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
    // The on-disk bytes are untouched.
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
    // The rejection names exactly the failing USER entries (a demoted
    // curated default or a default that is unknown in the catalog is a
    // registry fact, not a proposal failure).
    const entries = result.error?.entries ?? [];
    expect(entries.map((entry) => entry.code)).toEqual(["ambiguous", "unknown"]);
    expect(entries.map((entry) => entry.alias)).toEqual(["broken", "ghost"]);
    // The active registry was not replaced.
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
    // The user edits the transparent file by hand.
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

  it("keeps defaults effective when a manually edited file is broken, with a value-free error", async () => {
    const { fileSystem, files } = memoryFileSystem();
    const { authority } = createAuthority({ fileSystem });
    await authority.query();
    files.set(path, "{ this is not json");
    const state = await authority.query();
    expect(state.valid).toBe(false);
    expect(state.error?.kind).toBe("parse");
    // Defaults still apply; no user mapping is guessed.
    expect(state.effective?.aliases.every((entry) => entry.layer === "default")).toBe(
      true,
    );
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
    // Every mutation takes the file lock before the atomic replace.
    expect(acquired).toBe(1);
  });
});

describe("alias registry snapshots and hot-apply", () => {
  it("captures a resolver snapshot that in-flight work can keep", async () => {
    const { authority } = createAuthority();
    await authority.query();
    const first = authority.resolver();
    expect(first.version).toBeGreaterThanOrEqual(1);
    expect(first.resolve("gpt-4o")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
    await authority.write({
      revision: 0,
      aliases: { "gpt-4o": { provider: "openai", model: "gpt-4.1" } },
    });
    // New requests capture the hot-applied registry.
    const second = authority.resolver();
    expect(second.fileRevision).toBe(1);
    expect(second.resolve("gpt-4o")).toEqual({
      providerId: "openai",
      modelId: "gpt-4.1",
    });
    // In-flight work keeps the captured snapshot: it never remaps.
    expect(first.resolve("gpt-4o")).toEqual({
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
    // A catalog swap moves to a new snapshot version; the composition hook
    // hot-applies for new request snapshots.
    setCatalog({
      catalogVersion: 12,
      knownTargets: knownTargets([
        ["openai", "gpt-4o"],
        ["openai", "gpt-4o-mini"],
        ["openai", "gpt-4.1"],
        ["anthropic", "claude-opus-4-8"],
        ["anthropic", "claude-sonnet-4"],
      ]),
    });
    authority.onCatalogSnapshot();
    const after = authority.resolver();
    expect(after.catalogVersion).toBe(12);
    expect(after.resolve("my-gpt")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("keeps a configured mapping resolvable after a catalog swap removes its target (Ticket 15 unavailable taxonomy)", async () => {
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
    // A catalog swap drops the mapped target: the control-plane effective
    // registry reports the validation error, but the data plane resolver
    // keeps the configured mapping so requests can render the distinct
    // model_unavailable result against the live catalog.
    setCatalog({
      catalogVersion: 12,
      knownTargets: knownTargets([
        ["openai", "gpt-4o"],
        ["openai", "gpt-4.1"],
      ]),
    });
    authority.onCatalogSnapshot();
    const after = authority.resolver();
    expect(after.catalogVersion).toBe(12);
    expect(after.resolve("my-gpt")).toEqual({
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(after.entries().map((entry) => entry.alias)).toContain("my-gpt");
  });

  it("enumerates configured mappings through entries() including catalog-absent targets", async () => {
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
    // Valid user mappings are enumerated (including a slash-bearing model
    // id); malformed targets and duplicate claims never enter the map.
    expect(entries).toContainEqual({
      alias: "good",
      target: { providerId: "openai", modelId: "gpt-4o" },
    });
    expect(entries).toContainEqual({
      alias: "slash-id",
      target: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
    });
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
    // Unknown in the current snapshot: the write was rejected, the entry
    // never became effective, and the resolver never serves it.
    expect(authority.resolver().resolve("sonnet")).toBeUndefined();
    // A catalog refresh that serves the model does NOT resurrect a
    // rejected mapping: the file never changed (the write was rejected).
    setCatalog({
      catalogVersion: 12,
      knownTargets: knownTargets([
        ["openai", "gpt-4o"],
        ["anthropic", "claude-sonnet-4"],
        ["anthropic", "claude-sonnet-5"],
      ]),
    });
    authority.onCatalogSnapshot();
    expect(authority.resolver().resolve("sonnet")).toBeUndefined();
    // After the proposal is submitted again against the new snapshot, the
    // mapping becomes effective for new request snapshots.
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
      defaultsVersion: 2,
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

describe("curated defaults hygiene", () => {
  it("defaults are well-formed, unique and collision-free", () => {
    const aliases = new Set<string>();
    const targets = new Set<string>();
    for (const entry of curatedAliasDefaults) {
      expect(entry.alias.length).toBeGreaterThan(0);
      expect(entry.alias.trim()).toBe(entry.alias);
      expect(entry.alias.includes("/")).toBe(false);
      expect(entry.provider.length).toBeGreaterThan(0);
      expect(entry.model.length).toBeGreaterThan(0);
      expect(aliases.has(entry.alias)).toBe(false);
      expect(targets.has(`${entry.provider}\u0000${entry.model}`)).toBe(false);
      aliases.add(entry.alias);
      targets.add(`${entry.provider}\u0000${entry.model}`);
    }
  });
});

/** Keep the result type referenced so contract changes stay visible. */
export type { AliasCommandResult };
