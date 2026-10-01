import { createExternalCredentialSource, type ExternalCredentialSource } from "./external-credential-source.js";
import { EXTERNAL_AUTH_DISPLAY_NAME, EXTERNAL_AUTH_PROVIDER_LABEL,
  EXTERNAL_AUTH_REFRESH_WINDOW_MS, parseCodexExternalAuth } from "./codex-auth.js";
import type { CodexAppServerRefresher } from "./codex-app-server-refresh.js";

/** Codex owns ChatGPT claims, format, validity and app-server refresh.
 * The shared file lifecycle knows none of those provider policies. */
export function createCodexExternalCredentialSource(options: {
  readonly authPath: string;
  readonly refresher: CodexAppServerRefresher;
  readonly now?: () => number;
  readonly minimumValidityMs?: number;
  readonly readAttempts?: number;
  readonly retryDelayMs?: number;
}): ExternalCredentialSource {
  return createExternalCredentialSource({
    path: options.authPath, authType: "oauth",
    authMethodLabel: EXTERNAL_AUTH_PROVIDER_LABEL, displayName: EXTERNAL_AUTH_DISPLAY_NAME,
    decode(raw) {
      const parsed = parseCodexExternalAuth(raw);
      if (parsed.state !== "ok") return parsed;
      const credential = parsed.auth.credential;
      return { state: "ok", document: { identityKey: parsed.auth.accountId,
        ...(credential === undefined ? {} : { credential: Object.freeze({
          type: "oauth" as const, access: credential.accessToken,
          refresh: credential.refreshToken, expires: credential.expiresAt,
        }) }) } };
    },
    isUsable(document, now) {
      return document.credential?.type === "oauth" &&
        document.credential.expires - now > (options.minimumValidityMs ?? EXTERNAL_AUTH_REFRESH_WINDOW_MS);
    },
    refresh: (input) => options.refresher.refresh(input),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.readAttempts === undefined ? {} : { readAttempts: options.readAttempts }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  });
}
