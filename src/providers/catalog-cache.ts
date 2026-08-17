import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import type {
  Api,
  Model,
  ModelsStore,
  ModelsStoreEntry,
} from "@earendil-works/pi-ai";

/**
 * Ticket 11 validated dynamic catalog cache (LuckyToken-owned).
 *
 * The cache is the pi-ai `ModelsStore` seam for the data plane: providers
 * with dynamic model refresh (`refreshModels`) publish their catalog facts
 * through it and restore them at startup, exactly like the pinned Pi
 * `FileModelsStore` (`pi-agent/packages/coding-agent/src/core/models-store.ts`).
 * Unlike the pinned store, every persisted fact is validated first:
 *
 * - a write whose entry is not a validated model fact, or whose models do
 *   not belong to the entry's provider, throws before the file changes —
 *   the pi-ai refresh path turns that into a per-Provider failure, so a
 *   broken Provider is isolated and its previous cached/built-in facts
 *   survive;
 * - a restore reads a transparent JSON file under the configured
 *   application directory and validates it again; an unparseable file or an
 *   invalid entry is dropped (never guessed at) and reported precisely
 *   through `takeDroppedReport()` so the refresh controller can emit a
 *   value-safe warning.
 *
 * The cache is never a second editable authority: models.json remains the
 * only user-editable source of catalog configuration, and the cache file is
 * only ever (re)written by the runtime after a successful refresh.
 */

export const CATALOG_CACHE_SCHEMA = "luckytoken-catalog-cache-v1" as const;

export interface CatalogCacheFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
}

const nodeFileSystem: CatalogCacheFileSystem = Object.freeze({
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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

/** One entry dropped from the cache file during restore. */
export interface CatalogCacheDroppedEntry {
  readonly providerId: string;
  readonly reason: "unparseable_file" | "invalid_entry";
}

export interface CatalogCacheStoreOptions {
  /** LuckyToken-owned cache file under the configured application
   *  directory; never the Pi Agent default data directory. */
  readonly path: string;
  /** Test seam at the file-system boundary; defaults to node fs. */
  readonly fileSystem?: CatalogCacheFileSystem;
}

export interface CatalogCacheStore extends ModelsStore {
  /** Entries dropped by the most recent restore, for precise warnings. */
  takeDroppedReport(): readonly CatalogCacheDroppedEntry[];
}

interface FileState {
  readonly present: boolean;
  readonly raw: string;
  readonly entries: Readonly<Record<string, ModelsStoreEntry>>;
  readonly dropped: readonly CatalogCacheDroppedEntry[];
  /** The file exists but is not a valid cache document. */
  readonly unparseable: boolean;
}

/** Validate one dynamic model fact (pi-ai `Model` shape). */
function isModelFact(value: unknown): value is Model<Api> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const model = value as Record<string, unknown>;
  if (
    typeof model.id !== "string" ||
    model.id.length === 0 ||
    typeof model.name !== "string" ||
    typeof model.api !== "string" ||
    model.api.length === 0 ||
    typeof model.provider !== "string" ||
    model.provider.length === 0 ||
    typeof model.baseUrl !== "string" ||
    typeof model.reasoning !== "boolean" ||
    !Array.isArray(model.input) ||
    model.input.some((entry) => entry !== "text" && entry !== "image") ||
    typeof model.contextWindow !== "number" ||
    typeof model.maxTokens !== "number"
  ) {
    return false;
  }
  const cost = model.cost;
  if (
    typeof cost !== "object" ||
    cost === null ||
    typeof (cost as Record<string, unknown>).input !== "number" ||
    typeof (cost as Record<string, unknown>).output !== "number" ||
    typeof (cost as Record<string, unknown>).cacheRead !== "number" ||
    typeof (cost as Record<string, unknown>).cacheWrite !== "number"
  ) {
    return false;
  }
  return true;
}

/** Validate one cached entry: every model must be a validated fact of the
 *  provider that owns the cache key (facts never leak across providers).
 *  Returns a value-free reason when the entry is invalid. */
function validateEntry(
  providerId: string,
  value: unknown,
):
  | { readonly entry: ModelsStoreEntry }
  | { readonly reason: "shape" | "provider" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { reason: "shape" };
  }
  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.models)) return { reason: "shape" };
  for (const model of entry.models) {
    if (!isModelFact(model)) return { reason: "shape" };
    if (model.provider !== providerId) return { reason: "provider" };
  }
  const checkedAt = entry.checkedAt;
  const lastModified = entry.lastModified;
  const etag = entry.etag;
  if (
    (checkedAt !== undefined && typeof checkedAt !== "number") ||
    (lastModified !== undefined && typeof lastModified !== "number") ||
    (etag !== undefined && typeof etag !== "string")
  ) {
    return { reason: "shape" };
  }
  return Object.freeze({
    entry: Object.freeze({
      models: Object.freeze([...(entry.models as readonly Model<Api>[])]),
      ...(checkedAt === undefined ? {} : { checkedAt: checkedAt as number }),
      ...(lastModified === undefined
        ? {}
        : { lastModified: lastModified as number }),
      ...(etag === undefined ? {} : { etag: etag as string }),
    }),
  });
}

