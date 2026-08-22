import type { AuthInteractionChannel, ProviderSource } from "./contracts.js";

export type CredentialProfileAuthType = "api_key" | "oauth";
export type CredentialProfileHealth =
  | "ready"
  | "not_yet_verified"
  | "refreshing"
  | "cooling_down"
  | "reconnect_required"
  | "disabled";

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
  readonly activeCredentialId?: string;
  readonly switchPolicy?: {
    readonly apiKeyOn429: boolean;
    readonly oauthOn429: boolean;
  };
  readonly recordError?: {
    readonly code: "invalid_record" | "storage_error";
    readonly message: string;
  };
  readonly ambient?: {
    readonly kind: "external";
    readonly status: "configured" | "unknown";
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
