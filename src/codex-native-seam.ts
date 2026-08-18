import type { Model } from "@earendil-works/pi-ai";

import type { AuthorizedClient, ReadonlyHeaders } from "./auth.js";

/** Bounded authentication facts needed by client-owned Codex passthrough. */
export interface CodexForwardAuth {
  readonly authorization: string;
  readonly accountId?: string;
}

/**
 * Neutral local-Codex credential capability. The protocol consumes this
 * contract; the Codex integration owns filesystem observation and secrets.
 */
export interface CodexLocalCredentialAuthority {
  isAvailable(): Promise<boolean>;
  authorizeToken(token: string): Promise<AuthorizedClient | undefined>;
  resolveForwardAuth(
    headers: ReadonlyHeaders,
  ): Promise<CodexForwardAuth | undefined>;
  scrub(value: string): string;
}

/**
 * Neutral source of Pi's bundled native Codex model identities. The protocol
 * asks only whether a bare id is native; integration/catalog code may consume
 * the bounded model list.
 */
export interface CodexNativeModelSource {
  has(modelId: string): boolean;
  models(): readonly Model<string>[];
}
