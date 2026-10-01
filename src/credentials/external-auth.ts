import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * Codex-owned external `auth.json` source for the `openai-codex` provider.
 *
 * The document is Codex's: Token reads it, may request an in-place refresh
 * through the Codex app-server, and never writes, copies, moves, or deletes
 * it. The same payload family is used for Token-internal Profiles, but the
 * two sources have different ownership, path, and refresh rules.
 */

export const EXTERNAL_AUTH_PROVIDER_ID = "openai-codex" as const;
export const EXTERNAL_AUTH_PROVIDER_LABEL = "Codex (ChatGPT)" as const;
export const EXTERNAL_AUTH_DISPLAY_NAME = "Codex login" as const;
export const CODEX_ACCOUNT_CLAIM_KEY = "https://api.openai.com/auth" as const;

/** Refresh trigger thresholds, matching the Codex AuthManager. */
export const EXTERNAL_AUTH_REFRESH_WINDOW_MS = 5 * 60_000;
export const EXTERNAL_AUTH_STALE_LAST_REFRESH_MS = 8 * 24 * 60 * 60_000;

/** The Codex-owned document path. This is never the Token Pi credential
 * store's obsolete single-slot `auth.json`; it lives under `<CODEX_HOME>` and
 * is owned by Codex. */
export function codexExternalAuthPath(codexHome: string): string {
  return join(codexHome, "auth.json");
}

