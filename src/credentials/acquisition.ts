import {
  canonicalCredentialPath,
  readCredentialDocumentFile,
  type CredentialDocumentReference,
} from "./credential-document.js";
import { parseCodexInternalAuth } from "./codex-internal-auth.js";

export type AcquisitionKind = "api_key" | "oauth" | "local_oauth";
export type AcquisitionIcon = "key" | "account" | "terminal";

export const LOCAL_LOGIN_DUPLICATE_MESSAGE =
  "A local login Profile already exists. Remove it first to add another local login Profile.";
export const LOCAL_LOGIN_FAILURE_MESSAGE =
  "The local login source is unavailable. Sign in with the local app and try again.";

export class LocalAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAcquisitionError";
  }
}

export interface LocalOAuthAcquisition {
  readonly providerId: string;
  readonly acquisitionKind: "local_oauth";
  readonly icon: AcquisitionIcon;
  readonly label: () => string | undefined;
  acquire(
    signal?: AbortSignal,
  ): Promise<Extract<CredentialDocumentReference, { readonly owner: "external" }> | null>;
}

/**
 * The Codex-owned auth.json remains external. Acquisition validates that the
 * current document contains a supported ChatGPT OAuth credential, then stores
 * only its canonical external reference.
 */
export function createCodexLocalAcquisition(options: {
  readonly authPath: string;
  readonly label: () => string | undefined;
}): LocalOAuthAcquisition {
  return Object.freeze({
    providerId: "openai-codex",
    acquisitionKind: "local_oauth" as const,
    icon: "terminal" as const,
    label: options.label,
    async acquire(signal?: AbortSignal) {
      signal?.throwIfAborted();
      const path = await canonicalCredentialPath(options.authPath);
      const document = await readCredentialDocumentFile(path);
      signal?.throwIfAborted();
      if (document.state !== "ok" || parseCodexInternalAuth(document.raw) === undefined) {
        return null;
      }
      return Object.freeze({ owner: "external" as const, path });
    },
  });
}
