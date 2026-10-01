import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  codexCliInvocation,
  codexDebugModelsInvocation,
  discoverCodexCommands,
  type CodexRuntimeDiscoveryOptions,
} from "./runtime-discovery.js";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 10_000;
const BUNDLED_TIMEOUT_MS = 10_000;

export type CodexNativeCatalogEntry = Readonly<Record<string, unknown>> & {
  readonly slug: string;
};

/** Identity of the runtime and inputs that produced one snapshot. The
 * validator must use this exact runtime; a different runtime cannot prove the
 * injected catalog parses. */
export interface CodexRuntimeIdentity {
  readonly command: string;
  readonly version?: string;
  readonly codexHome: string;
}

export interface CodexNativeCatalogSnapshot {
  readonly source: "bundled" | "models-cache" | "unavailable";
  readonly runtimeIdentity?: CodexRuntimeIdentity;
  readonly entries: readonly CodexNativeCatalogEntry[];
  readonly warnings: readonly string[];
  /** Deterministic content hash of the strategy key, runtime identity, and
   * entries. Consumers invalidate derived state by comparing generations. */
  readonly generation: string;
}

export interface CodexNativeCatalogSource {
  load(): Promise<CodexNativeCatalogSnapshot>;
  /** Drop any acquired snapshot so the next load re-acquires. Used for
   * runtime change, Codex home change, strategy failure, and manual refresh. */
  invalidate(): void;
}

export type CreateCodexNativeCatalogSourceOptions = CodexRuntimeDiscoveryOptions & {
  readonly codexHome: string;
  readonly runBundledCatalog?: (command: string) => Promise<string>;
  readonly runVersion?: (command: string) => Promise<string>;
  /** Acquisition TTL optimization only; consistency is owned by one
   * generation per refresh, never by this cache. */
  readonly ttlMs?: number;
  readonly now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function parseNativeEntries(raw: string): readonly CodexNativeCatalogEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined;
  return deepFreeze(
    parsed.models.flatMap((entry): CodexNativeCatalogEntry[] => {
      if (!isRecord(entry)) return [];
      const slug = entry.slug;
      if (typeof slug !== "string" || slug.length === 0 || slug.includes("/")) return [];
      return [{ ...entry, slug } as CodexNativeCatalogEntry];
    }),
  );
}

async function runBundledCatalog(
  command: string,
  codexHome: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const invocation = codexDebugModelsInvocation(command, platform, env);
  const result = await execFileAsync(invocation.file, [...invocation.args], {
    encoding: "utf8",
    // Every spawned Codex helper receives the explicit Codex home; the
    // catalog runner never reads the user's real home by inheritance.
    env: { ...env, CODEX_HOME: codexHome },
    windowsHide: true,
    timeout: BUNDLED_TIMEOUT_MS,
    ...invocation.options,
  });
  return result.stdout;
}

async function runVersion(
  command: string,
  codexHome: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const invocation = codexCliInvocation(command, ["--version"], platform, env);
  const result = await execFileAsync(invocation.file, [...invocation.args], {
    encoding: "utf8",
    env: { ...env, CODEX_HOME: codexHome },
    windowsHide: true,
    timeout: VERSION_TIMEOUT_MS,
    ...invocation.options,
  });
  return result.stdout;
}

function parseVersion(stdout: string): string | undefined {
  return /codex-cli\s+([^\s]+)/u.exec(stdout)?.[1];
}

async function readModelsCache(
  codexHome: string,
): Promise<readonly CodexNativeCatalogEntry[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(codexHome, "models_cache.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseNativeEntries(raw);
}

function snapshotGeneration(
  source: CodexNativeCatalogSnapshot["source"],
  runtimeIdentity: CodexRuntimeIdentity | undefined,
  entries: readonly CodexNativeCatalogEntry[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source,
        runtimeIdentity: runtimeIdentity ?? null,
        entries,
      }),
    )
    .digest("hex");
}

/**
 * Read one Codex-owned native model snapshot. The installed Codex bundled
 * catalog is authoritative when available; the user's models cache is a
 * read-only fallback. Token never reconstructs native identity from Pi and
 * never writes or invalidates `models_cache.json`.
 */
export function createCodexNativeCatalogSource(
  options: CreateCodexNativeCatalogSourceOptions,
): CodexNativeCatalogSource {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 0;
  const discover = options.discoverCommands ?? (() => discoverCodexCommands(options));
  const bundled =
    options.runBundledCatalog ??
    ((command: string) => runBundledCatalog(command, options.codexHome, platform, env));
  const version =
    options.runVersion ??
    ((command: string) => runVersion(command, options.codexHome, platform, env));

  let cached: CodexNativeCatalogSnapshot | undefined;
  let cachedAt = 0;
  let inflight: Promise<CodexNativeCatalogSnapshot> | undefined;

  const acquire = async (): Promise<CodexNativeCatalogSnapshot> => {
    const commands = await discover().catch(() => Object.freeze([]));
    for (const command of commands) {
      let reportedVersion: string | undefined;
      try {
        reportedVersion = parseVersion(await version(command));
      } catch {
        // A runtime that cannot report its version is still a usable candidate;
        // the identity simply omits the version.
      }
      try {
        const entries = parseNativeEntries(await bundled(command));
        if (entries !== undefined) {
          const runtimeIdentity: CodexRuntimeIdentity = Object.freeze({
            command,
            ...(reportedVersion === undefined ? {} : { version: reportedVersion }),
            codexHome: options.codexHome,
          });
          return Object.freeze({
            source: "bundled" as const,
            runtimeIdentity,
            entries,
            warnings: Object.freeze([]),
            generation: snapshotGeneration("bundled", runtimeIdentity, entries),
          });
        }
      } catch {
        // Try the next discovered runtime. Discovery faults are metadata
        // availability problems and never disable routed Token models.
      }
    }

    try {
      const entries = await readModelsCache(options.codexHome);
      if (entries !== undefined) {
        const warnings = Object.freeze([
          "Codex bundled model catalog is unavailable; using models_cache.json.",
        ]);
        return Object.freeze({
          source: "models-cache" as const,
          entries,
          warnings,
          generation: snapshotGeneration("models-cache", undefined, entries),
        });
      }
    } catch {
      // A malformed/unreadable cache is the same unavailable metadata state.
    }

    const warnings = Object.freeze(["Codex native model metadata is unavailable."]);
    return Object.freeze({
      source: "unavailable" as const,
      entries: Object.freeze([]),
      warnings,
      generation: snapshotGeneration("unavailable", undefined, Object.freeze([])),
    });
  };

  return Object.freeze({
    invalidate(): void {
      cached = undefined;
      cachedAt = 0;
    },
    async load(): Promise<CodexNativeCatalogSnapshot> {
      if (cached !== undefined && ttlMs > 0 && now() - cachedAt < ttlMs) {
        return cached;
      }
      if (inflight !== undefined) return inflight;
      const pending = acquire()
        .then(
          (snapshot) => {
            cached = snapshot;
            cachedAt = now();
            return snapshot;
          },
          (error: unknown) => {
            cached = undefined;
            cachedAt = 0;
            throw error;
          },
        )
        .finally(() => {
          if (inflight === pending) inflight = undefined;
        });
      inflight = pending;
      return pending;
    },
  });
}
