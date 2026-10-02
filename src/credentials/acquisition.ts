import type { AuthType, Credential } from "@earendil-works/pi-ai";

import {
  canonicalCredentialPath,
  parseCredentialDocument,
  readCredentialDocumentFile,
  type CredentialDocumentReference,
} from "./credential-document.js";

/**
 * Generic acquisition kinds. A kind is the only acquisition fact the public
 * contract exposes; the internal strategy id (e.g. `codex_local`) stays in
 * the persisted record and Backend dispatch.
 */
export type AcquisitionKind = "api_key" | "oauth" | "local_oauth";

/** Renderer icon selector for one acquisition option. */
export type AcquisitionIcon = "key" | "account" | "terminal";

export const LOCAL_LOGIN_DUPLICATE_MESSAGE =
  "A local login Profile already exists. Reconnect it to refresh, or remove it first.";
export const LOCAL_LOGIN_FAILURE_MESSAGE =
  "The local login source is unavailable. Sign in with the local app and try again.";

/** A local acquisition read failed. The Profile command surface maps it to
 * the generic `failed` outcome without leaking the source path or contents. */
export class LocalAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAcquisitionError";
  }
}

export interface AcquisitionGrant {
  /** The credential document this acquisition formed. */
  readonly reference: CredentialDocumentReference;
  readonly credential: Credential;
}

/**
 * A Provider-registered local acquisition strategy. It owns only the bounded
 * read of its local source; the Provider-locked Profile transaction, name
 * allocation, selection and publication stay in the Profile authority so the
 * singleton check, the read and the commit share one lock.
 */
export interface LocalAcquisitionStrategy {
  readonly strategyId: string;
  readonly providerId: string;
  readonly acquisitionKind: "local_oauth";
  readonly authType: AuthType;
  readonly singleton: boolean;
  readonly icon: AcquisitionIcon;
  readonly label: () => string | undefined;
  /** Read-only. Returns null when the local document is missing, unreadable
   * or unsupported; the caller reports a failed login and creates nothing. */
  acquire(signal?: AbortSignal): Promise<AcquisitionGrant | null>;
}

/** The public acquisition kind of a Profile formed without an explicit
 * strategy: api_key stays api_key, every interactive OAuth login is oauth. */
export function defaultAcquisitionKind(authType: AuthType): AcquisitionKind {
  return authType === "api_key" ? "api_key" : "oauth";
}

export function acquisitionKindOf(
  strategyId: string | undefined,
  authType: AuthType,
  strategies: readonly LocalAcquisitionStrategy[],
): AcquisitionKind {
  if (strategyId === undefined) return defaultAcquisitionKind(authType);
  return (
    strategies.find((strategy) => strategy.strategyId === strategyId)
      ?.acquisitionKind ?? defaultAcquisitionKind(authType)
  );
}

/**
 * The one local Codex acquisition strategy. The document below
 * `<CODEX_HOME>/auth.json` is Codex-owned: it is read once per acquisition
 * and referenced afterwards, never copied, written or refreshed by Token.
 */
export function createCodexLocalAcquisitionStrategy(options: {
  readonly authPath: string;
  readonly label: () => string | undefined;
}): LocalAcquisitionStrategy {
  return Object.freeze({
    strategyId: "codex_local",
    providerId: "openai-codex",
    acquisitionKind: "local_oauth",
    authType: "oauth",
    singleton: true,
    icon: "terminal",
    label: options.label,
    async acquire(signal?: AbortSignal): Promise<AcquisitionGrant | null> {
      signal?.throwIfAborted();
      const path = await canonicalCredentialPath(options.authPath);
      const document = await readCredentialDocumentFile(path);
      signal?.throwIfAborted();
      if (document.state !== "ok") return null;
      const credential = parseCredentialDocument("openai-codex", "oauth", document.raw);
      if (credential === null) return null;
      return Object.freeze({
        reference: Object.freeze({
          path,
          owner: "external" as const,
          revision: document.revision,
        }),
        credential,
      });
    },
  });
}
