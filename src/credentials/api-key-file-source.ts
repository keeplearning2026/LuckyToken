import { createHash } from "node:crypto";
import { createExternalCredentialSource, type ExternalCredentialSource } from "./external-credential-source.js";

/** Key files have no provable account identity: changing the key changes the
 * grant. Whitespace changes only revision. Login JSON needs its own decoder. */
export function createApiKeyFileSource(options: {
  readonly path: string;
  readonly authMethodLabel: string;
  readonly displayName: string;
}): ExternalCredentialSource {
  return createExternalCredentialSource({ ...options, authType: "api_key",
    decode(raw) {
      const key = raw.trim();
      if (key.length === 0 || /[\r\n\u0000]/u.test(key)) {
        return { state: "invalid", reason: "Expected one non-empty API key" };
      }
      return { state: "ok", document: {
        identityKey: createHash("sha256").update(key).digest("hex"),
        credential: Object.freeze({ type: "api_key", key }),
      } };
    },
  });
}
