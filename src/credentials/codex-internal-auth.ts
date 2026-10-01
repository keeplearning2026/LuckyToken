import type { Credential } from "@earendil-works/pi-ai";
import { parseCodexExternalAuth, resolveCodexAccountIdentity } from "./codex-auth.js";

/** The public Pi credential lacks Codex's refresh timestamp/id_token. Keep
 * those facts unknown, rather than manufacturing them or changing the JWT. */
export function serializeCodexInternalAuth(credential: Credential): string {
  if (credential.type !== "oauth") throw new Error("Codex internal auth requires OAuth");
  const identity = resolveCodexAccountIdentity(credential.access, undefined);
  if ("error" in identity) throw new Error("Codex internal auth requires the nested account claim");
  const document = {
    auth_mode: "chatgpt",
    tokens: { access_token: credential.access, refresh_token: credential.refresh, account_id: identity.accountId },
    last_refresh: null,
  };
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const parsed = parseCodexExternalAuth(content);
  if (parsed.state !== "ok" || parsed.auth.credential?.expiresAt !== credential.expires) {
    throw new Error("Codex internal auth requires a valid, consistent JWT expiry");
  }
  return content;
}

export function parseCodexInternalAuth(content: string): Credential | undefined {
  const parsed = parseCodexExternalAuth(content);
  if (parsed.state !== "ok" || parsed.auth.credential === undefined) return undefined;
  const { accessToken: access, refreshToken: refresh, expiresAt: expires } = parsed.auth.credential;
  return { type: "oauth", access, refresh, expires };
}