export interface CodexExternalAuthCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export type CodexExternalAuthRead =
  | {
      readonly state: "ok";
      /** Resolved, canonical path actually read. */
      readonly canonicalPath: string;
      /** Content hash of the document bytes. */
      readonly tokenRevision: string;
      readonly accountId: string;
      /** Undefined when `exp` is missing or unparseable; the caller must
       * delegate a Codex-native refresh and re-read rather than treat it as
       * live. */
      readonly expiresAt?: number;
      readonly lastRefreshAt?: number;
      /** Token material; never projected outside the credential owner. */
      readonly credential?: CodexExternalAuthCredential;
    }
  | {
      readonly state: "missing" | "invalid" | "unreadable";
      readonly canonicalPath: string;
      readonly reason: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function accessTokenPayload(accessToken: string): Record<string, unknown> | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as unknown;
    return isRecord(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** `exp` is a numeric epoch in seconds; a millisecond-scale value is accepted
 * for robustness against local test fixtures. Unparseable expiry returns
 * undefined and is never treated as live. */
function parseExpiry(payload: Record<string, unknown>): number | undefined {
  const value = payload.exp;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value > 1e12 ? value : value * 1000;
}

function parseLastRefresh(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Account-claim intersection contract (plan section 3.4): the nested claim is
 * required; a top-level `chatgpt_account_id` and `tokens.account_id` must
 * match it when present. A top-level-only document is rejected, and Token
 * never rewrites the JWT or injects headers to widen acceptance.
 */
export function resolveCodexAccountIdentity(
  accessToken: string,
  tokensAccountId: string | undefined,
): { readonly accountId: string } | { readonly error: string } {
  const payload = accessTokenPayload(accessToken);
  if (payload === undefined) {
    return Object.freeze({ error: "Access token payload is not decodable" });
  }
  const nested = usableText(
    isRecord(payload[CODEX_ACCOUNT_CLAIM_KEY])
      ? (payload[CODEX_ACCOUNT_CLAIM_KEY] as Record<string, unknown>).chatgpt_account_id
      : undefined,
  );
  if (nested === undefined) {
    return Object.freeze({ error: "Nested ChatGPT account claim is missing" });
  }
  const top = usableText(payload.chatgpt_account_id);
  if (top !== undefined && top !== nested) {
    return Object.freeze({ error: "Top-level ChatGPT account claim conflicts" });
  }
  if (tokensAccountId !== undefined && tokensAccountId !== nested) {
    return Object.freeze({ error: "Stored account id conflicts with the token claim" });
  }
  return Object.freeze({ accountId: nested });
}

export interface ParsedCodexExternalAuth {
  readonly accountId: string;
  readonly credential?: CodexExternalAuthCredential;
  readonly expiresAt?: number;
  readonly lastRefreshAt?: number;
}

export type ParseCodexExternalAuthResult =
  | { readonly state: "ok"; readonly auth: ParsedCodexExternalAuth }
  | { readonly state: "invalid"; readonly reason: string };

/**
 * Tolerant parser for the Codex ChatGPT branch. API-key, agent-identity, PAT,
 * Bedrock, and similar modes are unsupported for this source and are never
 * coerced into ChatGPT tokens.
 */
export function parseCodexExternalAuth(raw: string): ParseCodexExternalAuthResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return Object.freeze({ state: "invalid", reason: "Document is not valid JSON" });
  }
  if (!isRecord(parsed)) {
    return Object.freeze({ state: "invalid", reason: "Document is not a JSON object" });
  }
  if (parsed.auth_mode !== "chatgpt") {
    return Object.freeze({
      state: "invalid",
      reason: "Document is not a ChatGPT auth document",
    });
  }
  const tokens = parsed.tokens;
  if (!isRecord(tokens)) {
    return Object.freeze({ state: "invalid", reason: "Token set is missing" });
  }
  const accessToken = usableText(tokens.access_token);
  const refreshToken = usableText(tokens.refresh_token);
  if (accessToken === undefined || refreshToken === undefined) {
    return Object.freeze({
      state: "invalid",
      reason: "Access or refresh token is missing",
    });
  }
  const tokensAccountId = usableText(tokens.account_id);
  const identity = resolveCodexAccountIdentity(accessToken, tokensAccountId);
  if ("error" in identity) {
    return Object.freeze({ state: "invalid", reason: identity.error });
  }
  const payload = accessTokenPayload(accessToken)!;
  const expiresAt = parseExpiry(payload);
  const lastRefreshAt = parseLastRefresh(parsed.last_refresh);
  return Object.freeze({
    state: "ok",
    auth: Object.freeze({
      accountId: identity.accountId,
      ...(expiresAt === undefined
        ? {}
        : {
            credential: Object.freeze({
              accessToken,
              refreshToken,
              expiresAt,
            }),
          }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(lastRefreshAt === undefined ? {} : { lastRefreshAt }),
    }),
  });
}

/** Resolve the canonical path of the external document without following a
 * missing path into a different location. Missing paths still resolve to the
 * requested location so the caller can report a stable identity. */
export async function canonicalCodexAuthPath(authPath: string): Promise<string> {
  try {
    const info = await lstat(authPath);
    if (info.isDirectory()) return authPath;
    return await realpath(authPath);
  } catch {
    return authPath;
  }
}

export interface ReadCodexExternalAuthOptions {
  /** Override to read a specific already-resolved path. Production resolves
   * the canonical path first. */
  readonly canonicalPath?: string;
}

export async function readCodexExternalAuth(
  authPath: string,
  options: ReadCodexExternalAuthOptions = {},
): Promise<CodexExternalAuthRead> {
  const canonicalPath =
    options.canonicalPath ?? (await canonicalCodexAuthPath(authPath));
  let raw: string;
  try {
    const info = await lstat(canonicalPath);
    if (info.isDirectory()) {
      return Object.freeze({
        state: "unreadable",
        canonicalPath,
        reason: "Codex auth path is a directory",
      });
    }
    raw = await readFile(canonicalPath, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return Object.freeze({
        state: "missing",
        canonicalPath,
        reason: "Codex auth document is absent",
      });
    }
    return Object.freeze({
      state: "unreadable",
      canonicalPath,
      reason: "Codex auth document could not be read",
    });
  }
  const tokenRevision = createHash("sha256").update(raw, "utf8").digest("hex");
  const parsed = parseCodexExternalAuth(raw);
  if (parsed.state === "invalid") {
    return Object.freeze({
      state: "invalid",
      canonicalPath,
      reason: parsed.reason,
    });
  }
  return Object.freeze({
    state: "ok",
    canonicalPath,
    tokenRevision,
    accountId: parsed.auth.accountId,
    ...(parsed.auth.expiresAt === undefined
      ? {}
      : { expiresAt: parsed.auth.expiresAt }),
    ...(parsed.auth.lastRefreshAt === undefined
      ? {}
      : { lastRefreshAt: parsed.auth.lastRefreshAt }),
    ...(parsed.auth.credential === undefined
      ? {}
      : { credential: parsed.auth.credential }),
  });
}

/**
 * Freshness trigger (plan section 3.2 item 1): access token expires within
 * five minutes, or expiry is unparseable and `last_refresh` is older than
 * eight days.
 */
export function needsCodexRefresh(
  read: Extract<CodexExternalAuthRead, { readonly state: "ok" }>,
  now: number,
): boolean {
  if (read.expiresAt === undefined) {
    return (
      read.lastRefreshAt === undefined ||
      now - read.lastRefreshAt > EXTERNAL_AUTH_STALE_LAST_REFRESH_MS
    );
  }
  return read.expiresAt - now <= EXTERNAL_AUTH_REFRESH_WINDOW_MS;
}

/** Sufficient validity is Token's own added constraint; Pi's five-minute
 * window is only a refresh trigger, not a validity guarantee. */
export function hasSufficientValidity(
  read: Extract<CodexExternalAuthRead, { readonly state: "ok" }>,
  now: number,
  minimumValidityMs: number,
): read is Extract<CodexExternalAuthRead, { readonly state: "ok" }> & {
  readonly credential: CodexExternalAuthCredential;
} {
  return read.expiresAt !== undefined && read.expiresAt - now > minimumValidityMs;
}
