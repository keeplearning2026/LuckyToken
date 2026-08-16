import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AliasCommandResult,
  AliasFileError,
  AliasFileState,
  AliasStatusProjection,
  EffectiveAliasRegistryProjection,
} from "@luckytoken/application-control-plane/control-plane";
import lockfile from "proper-lockfile";

import { stripJsonComments } from "../providers/models-json-schema.js";
import { curatedAliasDefaults, CURATED_ALIAS_DEFAULTS_VERSION } from "./defaults.js";
import {
  computeConfiguredAliasMappings,
  computeEffectiveAliasRegistry,
  type CuratedAliasDefault,
} from "./domain.js";

/**
 * Ticket 14 model-aliases.json authority — the ONE locked, revision-checked,
 * atomic persistence and hot-apply owner of the global alias mapping.
 *
 * The file at `path` is the transparent, manually editable user authority
 * (it stores ONLY explicit user mappings; curated defaults live in the
 * lower layer and never enter the file). Every command re-reads the file so
 * external edits become visible immediately; every successful write
 * validates first, takes the file lock, re-checks the on-disk bytes against
 * the revision the client was served, and replaces the file atomically via
 * a temporary file and rename. Failed or stale writes never modify the
 * file, so an invalid, ambiguous, unknown or duplicate proposal never
 * replaces the active registry.
 *
 * Effective registry: computed deterministically from the parsed user
 * mappings over the curated defaults, validated against the authoritative
 * Ticket 11 catalog snapshot facts injected by the composition. A broken
 * file contributes no user mappings (never a guessed repair) and defaults
 * remain effective.
 *
 * Snapshots / hot-apply: the authority captures a frozen resolver snapshot
 * whenever the effective registry or its facts change (successful write,
 * externally observed edit, catalog snapshot swap). New requests resolve
 * through the captured snapshot; in-flight work keeps the snapshot it
 * captured and is never remapped.
 */

export interface AliasRegistryFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
}

