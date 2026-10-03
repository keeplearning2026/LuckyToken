import type { LocalOAuthRegistration } from "@token/provider-contract/local-oauth";
import { parseCodexInternalAuth } from "./codex-internal-auth.js";

/** Built-in Codex uses exactly the same local OAuth contract as Provider packages. */
export function createCodexLocalOAuthRegistration(options: {
  readonly authPath: string;
  readonly label: () => string | undefined;
}): LocalOAuthRegistration {
  return Object.freeze({
    providerId: "openai-codex",
    icon: "terminal" as const,
    label: options.label,
    async acquire(signal?: AbortSignal) {
      signal?.throwIfAborted();
      return Object.freeze({ owner: "external" as const, path: options.authPath });
    },
    read: parseCodexInternalAuth,
  });
}
