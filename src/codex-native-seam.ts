import type { ReadonlyHeaders } from "./request-identity.js";

/** Bounded authentication facts needed by client-owned Codex passthrough. */
export type CodexFetchFunction = typeof globalThis.fetch;

export interface CodexForwardAuth {
  readonly authorization: string;
  readonly accountId?: string;
}

/**
 * Neutral local-Codex credential capability. The protocol consumes this
 * contract; the Codex integration owns filesystem observation and secrets.
 */
export interface CodexLocalCredentialAuthority {
  resolveForwardAuth(
    headers: ReadonlyHeaders,
  ): Promise<CodexForwardAuth | undefined>;
  scrub(value: string): string;
}

/** Read-only Local Native model identity seam published by the Codex integration authority. */
export interface CodexNativeModelSource {
  has(modelId: string): boolean;
}
