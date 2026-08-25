/**
 * Export destination path safety (Ticket 23) — the server-side validation
 * of the user-chosen destination before any file is created.
 *
 * Rules:
 * - absolute path only (the shell's save dialog returns canonical absolute
 *   paths; the CLI resolves relative paths to the working directory);
 * - no control characters or NUL;
 * - basename is not a Windows reserved device name (`CON`, `PRN`, `AUX`,
 *   `NUL`, `COM1-9`, `LPT1-9`, case-insensitive, with or without extension)
 *   — such a path would silently map to a device on Windows;
 * - destination is not inside a Token-owned directory tree (config
 *   dir, Pi data dir, store directories) so an export can never clobber
 *   application-owned files;
 * - an existing destination must be a file (a directory is rejected), and
 *   replacing it requires the explicit `overwrite` consent.
 */
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";

const MAX_PATH_LENGTH = 4_096;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
/** Windows reserved device names, with or without extension, any case. */
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function comparisonPath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function insideOwnedRoot(path: string, root: string): boolean {
  const candidate = comparisonPath(resolve(path));
  const owned = comparisonPath(resolve(root));
  return candidate === owned || candidate.startsWith(`${owned}${sep}`);
}

async function canonicalPath(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, ...missing);
    } catch (error) {
      const code =
        error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) return resolve(path);
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export type DestinationRejectionCode =
  | "invalid_destination"
  | "destination_exists";

export interface DestinationValidationResult {
  readonly ok: true;
}

export interface DestinationRejection {
  readonly ok: false;
  readonly code: DestinationRejectionCode;
}

export function validateExportDestination(
  destinationPath: string,
  ownedRoots: readonly string[],
): DestinationValidationResult | DestinationRejection {
  if (
    destinationPath.length === 0 ||
    destinationPath.length > MAX_PATH_LENGTH ||
    CONTROL_CHARS.test(destinationPath)
  ) {
    return { ok: false, code: "invalid_destination" };
  }
  if (!isAbsolute(destinationPath)) {
    return { ok: false, code: "invalid_destination" };
  }
  if (WINDOWS_DEVICE_NAME.test(basename(destinationPath))) {
    return { ok: false, code: "invalid_destination" };
  }
  for (const root of ownedRoots) {
    if (root.length === 0) continue;
    if (insideOwnedRoot(destinationPath, root)) {
      return { ok: false, code: "invalid_destination" };
    }
  }
  return { ok: true };
}

/** Resolves existing ancestors so a junction/symlink outside the user root
 * cannot redirect an export back into Token-owned storage. */
export async function validateCanonicalExportDestination(
  destinationPath: string,
  ownedRoots: readonly string[],
): Promise<DestinationValidationResult | DestinationRejection> {
  const lexical = validateExportDestination(destinationPath, ownedRoots);
  if (!lexical.ok) return lexical;
  try {
    const destination = await canonicalPath(destinationPath);
    for (const root of ownedRoots) {
      if (root.length === 0) continue;
      const canonicalRoot = await canonicalPath(root);
      if (insideOwnedRoot(destination, canonicalRoot)) {
        return { ok: false, code: "invalid_destination" };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "invalid_destination" };
  }
}

/** Bounded existence check: an existing directory is rejected; an existing
 *  file requires explicit overwrite consent (checked before streaming and
 *  re-checked immediately before publication to narrow the race). */
export async function inspectDestination(
  destinationPath: string,
  overwrite: boolean,
): Promise<
  | { readonly kind: "absent" }
  | { readonly kind: "file" }
  | { readonly kind: "rejected"; readonly code: DestinationRejectionCode }
> {
  let stats;
  try {
    stats = await lstat(destinationPath);
  } catch (error) {
    const code =
      error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    return code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "rejected", code: "invalid_destination" };
  }
  if (stats.isDirectory()) {
    return { kind: "rejected", code: "invalid_destination" };
  }
  if (!overwrite) {
    return { kind: "rejected", code: "destination_exists" };
  }
  return { kind: "file" };
}

/** Creates the destination's parent tree (bounded to the destination's own
 *  path; the destination itself was already validated as outside every
 *  Token-owned root). */
export async function ensureDestinationDirectory(
  destinationPath: string,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
}