/** Test seam at the file-system boundary; the default is the node fs. */
const nodeFileSystem: AliasRegistryFileSystem = Object.freeze({
  readFile: (path: string) => readFile(path, "utf8"),
  writeFile: (path: string, content: string) =>
    writeFile(path, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
  rename,
  mkdir: async (path: string) => {
    await mkdir(path, { recursive: true });
  },
  rm: (path: string) => rm(path, { force: true }),
});

export interface AliasRegistryLock {
  acquire(path: string): Promise<() => Promise<void>>;
}

const lockStaleMs = 30_000;

function createNodeLock(): AliasRegistryLock {
  return Object.freeze({
    async acquire(path: string): Promise<() => Promise<void>> {
      let compromised: Error | undefined;
      try {
        const release = await lockfile.lock(path, {
          realpath: false,
          retries: { retries: 20, minTimeout: 20, maxTimeout: 250 },
          stale: lockStaleMs,
          onCompromised: (error) => {
            compromised = error;
          },
        });
        if (compromised !== undefined) {
          await release().catch(() => undefined);
          throw new Error("model-aliases.json lock ownership was compromised");
        }
        return release;
      } catch (error) {
        if (compromised !== undefined) throw compromised;
        throw error;
      }
    },
  });
}

/** Authoritative Ticket 11 catalog snapshot facts for alias validation. */
export interface AliasCatalogFacts {
  readonly catalogVersion: number;
  /** Canonical `provider\u0000model` keys present in the active snapshot. */
  readonly knownTargets: ReadonlySet<string>;
}

export interface AliasRegistryAuthorityOptions {
  readonly path: string;
  /** Curated defaults lower layer; defaults to the shipped set. */
  readonly defaults?: readonly CuratedAliasDefault[];
  /** Defaults generation; defaults to the shipped version. */
  readonly defaultsVersion?: number;
  /** Live authoritative Ticket 11 catalog snapshot facts. */
  readonly catalogFacts: () => AliasCatalogFacts;
  readonly fileSystem?: AliasRegistryFileSystem;
  readonly lock?: AliasRegistryLock;
}

/** The captured resolver snapshot: frozen at capture time, served to new
 *  requests; in-flight work keeps the snapshot it captured. */
export interface AliasResolverSnapshot {
  /** Monotonic capture sequence. */
  readonly version: number;
  /** Catalog snapshot version the captured registry was validated against. */
  readonly catalogVersion: number;
  /** File revision the captured user mappings came from. */
  readonly fileRevision: number;
  /** Curated defaults generation in effect. */
  readonly defaultsVersion: number;
  /** Resolve one configured alias to its canonical target, or undefined.
   *  The mapping is catalog-independent: a configured alias whose target
   *  left the active catalog still resolves here, and the data plane
   *  decides `model_unavailable` against the live catalog (Ticket 15). */
  resolve(alias: string): { readonly providerId: string; readonly modelId: string } | undefined;
  /** Every configured alias with its canonical target (frozen). */
  entries(): ReadonlyArray<{
    readonly alias: string;
    readonly target: { readonly providerId: string; readonly modelId: string };
  }>;
}

export interface AliasRegistryAuthority {
  /** Current authoritative state; refreshes from disk first and hot-applies
   *  observed changes for new request snapshots. */
  query(): Promise<AliasFileState>;
  /** Compare-and-swap structured write over the user mapping record. */
  write(input: {
    readonly revision: number;
    readonly aliases: Readonly<Record<string, unknown>>;
  }): Promise<AliasCommandResult>;
  /** Sanitized projection for status snapshots (never refreshes). */
  snapshot(): AliasStatusProjection;
  /** Recompute and hot-apply after a catalog snapshot swap (Ticket 11
   *  composition hook); never touches the file. */
  onCatalogSnapshot(): void;
  /** The captured resolver snapshot (the narrow Ticket 15 seam). */
  resolver(): AliasResolverSnapshot;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level shape of the transparent user file: exactly one key
 *  `aliases` holding the user mapping record. */
function validateFileShape(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return "model-aliases.json must contain a JSON object with a single \"aliases\" record.";
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "aliases") {
    return "model-aliases.json must contain exactly the \"aliases\" record.";
  }
  if (!isRecord(parsed.aliases)) {
    return "\"aliases\" must be an object mapping aliases to canonical targets.";
  }
  return undefined;
}

/** Parse with the same comment/trailing-comma syntax as models.json and
 *  turn syntax failures into value-free parse errors. */
function parseFileText(text: string):
  | { readonly parsed: unknown }
  | { readonly error: AliasFileError } {
  const stripped = stripJsonComments(text);
  try {
    return { parsed: JSON.parse(stripped) };
  } catch (error) {
    return {
      error: {
        kind: "parse",
        message: `model-aliases.json is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}

export function createAliasRegistryAuthority(
  options: AliasRegistryAuthorityOptions,
): AliasRegistryAuthority {
  const path = options.path;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const lock = options.lock ?? createNodeLock();
  const defaults = options.defaults ?? curatedAliasDefaults;
  const defaultsVersion = options.defaultsVersion ?? CURATED_ALIAS_DEFAULTS_VERSION;
  const catalogFacts = options.catalogFacts;
  let current: AliasFileState = Object.freeze({
    revision: 0,
    path,
    present: false,
    valid: false,
    raw: "",
    defaultsVersion,
    catalogVersion: 0,
  });
  // On-disk facts the served state was derived from; used to detect external
  // edits that should bump the revision.
  let diskRaw = "";
  let diskPresent = false;
  let refreshed = false;
  // The frozen resolver snapshot: capture sequence, facts, and a resolve
  // closure over the captured effective registry.
  let capturedVersion = 0;
  let capturedFacts = {
    catalogVersion: -1,
    fileRevision: -1,
    defaultsVersion: -1,
    registry: undefined as EffectiveAliasRegistryProjection | undefined,
  };
  let resolver: AliasResolverSnapshot = Object.freeze({
    version: 0,
    catalogVersion: 0,
    fileRevision: 0,
    defaultsVersion,
    resolve: () => undefined,
    entries: () => Object.freeze([]),
  });

  const effectiveFor = (
    userAliases: Readonly<Record<string, unknown>>,
    facts: AliasCatalogFacts,
  ): EffectiveAliasRegistryProjection =>
    computeEffectiveAliasRegistry({
      userAliases,
      defaults,
      defaultsVersion,
      catalogVersion: facts.catalogVersion,
      knownTargets: facts.knownTargets,
    });

  /** Recompute against the current catalog facts and hot-apply a frozen
   *  resolver snapshot when anything changed. */
  const recapture = (state: AliasFileState): void => {
    const facts = catalogFacts();
    const registry = effectiveFor(
      state.present && state.valid && state.aliases !== undefined
        ? state.aliases
        : {},
      facts,
    );
    const changed =
      capturedFacts.catalogVersion !== facts.catalogVersion ||
      capturedFacts.fileRevision !== state.revision ||
      capturedFacts.defaultsVersion !== state.defaultsVersion ||
      capturedFacts.registry === undefined ||
      JSON.stringify(capturedFacts.registry) !== JSON.stringify(registry);
    if (!changed) return;
    // The resolver serves the catalog-independent configured mappings: a
    // configured alias whose target left the active catalog still resolves
    // (Ticket 15 `model_unavailable`), while the control-plane registry
    // keeps reporting the out-of-catalog validation error.
    const configured = computeConfiguredAliasMappings({
      userAliases:
        state.present && state.valid && state.aliases !== undefined
          ? state.aliases
          : {},
      defaults,
    });
    const frozenTargets = new Map<
      string,
      { readonly providerId: string; readonly modelId: string }
    >();
    for (const [alias, target] of configured) {
      frozenTargets.set(
        alias,
        Object.freeze({ providerId: target.provider, modelId: target.model }),
      );
    }
    const entries = Object.freeze(
      [...frozenTargets].map(([alias, target]) =>
        Object.freeze({ alias, target }),
      ),
    );
    capturedVersion += 1;
    capturedFacts = {
      catalogVersion: facts.catalogVersion,
      fileRevision: state.revision,
      defaultsVersion: state.defaultsVersion,
      registry,
    };
    resolver = Object.freeze({
      version: capturedVersion,
      catalogVersion: facts.catalogVersion,
      fileRevision: state.revision,
      defaultsVersion: state.defaultsVersion,
      resolve: (alias: string) => frozenTargets.get(alias),
      entries: () => entries,
    });
  };

  const buildState = (
    revision: number,
    raw: string,
    present: boolean,
    readError: unknown | undefined,
  ): AliasFileState => {
    const facts = catalogFacts();
    const base = {
      revision,
      path,
      present,
      valid: false,
      raw,
      defaultsVersion,
      catalogVersion: facts.catalogVersion,
    };
    if (!present) {
      const state = Object.freeze({
        ...base,
        effective: effectiveFor({}, facts),
      });
      recapture(state);
      return state;
    }
    if (readError !== undefined) {
      const state = Object.freeze({
        ...base,
        error: {
          kind: "load" as const,
          message: `Failed to read model-aliases.json: ${
            readError instanceof Error ? readError.message : String(readError)
          }`,
        },
        effective: effectiveFor({}, facts),
      });
      recapture(state);
      return state;
    }
    const parsedResult = parseFileText(raw);
    if ("error" in parsedResult) {
      const state = Object.freeze({
        ...base,
        error: parsedResult.error,
        effective: effectiveFor({}, facts),
      });
      recapture(state);
      return state;
    }
    const shapeError = validateFileShape(parsedResult.parsed);
    if (shapeError !== undefined) {
      const state = Object.freeze({
        ...base,
        error: { kind: "schema" as const, message: shapeError },
        effective: effectiveFor({}, facts),
      });
      recapture(state);
      return state;
    }
    const aliases = (parsedResult.parsed as { readonly aliases: Record<string, unknown> })
      .aliases;
    const state = Object.freeze({
      ...base,
      valid: true,
      aliases: Object.freeze(aliases),
      effective: effectiveFor(aliases, facts),
    });
    recapture(state);
    return state;
  };

  const refresh = async (): Promise<AliasFileState> => {
    let raw: string;
    let present = true;
    let readError: unknown;
    try {
      raw = await fileSystem.readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        present = false;
        raw = "";
      } else {
        raw = "";
        readError = error;
      }
    }
    if (refreshed && present === diskPresent && raw === diskRaw) {
      // The file is unchanged, but the catalog snapshot may have moved:
      // recompute against the current facts (no revision bump).
      const facts = catalogFacts();
      if (current.catalogVersion !== facts.catalogVersion) {
        const registry = effectiveFor(
          current.present && current.valid && current.aliases !== undefined
            ? current.aliases
            : {},
          facts,
        );
        current = Object.freeze({
          ...current,
          catalogVersion: facts.catalogVersion,
          effective: registry,
        });
        recapture(current);
      }
      return current;
    }
    const firstObservation = !refreshed;
    refreshed = true;
    diskPresent = present;
    diskRaw = raw;
    const next = buildState(current.revision, raw, present, readError);
    if (firstObservation) {
      current = next;
    } else if (next.present !== current.present || next.raw !== current.raw) {
      current = Object.freeze({ ...next, revision: current.revision + 1 });
      // The revision changed the captured facts: hot-apply for new requests.
      recapture(current);
    } else {
      current = next;
    }
    return current;
  };

  const serialized = (
    aliases: Readonly<Record<string, unknown>>,
  ): string => `${JSON.stringify({ aliases }, null, 2)}\n`;

  const commit = async (
    base: AliasFileState,
    nextRaw: string,
    aliases: Readonly<Record<string, unknown>>,
  ): Promise<AliasCommandResult> => {
    try {
      await fileSystem.mkdir(dirname(path));
    } catch (error) {
      return Object.freeze({
        outcome: "storage_failure" as const,
        state: current,
        error: {
          kind: "storage" as const,
          message: `Failed to create the model-aliases.json directory: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock.acquire(path);
    } catch (error) {
      return Object.freeze({
        outcome: "storage_failure" as const,
        state: current,
        error: {
          kind: "storage" as const,
          message: `Failed to lock model-aliases.json: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      // The disk must still hold exactly what the client was served for its
      // revision; an external edit racing the write is a conflict, never an
      // overwrite.
      let diskContent: string;
      let present = true;
      try {
        diskContent = await fileSystem.readFile(path);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          present = false;
          diskContent = "";
        } else {
          throw error;
        }
      }
      if (present !== base.present || diskContent !== base.raw) {
        await refresh();
        return Object.freeze({
          outcome: "conflict" as const,
          state: current,
        });
      }
      await fileSystem.writeFile(temporaryPath, nextRaw);
      await fileSystem.rename(temporaryPath, path);
    } catch (error) {
      await fileSystem.rm(temporaryPath).catch(() => undefined);
      return Object.freeze({
        outcome: "storage_failure" as const,
        state: current,
        error: {
          kind: "storage" as const,
          message: `Failed to write model-aliases.json: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } finally {
      await release().catch(() => undefined);
    }
    diskRaw = nextRaw;
    diskPresent = true;
    const facts = catalogFacts();
    const next = Object.freeze({
      // Monotonic even when an external edit/revert raced the write.
      revision: Math.max(current.revision, base.revision) + 1,
      path,
      present: true,
      valid: true,
      raw: nextRaw,
      defaultsVersion,
      catalogVersion: facts.catalogVersion,
      aliases: Object.freeze(aliases),
      effective: effectiveFor(aliases, facts),
    });
    current = next;
    recapture(current);
    return Object.freeze({ outcome: "ok" as const, state: next });
  };

  return Object.freeze({
    async query(): Promise<AliasFileState> {
      return refresh();
    },
    async write(input: {
      readonly revision: number;
      readonly aliases: Readonly<Record<string, unknown>>;
    }): Promise<AliasCommandResult> {
      await refresh();
      if (input.revision !== current.revision) {
        return Object.freeze({ outcome: "conflict", state: current });
      }
      const facts = catalogFacts();
      const registry = effectiveFor(input.aliases, facts);
      // A proposal is rejected when a USER-owned entry fails validation
      // (invalid, ambiguous, unknown, or duplicate against another user
      // entry). Errors that only demote a curated default (the user takes
      // its canonical target) are legitimate: user mappings always win.
      const userErrors = registry.errors.filter((entry) =>
        Object.hasOwn(input.aliases, entry.alias),
      );
      if (userErrors.length > 0) {
        return Object.freeze({
          outcome: "invalid",
          state: current,
          error: {
            kind: "validation" as const,
            message: `The alias proposal was rejected: ${userErrors.length} entry${
              userErrors.length === 1 ? "" : "ies"
            } cannot map to a canonical target.`,
            entries: Object.freeze([...userErrors]),
          },
        });
      }
      const nextRaw = serialized(input.aliases);
      if (current.present && nextRaw === current.raw) {
        // Byte-identical write: no file change, no revision bump.
        return Object.freeze({ outcome: "ok", state: current });
      }
      return commit(current, nextRaw, Object.freeze({ ...input.aliases }));
    },
    snapshot(): AliasStatusProjection {
      const { revision, path: filePath, present, valid, error, defaultsVersion: version } =
        current;
      return Object.freeze({
        revision,
        path: filePath,
        present,
        valid,
        defaultsVersion: version,
        ...(error === undefined ? {} : { error }),
      });
    },
    onCatalogSnapshot(): void {
      // Recompute against the current facts; recapture when the effective
      // registry or its facts changed.
      recapture(current);
    },
    resolver(): AliasResolverSnapshot {
      return resolver;
    },
  });
}
