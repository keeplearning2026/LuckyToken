import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;

export type ExternalCredentialFileRead =
  | { readonly state: "ok"; readonly canonicalPath: string;
      readonly tokenRevision: string; readonly raw: string }
  | { readonly state: "missing" | "unreadable"; readonly canonicalPath: string;
      readonly reason: string };

/** Resolve links on every read so a changed target cannot reuse a binding. */
export async function canonicalCredentialPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { return resolve(path); }
}

/** Infrastructure-only read. Raw contents never enter public binding facts,
 * errors or diagnostics. This reader never mutates the source file. */
export async function readExternalCredentialFile(
  path: string,
  options: { readonly canonicalPath?: string } = {},
): Promise<ExternalCredentialFileRead> {
  const canonicalPath = options.canonicalPath ?? await canonicalCredentialPath(path);
  try {
    if (!(await lstat(canonicalPath)).isFile()) {
      return { state: "unreadable", canonicalPath, reason: "Credential path is not a regular file" };
    }
    const handle = await open(canonicalPath, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CREDENTIAL_FILE_BYTES) {
        return { state: "unreadable", canonicalPath, reason: "Credential file exceeds the read boundary" };
      }
      // Bound the actual read too: a concurrent writer may grow after stat.
      const bytes = Buffer.alloc(MAX_CREDENTIAL_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_CREDENTIAL_FILE_BYTES) {
        return { state: "unreadable", canonicalPath, reason: "Credential file exceeds the read boundary" };
      }
      const contents = bytes.subarray(0, length);
      return Object.freeze({ state: "ok", canonicalPath,
        tokenRevision: createHash("sha256").update(contents).digest("hex"),
        raw: contents.toString("utf8") });
    } finally { await handle.close(); }
  } catch (error) {
    const missing = typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT";
    return Object.freeze({ state: missing ? "missing" : "unreadable", canonicalPath,
      reason: missing ? "Credential file is absent" : "Credential file could not be read" });
  }
}
