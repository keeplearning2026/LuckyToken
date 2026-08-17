import { realpath as realpathAsync, stat as statAsync } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

/**
 * Backend-owned canonical directory contract (Ticket 17).
 *
 * Every public entry point that accepts a directory (Control Plane
 * commands, CLI `--project`, the live authority) resolves the input to its
 * canonical real filesystem identity through this contract. The native
 * directory picker, the renderer, and CLI callers provide raw input paths;
 * only the resolved canonical identity is ever persisted or compared, so
 * symlinks, junctions, case aliases, separator variants, and relative
 * aliases that identify one directory share exactly one scope and can never
 * create duplicate tokens.
 *
 * Resolution is filesystem-observed, never string-guessed: `realpath`
 * resolves reparse points (symlinks and Windows junctions) and returns the
 * on-disk casing, then a directory check and a second `realpath` verify the
 * target did not change mid-resolution (race). Failures are classified into
 * a value-free taxonomy; the input path never appears in the result.
 */

export type CanonicalDirectoryFailureReason =
  | "not_found"
  | "not_a_directory"
  | "inaccessible"
  | "race"
  | "invalid";

export type CanonicalDirectoryResult =
  | { readonly outcome: "ok"; readonly canonicalDir: string }
  | { readonly outcome: CanonicalDirectoryFailureReason };

export interface CanonicalDirectoryResolver {
  /**
   * Resolves an input directory (relative or absolute) to its canonical
   * real filesystem identity. `cwd` controls the base for relative inputs;
   * it defaults to the caller's process working directory and is never
   * mutated by this contract.
   */
  resolve(
    inputDir: string,
    cwd?: string,
  ): Promise<CanonicalDirectoryResult>;
}

/** Injectable filesystem primitives (test seam for race/inaccessible
 *  simulation); defaults are the real operations. */
export interface CanonicalDirectoryFileOperations {
  realpath(input: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

const defaultFileOperations: CanonicalDirectoryFileOperations = Object.freeze({
  realpath: (input: string) => realpathAsync(input),
  stat: (path: string) => statAsync(path),
});

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function classifyFailure(error: unknown): CanonicalDirectoryFailureReason {
  switch (errorCode(error)) {
    case "ENOENT":
      return "not_found";
    case "ENOTDIR":
      return "not_a_directory";
    case "EACCES":
    case "EPERM":
      return "inaccessible";
    case "ELOOP":
      return "invalid";
    default:
      return "invalid";
  }
}

export function createRealFilesystemCanonicalDirectoryResolver(
  operations: Partial<CanonicalDirectoryFileOperations> = {},
): CanonicalDirectoryResolver {
  const fileOperations: CanonicalDirectoryFileOperations = {
    ...defaultFileOperations,
    ...operations,
  };
  return Object.freeze({
    async resolve(
      inputDir: string,
      cwd?: string,
    ): Promise<CanonicalDirectoryResult> {
      if (
        typeof inputDir !== "string" ||
        inputDir.length === 0 ||
        inputDir.includes("\u0000")
      ) {
        return Object.freeze({ outcome: "invalid" });
      }
      const absolute = isAbsolute(inputDir)
        ? inputDir
        : resolvePath(cwd ?? process.cwd(), inputDir);
      let first: string;
      try {
        first = await fileOperations.realpath(absolute);
      } catch (error) {
        return Object.freeze({ outcome: classifyFailure(error) });
      }
      let directory: boolean;
      try {
        directory = (await fileOperations.stat(first)).isDirectory();
      } catch (error) {
        const code = errorCode(error);
        // A path component under a junction/symlink that vanished between
        // realpath and stat means the target changed mid-resolution.
        if (code === "ENOENT" || code === "ENOTDIR") {
          return Object.freeze({ outcome: "race" });
        }
        return Object.freeze({ outcome: classifyFailure(error) });
      }
      if (!directory) {
        return Object.freeze({ outcome: "not_a_directory" });
      }
      // Race verification: the target must resolve to the same canonical
      // identity again or the input changed while we looked.
      let second: string;
      try {
        second = await fileOperations.realpath(absolute);
      } catch {
        return Object.freeze({ outcome: "race" });
      }
      if (second !== first) {
        return Object.freeze({ outcome: "race" });
      }
      return Object.freeze({ outcome: "ok", canonicalDir: first });
    },
  });
}

/** Default singleton resolver backed by the real filesystem. */
const realFilesystemResolver = createRealFilesystemCanonicalDirectoryResolver();

export function resolveCanonicalDirectory(
  inputDir: string,
  cwd?: string,
): Promise<CanonicalDirectoryResult> {
  return realFilesystemResolver.resolve(inputDir, cwd);
}

/**
 * Scope-lookup canonical resolution for persisted directory scopes
 * (Ticket 17 repair 01).
 *
 * While a directory exists, normal filesystem-observed resolution applies
 * (aliases, junctions, case variants, relative inputs). Once it has
 * disappeared, the stored canonical identity is authoritative: only an
 * input that exactly equals a persisted canonical scope key may still
 * address the orphan scope for reveal/rotate/remove. Any other input keeps
 * the original value-free failure.
 *
 * The persisted-identity check happens before resolution, so an input that
 * IS the stored identity never needs resolution and can never be
 * redirected to a different scope (e.g. a new junction placed where the
 * original directory was). Creation paths never pass a persisted set, so
 * creating a token for a missing directory still fails.
 */
export async function resolveCanonicalDirectoryForScopeLookup(
  inputDir: string,
  persistedCanonicalDirs: ReadonlySet<string>,
  resolver: CanonicalDirectoryResolver = realFilesystemResolver,
): Promise<CanonicalDirectoryResult> {
  if (persistedCanonicalDirs.has(inputDir)) {
    return Object.freeze({ outcome: "ok", canonicalDir: inputDir });
  }
  return resolver.resolve(inputDir);
}
