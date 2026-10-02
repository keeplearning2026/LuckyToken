import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { AuthType, Credential } from "@earendil-works/pi-ai";

import { parseCodexInternalAuth, serializeCodexInternalAuth } from "./codex-internal-auth.js";

/**
 * One referenced credential document. Every Profile owns exactly one
 * reference; the Profile never owns where a credential file lives.
 *
 * `owner` selects the write/GC contract, not the parsing contract:
 *
 * - `managed`: Token owns the document. `path` is POSIX-style and relative
 *   to the credential root. Token may write/rotate it and collects
 *   unreferenced documents under the root.
 * - `external`: the source owner owns the document. `path` is absolute.
 *   Token only reads it; it is never written, backed up or deleted.
 *
 * `revision` is the SHA-256 content hash observed at the last successful
 * publication or read.
 */
export interface CredentialDocumentReference {
  readonly path: string;
  readonly owner: "managed" | "external";
  readonly revision?: string;
}

export const MAX_CREDENTIAL_DOCUMENT_BYTES = 1024 * 1024;

export type CredentialDocumentRead =
  | {
      readonly state: "ok";
      readonly raw: string;
      readonly revision: string;
    }
  | { readonly state: "missing" | "unreadable" };

export function credentialDocumentRevision(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function isExternalCredentialPath(path: string): boolean {
  return isAbsolute(path);
}

/** Resolve links on every acquisition so a swapped target cannot reuse an
 * earlier external reference. */
export async function canonicalCredentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Infrastructure-only bounded read of one referenced document. The raw
 * contents never enter public binding facts, DTOs, errors or diagnostics.
 */
export async function readCredentialDocumentFile(
  path: string,
): Promise<CredentialDocumentRead> {
  try {
    if (!(await lstat(path)).isFile()) return Object.freeze({ state: "unreadable" });
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CREDENTIAL_DOCUMENT_BYTES) {
        return Object.freeze({ state: "unreadable" });
      }
      // Bound the actual read too: a concurrent writer may grow after stat.
      const bytes = Buffer.alloc(MAX_CREDENTIAL_DOCUMENT_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_CREDENTIAL_DOCUMENT_BYTES) {
        return Object.freeze({ state: "unreadable" });
      }
      const contents = bytes.subarray(0, length);
      return Object.freeze({
        state: "ok",
        raw: contents.toString("utf8"),
        revision: credentialDocumentRevision(contents),
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    const missing =
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT";
    return Object.freeze({ state: missing ? "missing" : "unreadable" });
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApiKeyDocument(raw: string): Credential | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
    if (
      !isObject(parsed) ||
      parsed.type !== "api_key" ||
      (parsed.key !== undefined && typeof parsed.key !== "string") ||
      (parsed.env !== undefined && !isObject(parsed.env))
    ) {
      return null;
    }
    return structuredClone(parsed) as Credential;
  }
  const key = raw.trim();
  if (key.length === 0 || /[\r\n\u0000]/u.test(key)) return null;
  return Object.freeze({ type: "api_key", key });
}

function parseOAuthDocument(raw: string): Credential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isObject(parsed) ||
    parsed.type !== "oauth" ||
    typeof parsed.access !== "string" ||
    typeof parsed.refresh !== "string" ||
    typeof parsed.expires !== "number" ||
    !Number.isFinite(parsed.expires)
  ) {
    return null;
  }
  return structuredClone(parsed) as Credential;
}

/**
 * Parse one referenced document for a Provider/authType. The parser is
 * selected by provider authentication format, never by Profile kind.
 */
export function parseCredentialDocument(
  providerId: string,
  authType: AuthType,
  raw: string,
): Credential | null {
  if (providerId === "openai-codex" && authType === "oauth") {
    // Codex keeps the ChatGPT branch only; other auth modes are unsupported
    // and are never coerced into tokens.
    return parseCodexInternalAuth(raw) ?? null;
  }
  return authType === "api_key"
    ? parseApiKeyDocument(raw)
    : parseOAuthDocument(raw);
}

/**
 * Serialize one credential into the document format of its
 * Provider/authType. Managed documents round-trip through
 * `parseCredentialDocument`.
 */
export function serializeCredentialDocument(
  providerId: string,
  authType: AuthType,
  credential: Credential,
): string {
  if (credential.type !== authType) {
    throw new Error("Credential document requires a matching authentication type");
  }
  if (providerId === "openai-codex" && authType === "oauth") {
    return serializeCodexInternalAuth(credential);
  }
  if (authType === "api_key") {
    if (credential.type !== "api_key") {
      throw new Error("API key credential documents require an API key credential");
    }
    if (credential.env === undefined) {
      const key = credential.key?.trim();
      if (
        key === undefined ||
        key.length === 0 ||
        /[\r\n\u0000]/u.test(key)
      ) {
        throw new Error("API key credential documents require one non-empty key");
      }
      return `${key}\n`;
    }
    return `${JSON.stringify(credential, null, 2)}\n`;
  }
  return `${JSON.stringify(credential, null, 2)}\n`;
}
