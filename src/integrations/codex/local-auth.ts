import { timingSafeEqual } from "node:crypto";
import { readFile, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ReadonlyHeaders } from "../../request-identity.js";
import type {
  CodexForwardAuth,
  CodexLocalCredentialAuthority,
} from "../../codex-native-seam.js";
import { resolveCodexHome } from "./home.js";

const readFileAsync = promisify(readFile);
const REDACTION = "[REDACTED]";
const MAX_SCRUB_TOKENS = 2;

interface CodexCredentialSnapshot {
  readonly accessToken: string;
  readonly accountId?: string;
}

export interface CodexLocalCredentialAuthorityOptions {
  readonly codexHome?: string;
}

function parseSnapshot(raw: string): CodexCredentialSnapshot | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const tokens = (parsed as { tokens?: unknown }).tokens;
    if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
      return undefined;
    }
    const accessToken = (tokens as { access_token?: unknown }).access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return undefined;
    }
    const accountId = (tokens as { account_id?: unknown }).account_id;
    return {
      accessToken,
      ...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
    };
  } catch {
    return undefined;
  }
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function bearerCredential(headers: ReadonlyHeaders): string | undefined {
  const authorization = headers.get("authorization");
  const match = authorization?.match(/^Bearer[ \t]+(.+)$/iu);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

export function createCodexLocalCredentialAuthority(
  options: CodexLocalCredentialAuthorityOptions = {},
): CodexLocalCredentialAuthority {
  const codexHome = options.codexHome ?? resolveCodexHome();
  const authPath = join(codexHome, "auth.json");
  const scrubTokens: string[] = [];

  const rememberForScrub = (token: string): void => {
    const existing = scrubTokens.indexOf(token);
    if (existing >= 0) scrubTokens.splice(existing, 1);
    scrubTokens.unshift(token);
    if (scrubTokens.length > MAX_SCRUB_TOKENS) scrubTokens.length = MAX_SCRUB_TOKENS;
  };

  const observeSynchronously = (): void => {
    try {
      const snapshot = parseSnapshot(readFileSync(authPath, "utf8"));
      if (snapshot !== undefined) rememberForScrub(snapshot.accessToken);
    } catch {
      // Missing/unreadable credentials are an unavailable auth source, never a startup failure.
    }
  };
  observeSynchronously();

  const readCurrent = async (): Promise<CodexCredentialSnapshot | undefined> => {
    try {
      const raw = await readFileAsync(authPath, "utf8");
      const snapshot = parseSnapshot(raw);
      if (snapshot !== undefined) rememberForScrub(snapshot.accessToken);
      return snapshot;
    } catch {
      return undefined;
    }
  };

  return Object.freeze({
    async isAvailable(): Promise<boolean> {
      return (await readCurrent()) !== undefined;
    },
    async resolveForwardAuth(headers: ReadonlyHeaders): Promise<CodexForwardAuth | undefined> {
      const incoming = bearerCredential(headers);
      if (incoming === undefined) return undefined;
      const current = await readCurrent();
      if (current === undefined || !equalSecret(incoming, current.accessToken)) {
        return undefined;
      }
      return Object.freeze({
        authorization: `Bearer ${current.accessToken}`,
        ...(current.accountId === undefined ? {} : { accountId: current.accountId }),
      });
    },
    scrub(value: string): string {
      let output = value;
      for (const token of scrubTokens) {
        if (token.length > 0) output = output.split(token).join(REDACTION);
      }
      return output;
    },
  });
}
