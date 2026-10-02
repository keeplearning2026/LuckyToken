import type { AuthType } from "@earendil-works/pi-ai";

import type {
  AcquisitionKind,
  LocalOAuthAcquisition,
} from "./acquisition.js";

export interface CredentialProfileProjection {
  readonly credentialId: string;
  readonly acquisitionKind: AcquisitionKind;
  readonly authType: AuthType;
  readonly authMethodLabel: string;
  readonly displayName: string;
  readonly note?: string;
  readonly enabled: boolean;
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
    readonly displayName?: string;
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

  constructor(
    outcome: Exclude<ProfileMutationOutcome, "ok">,
    message: string,
  ) {
    super(message);
    this.name = "CredentialProfileOperationError";
    this.outcome = outcome;
  }
}

export interface AcquireLocalProfileInput {
  readonly providerId: string;
  readonly displayName: string;
  readonly note?: string;
  readonly acquisition: LocalOAuthAcquisition;
  readonly signal?: AbortSignal;
}

export interface CredentialProfileManagement {
  query(providerIds?: readonly string[]): Promise<CredentialProfilesProjection>;
  snapshot(): CredentialProfilesProjection;
  updateMetadata(input: UpdateProfileMetadataInput): Promise<ProfileMutationResult>;
  activate(input: ActivateProfileInput): Promise<ProfileMutationResult>;
  setEnabled(input: SetProfileEnabledInput): Promise<ProfileMutationResult>;
  reorderProfiles(input: ReorderProfilesInput): Promise<ProfileMutationResult>;
  remove(input: RemoveProfileInput): Promise<ProfileMutationResult>;
  setSwitchPolicy(input: SetProviderSwitchPolicyInput): Promise<ProfileMutationResult>;
  acquireLocal(input: AcquireLocalProfileInput): Promise<ProfileMutationResult>;
}

export interface CreateAcquisitionBindingInput {
  readonly providerId: string;
  readonly acquisitionKind: "api_key" | "oauth";
  readonly displayName: string;
  readonly note?: string;
}

export interface CredentialAcquisitionBinding {
  readonly kind: "acquisition";
  readonly providerId: string;
  readonly acquisitionKind: "api_key" | "oauth";
  readonly displayName: string;
  readonly note?: string;
  readonly credentialId: string;
}

export interface ProviderProfileBindingFacts {
  readonly kind: "profile";
  readonly providerId: string;
  readonly credentialId: string;
  readonly acquisitionKind: AcquisitionKind;
  readonly authType: AuthType;
  readonly authMethodLabel: string;
  readonly displayName: string;
  readonly referenceOwner: "managed" | "external";
  /** Ephemeral external-document content identity for observational consumers
   * such as Profile Usage. Never persisted or projected publicly. */
  readonly externalContentRevision?: string;
  readonly selectionGeneration: string;
}

export interface ProviderUnboundFacts {
  readonly kind: "unbound";
  readonly providerId: string;
}

export type ProviderAuthBindingFacts =
  | ProviderProfileBindingFacts
  | ProviderUnboundFacts;

export interface ProviderAuthBindingCapture {
  readonly facts: ProviderAuthBindingFacts;
}

export type ProfileProviderAuthBindingCapture = ProviderAuthBindingCapture & {
  readonly facts: ProviderProfileBindingFacts;
};

export function isProfileProviderAuthBindingCapture(
  capture: ProviderAuthBindingCapture,
): capture is ProfileProviderAuthBindingCapture {
  return capture.facts.kind === "profile";
}

/** Compatibility-free descriptive alias for request paths that require an
 * actual Token Profile. */
export type ManagedProviderAuthBindingCapture = ProfileProviderAuthBindingCapture;

export function isManagedProviderAuthBindingCapture(
  capture: ProviderAuthBindingCapture,
): capture is ManagedProviderAuthBindingCapture {
  return capture.facts.kind === "profile";
}

export const MAX_PROFILE_ATTEMPTS_PER_REQUEST = 3;

export interface AdvanceAfterFinal429Input {
  readonly capture: ProfileProviderAuthBindingCapture;
  readonly attemptedCredentialIds: readonly string[];
  readonly retryAfterMs?: number;
  readonly signal?: AbortSignal;
}

export type AdvanceAfterFinal429Result =
  | {
      readonly outcome: "switched";
      readonly capture: ProfileProviderAuthBindingCapture;
    }
  | {
      readonly outcome:
        | "disabled"
        | "exhausted"
        | "stale_binding"
        | "storage_failure";
    };

export class ProviderAuthBindingError extends Error {
  readonly outcome:
    | "unknown_provider"
    | "no_active_profile"
    | "stale_binding"
    | "storage_failure"
    | "credential_unavailable";

  constructor(
    outcome: ProviderAuthBindingError["outcome"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderAuthBindingError";
    this.outcome = outcome;
  }
}

export interface ProviderAuthBindingAuthority {
  capture(providerId: string): Promise<ProviderAuthBindingCapture>;

  /** Capture facts for one exact existing Profile. Used by runtime facets
   * such as Provider Usage that must observe a non-active Profile without
   * changing the Provider's active selection. */
  captureProfile(
    providerId: string,
    credentialId: string,
  ): Promise<ProfileProviderAuthBindingCapture>;

  createAcquisitionBinding(
    input: CreateAcquisitionBindingInput,
  ): Promise<CredentialAcquisitionBinding>;

  advanceAfterFinal429(
    input: AdvanceAfterFinal429Input,
  ): Promise<AdvanceAfterFinal429Result>;

  publishIfCurrent(
    capture: ProviderAuthBindingCapture,
    publish: (
      assertCurrent: () => void,
      facts: ProviderAuthBindingFacts,
    ) => Promise<void> | void,
    options?: {
      /** Selection-sensitive side effects (429 switching, passive usage of
       * the active request) require the captured Profile to still be the
       * active selection. Exact-Profile usage refresh only requires that the
       * same Profile still exists and is enabled. */
      readonly requireActiveSelection?: boolean;
    },
  ): Promise<boolean>;

  runBound<T>(
    binding: CredentialAcquisitionBinding | ProviderAuthBindingCapture,
    operation: () => Promise<T>,
  ): Promise<T>;
}
