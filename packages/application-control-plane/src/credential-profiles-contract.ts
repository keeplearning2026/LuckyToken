import type { AuthInteractionChannel, ProviderSource } from "./contracts.js";

/** Reserved `activeCredentialId` value selecting the Provider's declared
 * external credential source instead of a managed Profile. It lives in the
 * same single selection field as managed Profile ids; there is no second
 * active pointer. The Renderer compares against this constant and never
 * derives the value itself. */
export const EXTERNAL_CREDENTIAL_SELECTION_ID = "external" as const;

export type CredentialProfileAuthType = "api_key" | "oauth";
export type CredentialProfileHealth =
  | "ready"
  | "not_yet_verified"
  | "refreshing"
  | "cooling_down"
  | "reconnect_required"
  | "disabled";

/** Which credential source currently serves a Provider.
 *
 * `unselected` is the fail-closed state: managed Profiles exist but no
 * enabled active selection is set. It never falls back to another source. */
export type ProviderCredentialSelection<
  TProfile extends { readonly credentialId: string },
> =
  | { readonly kind: "profile"; readonly profile: TProfile }
  | { readonly kind: "external" }
  | { readonly kind: "unselected" };

const EXTERNAL_SELECTION = Object.freeze({ kind: "external" as const });
const UNSELECTED_SELECTION = Object.freeze({ kind: "unselected" as const });

/** Single authority for "which credential source serves this Provider".
 *
 * Backend binding and every projection consumer (usable/attention/Renderer)
 * resolve this one rule so they cannot drift:
 * - an explicit selection wins;
 * - a reserved external selection requires a declared external source;
 * - with no explicit selection, zero managed Profiles plus a declared
 *   external source means the external source (the Codex-login default);
 * - anything else is `unselected` and fails closed.
 */
export function resolveProviderCredentialSelection<
  TProfile extends { readonly credentialId: string },
>(input: {
  readonly activeCredentialId: string | undefined;
  readonly profiles: readonly TProfile[];
  readonly declaredExternalSource: boolean;
}): ProviderCredentialSelection<TProfile> {
  if (input.activeCredentialId === EXTERNAL_CREDENTIAL_SELECTION_ID) {
    return input.declaredExternalSource ? EXTERNAL_SELECTION : UNSELECTED_SELECTION;
  }
  if (input.activeCredentialId !== undefined) {
    const profile = input.profiles.find(
      (candidate) => candidate.credentialId === input.activeCredentialId,
    );
    return profile === undefined
      ? UNSELECTED_SELECTION
      : Object.freeze({ kind: "profile" as const, profile });
  }
  return input.profiles.length === 0 && input.declaredExternalSource
    ? EXTERNAL_SELECTION
    : UNSELECTED_SELECTION;
}

/** Whether the Provider declares a Token-addressable external credential
 * source. `displayName` is present only for a declared file source; the
 * pre-existing environment/CLI ambient projection has no label. */
export function hasDeclaredExternalCredentialSource(
  provider: ProviderCredentialProfilesProjectionV1,
): boolean {
  return provider.ambient?.displayName !== undefined;
}

export interface CredentialProfileProjectionV1 {
  readonly credentialId: string;
  readonly authType: CredentialProfileAuthType;
  readonly authMethodLabel: string;
  readonly displayName: string;
  readonly note?: string;
  readonly identityHint?: string;
  readonly enabled: boolean;
  readonly health: CredentialProfileHealth;
  readonly priority: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt?: number;
  readonly lastSucceededAt?: number;
}

export interface ProviderCredentialProfilesProjectionV1 {
  readonly providerId: string;
  readonly implementationAvailable: boolean;
  readonly revision?: string;
  readonly selectionGeneration?: string;
  /** The single active selection: a managed Profile id, or
   * `EXTERNAL_CREDENTIAL_SELECTION_ID` for the declared external source. */
  readonly activeCredentialId?: string;
  readonly switchPolicy?: {
    readonly apiKeyOn429: boolean;
    readonly oauthOn429: boolean;
  };
  readonly recordError?: {
    readonly code: "invalid_record" | "storage_error";
    readonly message: string;
  };
  /** External auth source presentation. `connected` reports a locally valid
   * source document; `configured` reports a locally present
   * but temporarily unreadable document; `unknown` reports no local signal. */
  readonly ambient?: {
    readonly kind: "external";
    readonly status: "connected" | "configured" | "unknown";
    /** Bounded Backend-projected source label; Renderer never derives it. */
    readonly displayName?: string;
    readonly message: string;
  };
  readonly profiles: readonly CredentialProfileProjectionV1[];
}

