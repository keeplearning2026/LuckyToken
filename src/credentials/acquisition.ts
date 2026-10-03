import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { LocalOAuthRegistration } from "@token/provider-contract/local-oauth";

export type AcquisitionKind = "api_key" | "oauth" | "local_oauth";
export type AcquisitionIcon = "key" | "account" | "terminal";

export const LOCAL_LOGIN_DUPLICATE_MESSAGE =
  "A local login Profile already exists. Remove it first to add another local login Profile.";
export const LOCAL_LOGIN_FAILURE_MESSAGE =
  "The local login source is unavailable. Sign in with the local app and try again.";

export class LocalAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAcquisitionError";
  }
}

/** Provider parser failures must never expose credential-file content. */
export function readLocalOAuthCredential(
  registration: LocalOAuthRegistration,
  raw: string,
): OAuthCredential | undefined {
  try {
    const credential = registration.read(raw);
    if (
      credential?.type !== "oauth" ||
      typeof credential.access !== "string" ||
      typeof credential.refresh !== "string" ||
      typeof credential.expires !== "number" ||
      !Number.isFinite(credential.expires)
    ) return undefined;
    return structuredClone(credential);
  } catch {
    return undefined;
  }
}