/** Parse and validate the whole cache file; invalid parts are dropped. */
function parseCacheFile(raw: string): FileState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).schema !== CATALOG_CACHE_SCHEMA
  ) {
    return undefined;
  }
  const providers = (parsed as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null) return undefined;
  const entries: Record<string, ModelsStoreEntry> = {};
  const dropped: CatalogCacheDroppedEntry[] = [];
  for (const [providerId, value] of Object.entries(providers)) {
    const validated = validateEntry(providerId, value);
    if ("reason" in validated) {
      dropped.push(
        Object.freeze({ providerId, reason: "invalid_entry" as const }),
      );
      continue;
    }
    entries[providerId] = validated.entry;
  }
  return Object.freeze({
    present: true,
    raw,
    entries: Object.freeze(entries),
    dropped: Object.freeze(dropped),
    unparseable: false,
  });
}

export function createCatalogCacheStore(
  options: CatalogCacheStoreOptions,
): CatalogCacheStore {
  const path = options.path;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  // The parsed view of the on-disk file, reloaded when the bytes change.
  let current: FileState = Object.freeze({
    present: false,
    raw: "",
    entries: Object.freeze({}),
    dropped: Object.freeze([]),
    unparseable: false,
  });
  let pendingDropped: readonly CatalogCacheDroppedEntry[] = Object.freeze([]);
  // Records dropped entries for exactly one takeDroppedReport() call.
  let reportPending = false;
  // The file content the pending drop report was recorded against: an
  // unchanged file never re-reports the same dropped entries, so a broken
  // cache file warns once per content instead of on every refresh.
  let reportedForRaw: string | undefined;
  // Serializes every mutation (write/delete): a concurrent whole-file
  // publish must derive from the previous mutation's committed state, so
  // no Provider update is ever lost to a last-rename-wins race. The tail
  // never poisons: a failed mutation does not block later ones.
  let mutationTail: Promise<void> = Promise.resolve();
  const enqueueMutation = (task: () => Promise<void>): Promise<void> => {
    const run = mutationTail.then(task);
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const load = async (): Promise<FileState> => {
    let raw: string;
    let present = true;
    try {
      raw = await fileSystem.readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        present = false;
        raw = "";
      } else {
        throw error;
      }
    }
    if (present === current.present && raw === current.raw) {
      return current;
    }
    if (!present) {
      current = Object.freeze({
        present: false,
        raw: "",
        entries: Object.freeze({}),
        dropped: Object.freeze([]),
        unparseable: false,
      });
      return current;
    }
    const parsed = parseCacheFile(raw);
    if (parsed === undefined) {
      current = Object.freeze({
        present: true,
        raw,
        entries: Object.freeze({}),
        dropped: Object.freeze([]),
        unparseable: true,
      });
      return current;
    }
    current = parsed;
    return current;
  };

  const commit = async (next: Readonly<Record<string, ModelsStoreEntry>>): Promise<void> => {
    await fileSystem.mkdir(dirname(path));
    const content = `${JSON.stringify(
      { schema: CATALOG_CACHE_SCHEMA, providers: next },
      null,
      2,
    )}\n`;
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fileSystem.writeFile(temporaryPath, content);
      await fileSystem.rename(temporaryPath, path);
    } catch (error) {
      await fileSystem.rm(temporaryPath).catch(() => undefined);
      throw error;
    }
    current = Object.freeze({
      present: true,
      raw: content,
      entries: Object.freeze({ ...next }),
      dropped: Object.freeze([]),
      unparseable: false,
    });
  };

  return Object.freeze({
    async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
      const state = await load();
      const entry = state.entries[providerId];
      if (entry !== undefined) return structuredClone(entry);
      const record = (reason: CatalogCacheDroppedEntry["reason"]): void => {
        if (reportPending || reportedForRaw === state.raw) return;
        pendingDropped = Object.freeze([
          { providerId, reason },
        ]);
        reportedForRaw = state.raw;
        reportPending = true;
      };
      if (state.present && state.unparseable) {
        record("unparseable_file");
        return undefined;
      }
      if (state.present && state.dropped.length > 0) {
        // Record which provider's cached facts could not be restored; the
        // report is consumed (once) by the refresh controller.
        record("invalid_entry");
      }
      return undefined;
    },
    async write(
      providerId: string,
      entry: ModelsStoreEntry,
    ): Promise<void> {
      const validated = validateEntry(providerId, entry);
      if ("reason" in validated) {
        const detail =
          validated.reason === "provider"
            ? `a cached model does not match the cached provider "${providerId}"`
            : "the cached models are not valid dynamic model facts";
        throw new Error(
          `Refusing to cache invalid dynamic catalog facts for provider "${providerId}": ${detail}`,
        );
      }
      const queued = validated.entry;
      return enqueueMutation(async () => {
        const state = await load();
        const next: Record<string, ModelsStoreEntry> = { ...state.entries };
        next[providerId] = queued;
        await commit(next);
      });
    },
    async delete(providerId: string): Promise<void> {
      return enqueueMutation(async () => {
        const state = await load();
        if (!Object.hasOwn(state.entries, providerId)) return;
        const next: Record<string, ModelsStoreEntry> = { ...state.entries };
        delete next[providerId];
        await commit(next);
      });
    },
    takeDroppedReport(): readonly CatalogCacheDroppedEntry[] {
      if (!reportPending) return Object.freeze([]);
      reportPending = false;
      const report = pendingDropped;
      pendingDropped = Object.freeze([]);
      return report;
    },
  });
}