export interface CredentialProfilesProjectionV1 {
  readonly providers: readonly ProviderCredentialProfilesProjectionV1[];
}

export interface ProviderCredentialAuthMethodProjection {
  readonly authType: CredentialProfileAuthType;
  readonly authMethodLabel: string;
  readonly interactive: boolean;
}

export interface ProviderCredentialOptionProjection {
  readonly providerId: string;
  readonly name: string;
  readonly source: ProviderSource;
  readonly authMethods: readonly ProviderCredentialAuthMethodProjection[];
}

export interface CredentialProfileOptionsProjection {
  readonly providers: readonly ProviderCredentialOptionProjection[];
}

interface ProfileMutationCommandBase {
  readonly providerId: string;
  readonly credentialId: string;
  readonly expectedRevision: string;
}

export type CredentialProfilesCommand =
  | { readonly command: "query"; readonly providerIds?: readonly string[] }
  | (ProfileMutationCommandBase & {
      readonly command: "update_metadata";
      readonly displayName: string;
      readonly note?: string;
    })
  | (ProfileMutationCommandBase & { readonly command: "activate" })
  | (ProfileMutationCommandBase & {
      readonly command: "set_enabled";
      readonly enabled: boolean;
    })
  | (ProfileMutationCommandBase & {
      readonly command: "set_priority";
      readonly priority: number;
    })
  | {
      readonly command: "reorder_profiles";
      readonly providerId: string;
      readonly credentialIds: readonly string[];
      readonly expectedRevision: string;
    }
  | (ProfileMutationCommandBase & { readonly command: "remove" })
  | {
      readonly command: "set_switch_policy";
      readonly providerId: string;
      readonly expectedRevision: string;
      readonly apiKeyOn429: boolean;
      readonly oauthOn429: boolean;
    }
  | (ProfileMutationCommandBase & { readonly command: "recheck" });

export type CredentialProfilesCommandOutcome =
  | "ok"
  | "conflict"
  | "invalid"
  | "duplicate"
  | "unknown_provider"
  | "unknown_profile"
  | "reconnect_required"
  | "storage_failure"
  | "unavailable";

export interface CredentialProfilesCommandResult {
  readonly outcome: CredentialProfilesCommandOutcome;
  readonly state: CredentialProfilesProjectionV1;
  readonly options?: CredentialProfileOptionsProjection;
  readonly error?: string;
}

export type ProviderProfileAuthCommand =
  | { readonly command: "query" }
  | {
      readonly command: "login";
      readonly providerId: string;
      readonly authType: CredentialProfileAuthType;
      readonly displayName: string;
      readonly note?: string;
      readonly useNow: boolean;
      readonly expectedRevision: string;
    }
  | {
      readonly command: "reconnect";
      readonly providerId: string;
      readonly credentialId: string;
      readonly useNow: boolean;
      readonly expectedRevision: string;
    };

export type ProviderProfileAuthCommandOutcome =
  | "ok"
  | "cancelled"
  | "failed"
  | "conflict"
  | "invalid"
  | "duplicate"
  | "unknown_provider"
  | "unknown_profile"
  | "storage_failure"
  | "unavailable";

export interface ProviderProfileAuthCommandResult {
  readonly outcome: ProviderProfileAuthCommandOutcome;
  readonly state: CredentialProfilesProjectionV1;
  readonly options?: CredentialProfileOptionsProjection;
  readonly error?: string;
}

export type CredentialProfilesCommandHandler = (
  command: CredentialProfilesCommand,
) => Promise<CredentialProfilesCommandResult>;

export type ProviderProfileAuthCommandHandler = (
  command: ProviderProfileAuthCommand,
  interaction: AuthInteractionChannel,
) => Promise<ProviderProfileAuthCommandResult>;
