import type { AuthInteractionChannel, ProviderSource } from "./contracts.js";

export type CredentialProfileAuthType = "api_key" | "oauth";
export type CredentialProfileAcquisitionKind =
  | "api_key"
  | "oauth"
  | "local_oauth";
export type CredentialProfileAcquisitionIcon = "key" | "account" | "terminal";

export interface CredentialProfileProjection {
  readonly credentialId: string;
  readonly authType: CredentialProfileAuthType;
  readonly acquisitionKind: CredentialProfileAcquisitionKind;
  readonly authMethodLabel: string;
  readonly displayName: string;
  readonly note?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt?: number;
  readonly lastSucceededAt?: number;
}

export interface ProviderCredentialProfilesProjection {
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
    readonly displayName?: string;
    readonly message: string;
  };
  readonly profiles: readonly CredentialProfileProjection[];
}

export interface CredentialProfilesProjection {
  readonly providers: readonly ProviderCredentialProfilesProjection[];
}

export interface CredentialProfileAcquisitionOptionProjection {
  readonly kind: CredentialProfileAcquisitionKind;
  readonly label: string;
  readonly icon: CredentialProfileAcquisitionIcon;
  readonly authType: CredentialProfileAuthType;
  readonly interactive: boolean;
  readonly state: "available" | "already_connected";
}

export interface ProviderCredentialOptionProjection {
  readonly providerId: string;
  readonly name: string;
  readonly source: ProviderSource;
  readonly acquisitionOptions: readonly CredentialProfileAcquisitionOptionProjection[];
}

export interface CredentialProfileOptionsProjection {
  readonly providers: readonly ProviderCredentialOptionProjection[];
}

export interface CredentialManagementOperationProjection {
  readonly operationId: string;
  readonly kind: string;
  readonly providerId?: string;
  readonly startedAt: number;
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
  | {
      readonly command: "cancel_management";
      readonly operationId: string;
    };

export type CredentialProfilesCommandOutcome =
  | "ok"
  | "conflict"
  | "invalid"
  | "duplicate"
  | "unknown_provider"
  | "unknown_profile"
  | "unknown_operation"
  | "management_operation_in_progress"
  | "storage_failure"
  | "unavailable";

export interface CredentialProfilesCommandResult {
  readonly outcome: CredentialProfilesCommandOutcome;
  readonly state: CredentialProfilesProjection;
  readonly options?: CredentialProfileOptionsProjection;
  readonly activeOperation?: CredentialManagementOperationProjection;
  readonly error?: string;
}

export type ProviderProfileAuthCommand =
  | { readonly command: "query" }
  | {
      readonly command: "login";
      readonly providerId: string;
      readonly acquisitionKind: CredentialProfileAcquisitionKind;
      readonly displayName: string;
      readonly note?: string;
    };

export type ProviderProfileAuthCommandOutcome =
  | "ok"
  | "cancelled"
  | "failed"
  | "invalid"
  | "duplicate"
  | "unknown_provider"
  | "unknown_profile"
  | "management_operation_in_progress"
  | "storage_failure"
  | "unavailable";

export interface ProviderProfileAuthCommandResult {
  readonly outcome: ProviderProfileAuthCommandOutcome;
  readonly state: CredentialProfilesProjection;
  readonly options?: CredentialProfileOptionsProjection;
  readonly activeOperation?: CredentialManagementOperationProjection;
  readonly error?: string;
}

export type CredentialProfilesCommandHandler = (
  command: CredentialProfilesCommand,
) => Promise<CredentialProfilesCommandResult>;

export type ProviderProfileAuthCommandHandler = (
  command: ProviderProfileAuthCommand,
  interaction: AuthInteractionChannel,
) => Promise<ProviderProfileAuthCommandResult>;
