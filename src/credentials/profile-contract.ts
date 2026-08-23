import type { AuthType } from "@earendil-works/pi-ai";

export type CredentialHealth =
  | "ready"
  | "not_yet_verified"
  | "refreshing"
  | "cooling_down"
  | "reconnect_required"
  | "disabled";

export interface CredentialProfileProjection {
  readonly credentialId: string;
  readonly authType: AuthType;
  readonly authMethodLabel: string;
  readonly displayName: string;
  readonly note?: string;
  readonly identityHint?: string;
  readonly enabled: boolean;
  readonly health: CredentialHealth;
  readonly priority: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt?: number;
  readonly lastSucceededAt?: number;
}

export interface ProviderCredentialStateProjection {
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
  readonly profiles: readonly CredentialProfileProjection[];
}

export interface CredentialProfilesProjection {
  readonly providers: readonly ProviderCredentialStateProjection[];
}

export interface ProfileTargetInput {
  readonly providerId: string;
  readonly credentialId: string;
  readonly expectedRevision: string;
}

export interface UpdateProfileMetadataInput extends ProfileTargetInput {
  readonly displayName: string;
  readonly note?: string;
}

export type ActivateProfileInput = ProfileTargetInput;
export type RemoveProfileInput = ProfileTargetInput;

export interface SetProfileEnabledInput extends ProfileTargetInput {
  readonly enabled: boolean;
}

export interface SetProfilePriorityInput extends ProfileTargetInput {
  readonly priority: number;
}

export interface ReorderProfilesInput {
  readonly providerId: string;
  readonly expectedRevision: string;
  readonly credentialIds: readonly string[];
}

export interface SetProviderSwitchPolicyInput {
  readonly providerId: string;
  readonly expectedRevision: string;
  readonly apiKeyOn429: boolean;
  readonly oauthOn429: boolean;
}

export type ProfileMutationOutcome =
  | "ok"
  | "conflict"
  | "invalid"
  | "duplicate"
  | "unknown_provider"
  | "unknown_profile"
  | "storage_failure"
  | "unavailable";

export interface ProfileMutationResult {
  readonly outcome: ProfileMutationOutcome;
  readonly provider?: ProviderCredentialStateProjection;
  readonly error?: string;
}

export class CredentialProfileOperationError extends Error {
  readonly outcome: Exclude<ProfileMutationOutcome, "ok">;

  constructor(outcome: Exclude<ProfileMutationOutcome, "ok">, message: string) {
    super(message);
    this.name = "CredentialProfileOperationError";
    this.outcome = outcome;
  }
}

export interface CredentialProfileManagement {
  query(providerIds?: readonly string[]): Promise<CredentialProfilesProjection>;
  snapshot(): CredentialProfilesProjection;
  updateMetadata(input: UpdateProfileMetadataInput): Promise<ProfileMutationResult>;
  activate(input: ActivateProfileInput): Promise<ProfileMutationResult>;
  setEnabled(input: SetProfileEnabledInput): Promise<ProfileMutationResult>;
  setPriority(input: SetProfilePriorityInput): Promise<ProfileMutationResult>;
  reorderProfiles(input: ReorderProfilesInput): Promise<ProfileMutationResult>;
  remove(input: RemoveProfileInput): Promise<ProfileMutationResult>;
  setSwitchPolicy(input: SetProviderSwitchPolicyInput): Promise<ProfileMutationResult>;
}

export interface CreateLoginBindingInput {
  readonly providerId: string;
  readonly authType: AuthType;
  readonly displayName: string;
  readonly note?: string;
  readonly useNow: boolean;
  readonly expectedRevision: string;
}

export interface CredentialLoginBinding {
  readonly kind: "login";
  readonly mode: "add" | "reconnect";
  readonly providerId: string;
  readonly authType: AuthType;
  readonly displayName: string;
  readonly note?: string;
  readonly useNow: boolean;
  readonly expectedRevision: string;
  readonly credentialId: string;
  readonly credentialGeneration: string;
}

export interface CreateReconnectBindingInput {
  readonly providerId: string;
  readonly credentialId: string;
  readonly useNow: boolean;
  readonly expectedRevision: string;
}

export interface CaptureProfileForRecheckInput {
  readonly providerId: string;
  readonly credentialId: string;
  readonly expectedRevision: string;
}

export type ProviderAuthBindingFacts =
  | {
      readonly kind: "managed";
      readonly providerId: string;
      readonly credentialId: string;
      readonly authType: AuthType;
      readonly authMethodLabel: string;
      readonly displayName: string;
      readonly credentialGeneration: string;
      readonly selectionGeneration: string;
    }
  | {
      readonly kind: "ambient";
      readonly providerId: string;
    };

export type ProviderAuthBindingCapture =
  | {
      readonly facts: Extract<
        ProviderAuthBindingFacts,
        { readonly kind: "managed" }
      >;
    }
  | {
      readonly facts: Extract<
        ProviderAuthBindingFacts,
        { readonly kind: "ambient" }
      >;
    };

export type ManagedProviderAuthBindingCapture = Extract<
  ProviderAuthBindingCapture,
  { readonly facts: { readonly kind: "managed" } }
>;

export function isManagedProviderAuthBindingCapture(
  capture: ProviderAuthBindingCapture,
): capture is ManagedProviderAuthBindingCapture {
  return capture.facts.kind === "managed";
}

export const MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3;

export interface AdvanceAfterFinal429Input {
  readonly capture: ManagedProviderAuthBindingCapture;
  readonly attemptedCredentialIds: readonly string[];
  readonly retryAfterMs?: number;
  readonly signal?: AbortSignal;
}

export type AdvanceAfterFinal429Result =
  | { readonly outcome: "switched"; readonly capture: ManagedProviderAuthBindingCapture }
  | { readonly outcome: "disabled" | "exhausted" | "stale_binding" | "storage_failure" };

export class ProviderAuthBindingError extends Error {
  readonly outcome:
    | "unknown_provider"
    | "no_active_profile"
    | "stale_binding"
    | "storage_failure";

  constructor(outcome: ProviderAuthBindingError["outcome"], message: string) {
    super(message);
    this.name = "ProviderAuthBindingError";
    this.outcome = outcome;
  }
}

export interface ProviderAuthBindingAuthority {
  capture(providerId: string): Promise<ProviderAuthBindingCapture>;
  captureForRecheck(
    input: CaptureProfileForRecheckInput,
  ): Promise<ProviderAuthBindingCapture>;
  createLoginBinding(input: CreateLoginBindingInput): Promise<CredentialLoginBinding>;
  createReconnectBinding(input: CreateReconnectBindingInput): Promise<CredentialLoginBinding>;
  advanceAfterFinal429(input: AdvanceAfterFinal429Input): Promise<AdvanceAfterFinal429Result>;
  /** Run publication only while this exact binding remains the current
   * Provider selection/incarnation. The callback must assert the supplied
   * lease immediately before each irreversible publication boundary. */
  publishIfCurrent(
    capture: ProviderAuthBindingCapture,
    publish: (assertCurrent: () => void) => Promise<void> | void,
  ): Promise<boolean>;
  runBound<T>(
    binding: CredentialLoginBinding | ProviderAuthBindingCapture,
    operation: () => Promise<T>,
  ): Promise<T>;
}
