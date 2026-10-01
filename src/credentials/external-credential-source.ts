import type { AuthType, Credential } from "@earendil-works/pi-ai";
import { readExternalCredentialFile } from "./external-credential-file.js";
import { createKeyedSingleFlight } from "./keyed-single-flight.js";

/** Pi refreshes inside this window. External sources resolve outside it
 * through their owner; Pi's writer never receives a stale credential. */
export const MINIMUM_EXTERNAL_OAUTH_VALIDITY_MS = 5 * 60_000;

export interface ExternalCredentialIdentity {
  readonly canonicalPath: string;
  /** Adapter-owned non-secret grant/principal identity. Never a raw key. */
  readonly identityKey: string;
  readonly tokenRevision: string;
}
export type ExternalCredentialRead =
  | ({ readonly state: "ok" } & ExternalCredentialIdentity)
  | { readonly state: "missing" | "invalid" | "unreadable";
      readonly canonicalPath: string; readonly reason: string };
export type ExternalCredentialUnavailableReason =
  | "missing" | "invalid" | "unreadable" | "refresh_unavailable" | "verification_failed";
export type ExternalCredentialResolution =
  | ({ readonly state: "ok"; readonly credential: Credential;
       readonly refreshed: boolean } & ExternalCredentialIdentity)
  | { readonly state: "unavailable"; readonly canonicalPath: string;
      readonly reason: ExternalCredentialUnavailableReason; readonly detail: string };

export interface ExternalCredentialSource {
  readonly authType: AuthType;
  readonly authMethodLabel: string;
  readonly displayName: string;
  /** Local identity capture: no secrets, delegation or network. */
  read(options?: { readonly signal?: AbortSignal }): Promise<ExternalCredentialRead>;
  /** Resolve a fresh request-local Pi credential; never persist in Token. */
  resolve(options?: { readonly signal?: AbortSignal }): Promise<ExternalCredentialResolution>;
}
export interface ExternalCredentialDocument {
  readonly identityKey: string;
  /** A parser may recognize an identity while its credential is unusable. */
  readonly credential?: Credential;
}
export type ExternalCredentialDecode =
  | { readonly state: "ok"; readonly document: ExternalCredentialDocument }
  | { readonly state: "invalid"; readonly reason: string };
export interface CreateExternalCredentialSourceOptions {
  readonly path: string;
  readonly authType: AuthType;
  readonly authMethodLabel: string;
  readonly displayName: string;
  /** Provider format and identity rules. Reasons must be bounded static
   * descriptions, never contents or parser exception text. */
  readonly decode: (raw: string) => ExternalCredentialDecode;
  /** Optional stronger provider constraint; cannot lower Pi's window. */
  readonly isUsable?: (document: ExternalCredentialDocument, now: number) => boolean;
  /** Owner-native in-place refresh with its own bounded timeout. Missing
   * delegation fails closed. No secret or waiter signal is passed here. */
  readonly refresh?: (input: { readonly canonicalPath: string }) => Promise<
    { readonly outcome: "completed" } | { readonly outcome: "unavailable"; readonly reason: string }>;
  readonly now?: () => number;
  readonly readAttempts?: number;
  readonly retryDelayMs?: number;
}
type DocumentRead =
  | ({ readonly state: "ok"; readonly document: ExternalCredentialDocument } & ExternalCredentialIdentity)
  | Exclude<ExternalCredentialRead, { readonly state: "ok" }>;
function unavailable(canonicalPath: string, reason: ExternalCredentialUnavailableReason,
  detail: string): ExternalCredentialResolution {
  return Object.freeze({ state: "unavailable", canonicalPath, reason, detail });
}

