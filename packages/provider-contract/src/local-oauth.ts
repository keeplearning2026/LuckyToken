import type { OAuthCredential } from "@earendil-works/pi-ai";

/** Another application owns this file. Token may only read it. */
export interface ExternalCredentialReference {
  readonly owner: "external";
  readonly path: string;
}

/** Provider code discovers and parses credentials; Token owns Profile lifecycle
 * and credential-file I/O. Register during createProvider(), once per Provider. */
export interface LocalOAuthRegistration {
  readonly providerId: string;
  readonly label: () => string | undefined;
  readonly icon: "key" | "account" | "terminal";
  acquire(signal?: AbortSignal): Promise<ExternalCredentialReference | null>;
  read(raw: string): OAuthCredential | undefined;
}

export function assertLocalOAuthRegistration(
  value: unknown,
): asserts value is LocalOAuthRegistration {
  if (
    typeof value !== "object" || value === null ||
    !("providerId" in value) || typeof value.providerId !== "string" ||
    !("label" in value) || typeof value.label !== "function" ||
    !("icon" in value) ||
    (value.icon !== "key" && value.icon !== "account" && value.icon !== "terminal") ||
    !("acquire" in value) || typeof value.acquire !== "function" ||
    !("read" in value) || typeof value.read !== "function"
  ) {
    throw new TypeError("Invalid local OAuth registration");
  }
}
