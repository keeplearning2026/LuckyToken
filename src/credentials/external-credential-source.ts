import {
  canonicalCodexAuthPath,
  hasSufficientValidity,
  needsCodexRefresh,
  readCodexExternalAuth,
  EXTERNAL_AUTH_REFRESH_WINDOW_MS,
  type CodexExternalAuthCredential,
  type CodexExternalAuthRead,
} from "./external-auth.js";
import type { CodexAppServerRefresher } from "./codex-app-server-refresh.js";

/**
 * The single external-credential binding path (plan section 3.2 item 6).
 *
 * Session streaming, Native responses and compact, Semantic Conversion,
 * catalog/recheck, and usage all resolve the Codex-owned `auth.json` through
 * this boundary. Freshness is enforced here: `resolve` returns a credential
 * only with more than the minimum validity, delegating an in-place refresh to
 * Codex when the trigger fires. It never calls Pi OAuth refresh.
 */

export const EXTERNAL_CREDENTIAL_MINIMUM_VALIDITY_MS =
  EXTERNAL_AUTH_REFRESH_WINDOW_MS;

export type ExternalCredentialUnavailableReason =
  | "missing"
  | "invalid"
  | "unreadable"
  | "refresh_unavailable"
  | "verification_failed";

export type ExternalCredentialResolution =
  | {
      readonly state: "ok";
      readonly canonicalPath: string;
      readonly tokenRevision: string;
      readonly accountId: string;
      readonly credential: CodexExternalAuthCredential;
      readonly refreshed: boolean;
    }
  | {
      readonly state: "unavailable";
      readonly canonicalPath: string;
      readonly reason: ExternalCredentialUnavailableReason;
      readonly detail: string;
    };

export interface ExternalCredentialSource {
  /** Capture identity without resolving the secret. */
  read(options?: { readonly signal?: AbortSignal }): Promise<CodexExternalAuthRead>;
  /** Capture identity → ensure freshness → resolve the request-local secret. */
  resolve(options?: {
    readonly signal?: AbortSignal;
  }): Promise<ExternalCredentialResolution>;
}

export interface CreateExternalCredentialSourceOptions {
  /** `<CODEX_HOME>/auth.json`. Token never writes or deletes it. */
  readonly authPath: string;
  readonly refresher: CodexAppServerRefresher;
  readonly now?: () => number;
  /** Token's own sufficient-validity constraint. */
  readonly minimumValidityMs?: number;
  /** Bounded retry budget for transient invalid/unreadable read states. */
  readonly readAttempts?: number;
  readonly retryDelayMs?: number;
}

const DEFAULT_READ_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 25;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

function unavailable(
  canonicalPath: string,
  reason: ExternalCredentialUnavailableReason,
  detail: string,
): ExternalCredentialResolution {
  return Object.freeze({ state: "unavailable", canonicalPath, reason, detail });
}

export function createExternalCredentialSource(
  options: CreateExternalCredentialSourceOptions,
): ExternalCredentialSource {
  const now = options.now ?? Date.now;
  const minimumValidityMs =
    options.minimumValidityMs ?? EXTERNAL_CREDENTIAL_MINIMUM_VALIDITY_MS;
  const readAttempts = Math.max(1, options.readAttempts ?? DEFAULT_READ_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  /** Transient read/parse states and app-server non-atomic-write windows get a
   * bounded retry; a missing credential does not. */
  const readWithRetry = async (
    signal?: AbortSignal,
  ): Promise<CodexExternalAuthRead> => {
    const canonicalPath = await canonicalCodexAuthPath(options.authPath);
    let latest: CodexExternalAuthRead | undefined;
    for (let attempt = 0; attempt < readAttempts; attempt += 1) {
      signal?.throwIfAborted();
      latest = await readCodexExternalAuth(canonicalPath, { canonicalPath });
      if (latest.state === "ok" || latest.state === "missing") return latest;
      if (attempt + 1 < readAttempts) await wait(retryDelayMs * (attempt + 1));
    }
    return latest!;
  };

  return Object.freeze({
    read(options?: { readonly signal?: AbortSignal }): Promise<CodexExternalAuthRead> {
      return readWithRetry(options?.signal);
    },

    async resolve(resolveOptions?: {
      readonly signal?: AbortSignal;
    }): Promise<ExternalCredentialResolution> {
      const signal = resolveOptions?.signal;
      signal?.throwIfAborted();
      const first = await readWithRetry(signal);
      if (first.state !== "ok") {
        return unavailable(
          first.canonicalPath,
          first.state,
          first.reason,
        );
      }

      const currentTime = now();
      if (
        hasSufficientValidity(first, currentTime, minimumValidityMs) &&
        !needsCodexRefresh(first, currentTime)
      ) {
        return Object.freeze({
          state: "ok",
          canonicalPath: first.canonicalPath,
          tokenRevision: first.tokenRevision,
          accountId: first.accountId,
          credential: first.credential,
          refreshed: false,
        });
      }

      const delegation = await options.refresher.refresh({
        canonicalPath: first.canonicalPath,
        ...(signal === undefined ? {} : { signal }),
      });
      if (delegation.outcome !== "completed") {
        return unavailable(
          first.canonicalPath,
          "refresh_unavailable",
          delegation.reason,
        );
      }

      // Every waiter re-reads and re-validates after the shared run; RPC
      // success alone is never accepted.
      const second = await readWithRetry(signal);
      if (second.state !== "ok") {
        return unavailable(
          first.canonicalPath,
          "verification_failed",
          second.state,
        );
      }
      if (
        second.canonicalPath !== first.canonicalPath ||
        second.accountId !== first.accountId
      ) {
        return unavailable(
          first.canonicalPath,
          "verification_failed",
          "identity_changed",
        );
      }
      if (second.tokenRevision === first.tokenRevision) {
        return unavailable(
          first.canonicalPath,
          "verification_failed",
          "revision_unchanged",
        );
      }
      if (!hasSufficientValidity(second, now(), minimumValidityMs)) {
        return unavailable(
          first.canonicalPath,
          "verification_failed",
          "insufficient_validity",
        );
      }
      return Object.freeze({
        state: "ok",
        canonicalPath: second.canonicalPath,
        tokenRevision: second.tokenRevision,
        accountId: second.accountId,
        credential: second.credential,
        refreshed: true,
      });
    },
  });
}