/** Provider-neutral lifecycle for externally owned credential files. */
export function createExternalCredentialSource(
  options: CreateExternalCredentialSourceOptions,
): ExternalCredentialSource {
  for (const [label, maximum] of [[options.displayName, 64], [options.authMethodLabel, 128]] as const) {
    if (label.length === 0 || label.trim() !== label || Array.from(label).length > maximum) {
      throw new Error("External credential source label is invalid");
    }
  }
  const now = options.now ?? Date.now;
  const attempts = options.readAttempts ?? 3;
  const delay = options.retryDelayMs ?? 25;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16 ||
    !Number.isFinite(delay) || delay < 0 || delay > 1000) {
    throw new Error("External credential read retry budget is invalid");
  }
  const freshness = createKeyedSingleFlight<ExternalCredentialResolution>();
  const isUsable = (document: ExternalCredentialDocument): boolean => {
    const credential = document.credential;
    const time = now();
    return credential !== undefined && credential.type === options.authType &&
      (credential.type !== "oauth" ||
        (Number.isFinite(credential.expires) && credential.expires - time > MINIMUM_EXTERNAL_OAUTH_VALIDITY_MS)) &&
      (options.isUsable?.(document, time) ?? true);
  };
  const readDocument = async (signal?: AbortSignal): Promise<DocumentRead> => {
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      const file = await readExternalCredentialFile(options.path);
      let read: DocumentRead;
      if (file.state !== "ok") read = file;
      else {
        let parsed: ExternalCredentialDecode;
        try { parsed = options.decode(file.raw); }
        catch { parsed = { state: "invalid", reason: "Credential document could not be decoded" }; }
        if (parsed.state === "invalid") {
          read = { state: "invalid", canonicalPath: file.canonicalPath, reason: parsed.reason };
        } else if (parsed.document.identityKey.length === 0 ||
          (parsed.document.credential !== undefined && parsed.document.credential.type !== options.authType)) {
          read = { state: "invalid", canonicalPath: file.canonicalPath, reason: "Credential identity or auth type is invalid" };
        } else {
          read = { state: "ok", canonicalPath: file.canonicalPath, tokenRevision: file.tokenRevision,
            identityKey: parsed.document.identityKey, document: parsed.document };
        }
      }
      if (read.state === "ok" || read.state === "missing" || attempt + 1 >= attempts) return read;
      await new Promise<void>((done) => setTimeout(done, delay * (attempt + 1)));
    }
  };
  const success = (read: Extract<DocumentRead, { readonly state: "ok" }>,
    refreshed: boolean): ExternalCredentialResolution => Object.freeze({
    state: "ok", canonicalPath: read.canonicalPath, identityKey: read.identityKey,
    tokenRevision: read.tokenRevision, credential: read.document.credential!, refreshed,
  });
  return Object.freeze({
    authType: options.authType, authMethodLabel: options.authMethodLabel, displayName: options.displayName,
    async read(readOptions?: { readonly signal?: AbortSignal }): Promise<ExternalCredentialRead> {
      const read = await readDocument(readOptions?.signal);
      if (read.state !== "ok") return read;
      return Object.freeze({ state: "ok", canonicalPath: read.canonicalPath,
        identityKey: read.identityKey, tokenRevision: read.tokenRevision });
    },
    async resolve(resolveOptions?: { readonly signal?: AbortSignal }): Promise<ExternalCredentialResolution> {
      const signal = resolveOptions?.signal;
      const first = await readDocument(signal);
      signal?.throwIfAborted();
      if (first.state !== "ok") return unavailable(first.canonicalPath, first.state, first.reason);
      if (isUsable(first.document)) return success(first, false);
      const result = await freshness.run(first.canonicalPath, async () => {
        // A previous refresh may have finished while this waiter was reading.
        const latest = await readDocument();
        if (latest.state !== "ok") return unavailable(first.canonicalPath, "verification_failed", latest.state);
        if (latest.canonicalPath !== first.canonicalPath || latest.identityKey !== first.identityKey) {
          return unavailable(first.canonicalPath, "verification_failed", "identity_changed");
        }
        if (isUsable(latest.document)) return success(latest, latest.tokenRevision !== first.tokenRevision);
        if (options.refresh === undefined) return unavailable(first.canonicalPath, "refresh_unavailable", "not_supported");
        let delegated: Awaited<ReturnType<NonNullable<typeof options.refresh>>>;
        try { delegated = await options.refresh({ canonicalPath: latest.canonicalPath }); }
        catch { return unavailable(first.canonicalPath, "refresh_unavailable", "delegate_failed"); }
        if (delegated.outcome !== "completed") return unavailable(first.canonicalPath, "refresh_unavailable", delegated.reason);
        const second = await readDocument();
        if (second.state !== "ok") return unavailable(first.canonicalPath, "verification_failed", second.state);
        if (second.canonicalPath !== latest.canonicalPath || second.identityKey !== latest.identityKey) {
          return unavailable(first.canonicalPath, "verification_failed", "identity_changed");
        }
        if (second.tokenRevision === latest.tokenRevision) return unavailable(first.canonicalPath, "verification_failed", "revision_unchanged");
        if (!isUsable(second.document)) return unavailable(first.canonicalPath, "verification_failed", "insufficient_validity");
        return success(second, true);
      }, signal);
      // Shared work may belong to another principal that raced this caller.
      if (result.state === "ok" &&
        (result.canonicalPath !== first.canonicalPath || result.identityKey !== first.identityKey)) {
        return unavailable(first.canonicalPath, "verification_failed", "identity_changed");
      }
      return result;
    },
  });
}
