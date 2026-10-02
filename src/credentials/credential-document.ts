import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { Credential } from "@earendil-works/pi-ai";

export type CredentialDocumentReference =
  | {
      readonly owner: "managed";
      readonly path: string;
    }
  | {
      readonly owner: "external";
      readonly path: string;
    };

export const MAX_CREDENTIAL_DOCUMENT_BYTES = 1024 * 1024;

export type CredentialDocumentRead =
  | {
      readonly state: "ok";
      readonly raw: string;
      /** Ephemeral operation-local fingerprint; never Profile authority. */
      readonly revision: string;
    }
  | { readonly state: "missing" | "unreadable" };

export function credentialDocumentRevision(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function isExternalCredentialPath(path: string): boolean {
  return isAbsolute(path);
}

export async function canonicalCredentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function readCredentialDocumentFile(
  path: string,
): Promise<CredentialDocumentRead> {
  try {
    if (!(await lstat(path)).isFile()) {
      return Object.freeze({ state: "unreadable" as const });
    }
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CREDENTIAL_DOCUMENT_BYTES) {
        return Object.freeze({ state: "unreadable" as const });
      }
      const bytes = Buffer.alloc(MAX_CREDENTIAL_DOCUMENT_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_CREDENTIAL_DOCUMENT_BYTES) {
        return Object.freeze({ state: "unreadable" as const });
      }
      const contents = bytes.subarray(0, length);
      return Object.freeze({
        state: "ok" as const,
        raw: contents.toString("utf8"),
        revision: credentialDocumentRevision(contents),
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";
    return Object.freeze({
      state: missing ? ("missing" as const) : ("unreadable" as const),
    });
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseApiKeyCredentialDocument(raw: string): Credential | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
    if (
      !isObject(parsed) ||
      parsed.type !== "api_key" ||
      (parsed.key !== undefined && typeof parsed.key !== "string") ||
      (parsed.env !== undefined &&
        (!isObject(parsed.env) ||
          !Object.values(parsed.env).every((entry) => typeof entry === "string")))
    ) {
      return undefined;
    }
    return structuredClone(parsed) as Credential;
  }
  const key = raw.trim();
  if (key.length === 0 || /[\r\n\u0000]/u.test(key)) return undefined;
  return Object.freeze({ type: "api_key" as const, key });
}

export function parseOAuthCredentialDocument(raw: string): Credential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isObject(parsed) ||
    parsed.type !== "oauth" ||
    typeof parsed.access !== "string" ||
    typeof parsed.refresh !== "string" ||
    typeof parsed.expires !== "number" ||
    !Number.isFinite(parsed.expires)
  ) {
    return undefined;
  }
  return structuredClone(parsed) as Credential;
}

export function serializeApiKeyCredentialDocument(credential: Credential): string {
  if (credential.type !== "api_key") {
    throw new Error("API key credential document requires api_key Credential");
  }
  if (credential.env === undefined) {
    const key = credential.key?.trim();
    if (
      key === undefined ||
      key.length === 0 ||
      /[\r\n\u0000]/u.test(key)
    ) {
      throw new Error("API key credential requires one non-empty key");
    }
    return `${key}\n`;
  }
  return `${JSON.stringify(credential, null, 2)}\n`;
}

export function serializeOAuthCredentialDocument(credential: Credential): string {
  if (credential.type !== "oauth") {
    throw new Error("OAuth credential document requires oauth Credential");
  }
  return `${JSON.stringify(credential, null, 2)}\n`;
}
