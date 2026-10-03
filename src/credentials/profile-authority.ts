import { AsyncLocalStorage } from "node:async_hooks";
import type { LocalOAuthRegistration } from "@token/provider-contract/local-oauth";

import type {
  AuthOperationOptions,
  AuthType,
  Credential,
  CredentialInfo,
  CredentialStore,
  Provider,
} from "@earendil-works/pi-ai";

import {
  LOCAL_LOGIN_DUPLICATE_MESSAGE,
  LOCAL_LOGIN_FAILURE_MESSAGE,
  LocalAcquisitionError,
  readLocalOAuthCredential,
  type AcquisitionKind,
} from "./acquisition.js";
import {
  serializeApiKeyCredentialDocument,
  serializeOAuthCredentialDocument,
  canonicalCredentialPath,
  isExternalCredentialPath,
  readCredentialDocumentFile,
} from "./credential-document.js";
import {
  createProfileCredentialOperations,
  type ProfileCredentialOperationsOverride,
} from "./profile-credential-operations.js";
import {
  NO_PROVIDER_RECORD_REVISION,
  PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
  externalCredentialReference,
  managedCredentialReference,
  type PersistedCredentialProfile,
  type PersistedProviderCredentialRecord,
  type ProviderCredentialRecordStore,
  ProviderCredentialRecordShapeError,
  ProviderCredentialRecordSyntaxError,
} from "./profile-record-store.js";
import {
  CredentialProfileOperationError,
  MAX_PROFILE_ATTEMPTS_PER_REQUEST,
  ProviderAuthBindingError,
  isProfileProviderAuthBindingCapture,
  type ActivateProfileInput,
  type AdvanceAfterFinal429Input,
  type AdvanceAfterFinal429Result,
  type CredentialAcquisitionBinding,
  type CredentialProfileManagement,
  type CredentialProfileProjection,
  type CredentialProfilesProjection,
  type CreateAcquisitionBindingInput,
  type ProfileMutationOutcome,
  type ProfileMutationResult,
  type ProfileProviderAuthBindingCapture,
  type ProviderAuthBindingAuthority,
  type ProviderAuthBindingCapture,
  type ProviderProfileBindingFacts,
  type ProviderCredentialStateProjection,
  type ReorderProfilesInput,
  type RemoveProfileInput,
  type SetProfileEnabledInput,
  type SetProviderSwitchPolicyInput,
  type UpdateProfileMetadataInput,
} from "./profile-contract.js";

export { NO_PROVIDER_RECORD_REVISION } from "./profile-record-store.js";
export * from "./profile-contract.js";

type BoundScope =
  | CredentialAcquisitionBinding
  | ProfileProviderAuthBindingCapture;

interface ProviderCredentialProfilesComposition {
  readonly management: CredentialProfileManagement;
  readonly binding: ProviderAuthBindingAuthority;
  readonly credentialStore: CredentialStore;
}

function throwIfAborted(options: AuthOperationOptions | undefined): void {
  options?.signal?.throwIfAborted();
}

function authTypeFor(acquisitionKind: AcquisitionKind): AuthType {
  return acquisitionKind === "api_key" ? "api_key" : "oauth";
}

function providerAuthLabel(
  provider: Provider,
  acquisitionKind: AcquisitionKind,
): string {
  const type = authTypeFor(acquisitionKind);
  return (
    (type === "api_key" ? provider.auth.apiKey?.name : provider.auth.oauth?.name) ??
    (type === "api_key" ? "API key" : "OAuth")
  );
}

function providerSupportsAcquisition(
  provider: Provider,
  acquisitionKind: "api_key" | "oauth",
): boolean {
  return acquisitionKind === "api_key"
    ? provider.auth.apiKey?.login !== undefined
    : provider.auth.oauth !== undefined;
}

function validDisplayName(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && Array.from(normalized).length <= 64;
}

function validNote(value: string | undefined): boolean {
  return value === undefined || Array.from(value).length <= 200;
}

function credentialSecrets(credential: Credential): readonly string[] {
  const secrets = new Set<string>();
  const visit = (value: unknown, key: string | undefined): void => {
    if (typeof value === "string") {
      if (
        key !== undefined &&
        /(?:^|_)(?:key|token|secret|password|access|refresh)(?:$|_)/iu.test(key) &&
        value.length > 0
      ) {
        secrets.add(value);
      }
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey);
    }
  };
  visit(credential, undefined);
  return Object.freeze([...secrets]);
}

function metadataContainsSecrets(
  displayName: string,
  note: string | undefined,
  secrets: Iterable<string>,
): boolean {
  const metadata = note === undefined ? displayName : `${displayName}\n${note}`;
  for (const secret of secrets) {
    if (secret.length > 0 && metadata.includes(secret)) return true;
  }
  return false;
}

function createInitialRecord(input: {
  readonly providerId: string;
  readonly selectionGeneration: string;
  readonly profile: PersistedCredentialProfile;
}): PersistedProviderCredentialRecord {
  return {
    schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
    providerId: input.providerId,
    revision: NO_PROVIDER_RECORD_REVISION,
    selectionGeneration: input.selectionGeneration,
    activeCredentialId: input.profile.credentialId,
    switchPolicy: { apiKeyOn429: false, oauthOn429: false },
    profiles: [input.profile],
  };
}

/**
 * Append one acquired Profile. A record can exist with an empty profiles[]
 * after the last Profile was removed, so acquisition must still activate the
 * first current Profile instead of leaving the Provider without a selection.
 */
function appendAcquiredProfile(
  record: PersistedProviderCredentialRecord,
  profile: PersistedCredentialProfile,
  selectionGeneration: string,
): PersistedProviderCredentialRecord {
  if (record.profiles.length === 0) {
    return {
      ...record,
      activeCredentialId: profile.credentialId,
      selectionGeneration,
      profiles: [profile],
    };
  }
  return { ...record, profiles: [...record.profiles, profile] };
}

function clearActive(
  record: PersistedProviderCredentialRecord,
  selectionGeneration: string,
): PersistedProviderCredentialRecord {
  return {
    schemaVersion: record.schemaVersion,
    providerId: record.providerId,
    revision: record.revision,
    selectionGeneration,
    switchPolicy: record.switchPolicy,
    profiles: record.profiles,
  };
}

function profileNameTaken(
  profiles: readonly PersistedCredentialProfile[],
  displayName: string,
  exceptCredentialId?: string,
): boolean {
  const normalized = displayName.toLocaleLowerCase();
  return profiles.some(
    (profile) =>
      profile.credentialId !== exceptCredentialId &&
      profile.displayName.toLocaleLowerCase() === normalized,
  );
}

function mutationFailure(
  outcome: Exclude<ProfileMutationOutcome, "ok">,
  error: string,
): ProfileMutationResult {
  return Object.freeze({ outcome, error });
}

function serializeAcquiredCredential(
  acquisitionKind: "api_key" | "oauth",
  credential: Credential,
): string {
  if (credential.type !== authTypeFor(acquisitionKind)) {
    throw new Error(
      "Provider login returned a credential with the wrong authentication type",
    );
  }
  return credential.type === "api_key"
    ? serializeApiKeyCredentialDocument(credential)
    : serializeOAuthCredentialDocument(credential);
}

export function createProviderCredentialProfiles(options: {
  readonly recordStore: ProviderCredentialRecordStore;
  readonly providers: () => readonly Provider[];
  readonly createId: () => string;
  readonly now: () => number;
  readonly ambientStatus?: (providerId: string) => "configured" | "unknown";
  readonly credentialUsage?: (
    credentialIds: readonly string[],
  ) => readonly {
    readonly credentialId: string;
    readonly lastUsedAt: number;
    readonly lastSucceededAt?: number;
  }[];
  readonly credentialOperationOverrides?: readonly ProfileCredentialOperationsOverride[];
  readonly localOAuthRegistrations?: () => readonly LocalOAuthRegistration[];
}): ProviderCredentialProfilesComposition {
  const scope = new AsyncLocalStorage<BoundScope>();
  const cooldownUntil = new Map<string, number>();
  const knownSecrets = new Set<string>();
  let projection: CredentialProfilesProjection = Object.freeze({
    providers: Object.freeze([]),
  });

  const providerFor = (providerId: string): Provider | undefined =>
    options.providers().find((provider) => provider.id === providerId);

  const authLabelFor = (provider: Provider, kind: AcquisitionKind): string =>
    (kind === "local_oauth"
      ? options.localOAuthRegistrations?.().find(
          (registration) => registration.providerId === provider.id,
        )?.label()
      : undefined) ?? providerAuthLabel(provider, kind);

  const operations = createProfileCredentialOperations({
    store: options.recordStore,
    overrides: options.credentialOperationOverrides ?? [],
    localOAuthRegistrations: () => options.localOAuthRegistrations?.() ?? [],
  });

  const cooldownKey = (providerId: string, credentialId: string): string =>
    `${providerId}\u0000${credentialId}`;

  const isCoolingDown = (
    providerId: string,
    credentialId: string,
  ): boolean => {
    const until = cooldownUntil.get(cooldownKey(providerId, credentialId));
    if (until === undefined) return false;
    if (until <= options.now()) {
      cooldownUntil.delete(cooldownKey(providerId, credentialId));
      return false;
    }
    return true;
  };

  const projectProfile = (
    provider: Provider | undefined,
    profile: PersistedCredentialProfile,
    usage?: {
      readonly lastUsedAt: number;
      readonly lastSucceededAt?: number;
    },
  ): CredentialProfileProjection =>
    Object.freeze({
      credentialId: profile.credentialId,
      acquisitionKind: profile.acquisitionKind,
      authType: authTypeFor(profile.acquisitionKind),
      authMethodLabel:
        provider === undefined
          ? authTypeFor(profile.acquisitionKind) === "api_key"
            ? "API key"
            : "OAuth"
          : authLabelFor(provider, profile.acquisitionKind),
      displayName: profile.displayName,
      ...(profile.note === undefined ? {} : { note: profile.note }),
      enabled: profile.enabled,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      ...(usage?.lastUsedAt === undefined
        ? {}
        : { lastUsedAt: usage.lastUsedAt }),
      ...(usage?.lastSucceededAt === undefined
        ? {}
        : { lastSucceededAt: usage.lastSucceededAt }),
    });

  const projectRecord = (
    record: PersistedProviderCredentialRecord,
    provider: Provider | undefined,
  ): ProviderCredentialStateProjection => {
    const usage = new Map(
      (options.credentialUsage?.(
        record.profiles.map((profile) => profile.credentialId),
      ) ?? []).map((entry) => [entry.credentialId, entry] as const),
    );
    const ambientStatus = options.ambientStatus?.(record.providerId);
    return Object.freeze({
      providerId: record.providerId,
      implementationAvailable: provider !== undefined,
      revision: record.revision,
      selectionGeneration: record.selectionGeneration,
      ...(record.activeCredentialId === undefined
        ? {}
        : { activeCredentialId: record.activeCredentialId }),
      switchPolicy: Object.freeze({ ...record.switchPolicy }),
      ...(record.profiles.length === 0 && ambientStatus !== undefined
        ? {
            ambient: Object.freeze({
              kind: "external" as const,
              status: ambientStatus,
              message:
                ambientStatus === "configured"
                  ? "Provider has configured ambient authentication"
                  : "Provider may use ambient authentication",
            }),
          }
        : {}),
      profiles: Object.freeze(
        record.profiles.map((profile) =>
          projectProfile(provider, profile, usage.get(profile.credentialId)),
        ),
      ),
    });
  };

  const emptyProviderProjection = (
    providerId: string,
    provider: Provider | undefined,
  ): ProviderCredentialStateProjection => {
    const ambientStatus = options.ambientStatus?.(providerId);
    return Object.freeze({
      providerId,
      implementationAvailable: provider !== undefined,
      ...(ambientStatus === undefined
        ? {}
        : {
            ambient: Object.freeze({
              kind: "external" as const,
              status: ambientStatus,
              message:
                ambientStatus === "configured"
                  ? "Provider has configured ambient authentication"
                  : "Provider may use ambient authentication",
            }),
          }),
      profiles: Object.freeze([]),
    });
  };

  const queryProvider = async (
    providerId: string,
  ): Promise<ProviderCredentialStateProjection> => {
    const provider = providerFor(providerId);
    try {
      const record = await options.recordStore.read(providerId);
      return record === undefined
        ? emptyProviderProjection(providerId, provider)
        : projectRecord(record, provider);
    } catch (error) {
      const code =
        error instanceof ProviderCredentialRecordSyntaxError ||
        error instanceof ProviderCredentialRecordShapeError
          ? "invalid_record"
          : "storage_error";
      return Object.freeze({
        providerId,
        implementationAvailable: provider !== undefined,
        recordError: Object.freeze({
          code,
          message:
            code === "invalid_record"
              ? "Provider credential state is invalid"
              : "Provider credential state is unavailable",
        }),
        profiles: Object.freeze([]),
      });
    }
  };

  const refreshProjection = async (
    providerIds?: readonly string[],
  ): Promise<CredentialProfilesProjection> => {
    const ids =
      providerIds === undefined
        ? Object.freeze(
            [
              ...new Set([
                ...options.providers().map((provider) => provider.id),
                ...(await options.recordStore.listProviderIds()),
              ]),
            ].sort(),
          )
        : Object.freeze([...new Set(providerIds)].sort());
    const updated = new Map(
      projection.providers.map((provider) => [provider.providerId, provider] as const),
    );
    for (const providerId of ids) {
      updated.set(providerId, await queryProvider(providerId));
    }
    projection = Object.freeze({
      providers: Object.freeze(
        [...updated.values()].sort((left, right) =>
          left.providerId.localeCompare(right.providerId),
        ),
      ),
    });
    if (providerIds === undefined) return projection;
    const requested = new Set(ids);
    return Object.freeze({
      providers: Object.freeze(
        projection.providers.filter((provider) =>
          requested.has(provider.providerId),
        ),
      ),
    });
  };

  const profileFacts = async (
    provider: Provider,
    record: PersistedProviderCredentialRecord,
    profile: PersistedCredentialProfile,
  ): Promise<ProviderProfileBindingFacts> => {
    const externalContentRevision =
      profile.reference.owner === "external"
        ? await options.recordStore
            .readCredentialDocument(record.providerId, profile.credentialId)
            .then((read) =>
              read.state === "ok" ? read.contentRevision : undefined,
            )
            .catch(() => undefined)
        : undefined;
    return Object.freeze({
      kind: "profile" as const,
      providerId: record.providerId,
      credentialId: profile.credentialId,
      acquisitionKind: profile.acquisitionKind,
      authType: authTypeFor(profile.acquisitionKind),
      authMethodLabel: authLabelFor(provider, profile.acquisitionKind),
      displayName: profile.displayName,
      referenceOwner: profile.reference.owner,
      ...(externalContentRevision === undefined
        ? {}
        : { externalContentRevision }),
      selectionGeneration: record.selectionGeneration,
    });
  };

  const currentProfile = async (
    providerId: string,
    credentialId: string,
  ): Promise<{
    readonly provider: Provider;
    readonly record: PersistedProviderCredentialRecord;
    readonly profile: PersistedCredentialProfile;
  }> => {
    const provider = providerFor(providerId);
    if (provider === undefined) {
      throw new ProviderAuthBindingError(
        "unknown_provider",
        "Provider implementation is unavailable",
      );
    }
    let record: PersistedProviderCredentialRecord | undefined;
    try {
      record = await options.recordStore.read(providerId);
    } catch (error) {
      throw new ProviderAuthBindingError(
        "storage_failure",
        "Provider credential state could not be read",
        { cause: error },
      );
    }
    const profile = record?.profiles.find(
      (candidate) => candidate.credentialId === credentialId,
    );
    if (record === undefined || profile === undefined || !profile.enabled) {
      throw new ProviderAuthBindingError(
        "stale_binding",
        "Bound Credential Profile no longer exists or is disabled",
      );
    }
    return { provider, record, profile };
  };

  const resultWithProvider = (
    value: ProfileMutationResult,
    providerId: string,
  ): ProfileMutationResult => {
    const provider = projection.providers.find(
      (candidate) => candidate.providerId === providerId,
    );
    return provider === undefined
      ? value
      : Object.freeze({ ...value, provider });
  };

  const management: CredentialProfileManagement = {
    async query(providerIds?: readonly string[]) {
      return refreshProjection(providerIds);
    },

    snapshot() {
      return projection;
    },

    async updateMetadata(input: UpdateProfileMetadataInput) {
      if (!validDisplayName(input.displayName) || !validNote(input.note)) {
        return mutationFailure("invalid", "Credential Profile metadata is invalid");
      }
      if (metadataContainsSecrets(input.displayName, input.note, knownSecrets)) {
        return mutationFailure(
          "invalid",
          "Credential Profile metadata must not contain credential secrets",
        );
      }
      if (providerFor(input.providerId) === undefined) {
        return mutationFailure("unknown_provider", "Provider is unknown");
      }
      try {
        const before = await options.recordStore.read(input.providerId);
        const targetBefore = before?.profiles.find(
          (profile) => profile.credentialId === input.credentialId,
        );
        if (targetBefore !== undefined) {
          const credential = await operations
            .resolve(input.providerId, targetBefore)
            .read(input.providerId, targetBefore)
            .catch(() => undefined);
          if (credential !== undefined) {
            const secrets = credentialSecrets(credential);
            for (const secret of secrets) knownSecrets.add(secret);
            if (
              metadataContainsSecrets(
                input.displayName,
                input.note,
                secrets,
              )
            ) {
              return mutationFailure(
                "invalid",
                "Credential Profile metadata must not contain credential secrets",
              );
            }
          }
        }

        const result = await options.recordStore.modifyManagement(
          input.providerId,
          input.expectedRevision,
          (current) => {
            const index =
              current?.profiles.findIndex(
                (profile) => profile.credentialId === input.credentialId,
              ) ?? -1;
            if (current === undefined || index < 0) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "unknown_profile",
                  "Credential Profile is unknown",
                ),
              };
            }
            if (
              profileNameTaken(
                current.profiles,
                input.displayName,
                input.credentialId,
              )
            ) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "duplicate",
                  "Credential Profile display name already exists",
                ),
              };
            }
            const target = current.profiles[index]!;
            if (
              target.displayName === input.displayName &&
              target.note === input.note
            ) {
              return {
                kind: "unchanged" as const,
                value: Object.freeze({ outcome: "ok" as const }),
              };
            }
            const profiles = [...current.profiles];
            profiles[index] =
              input.note === undefined
                ? {
                    credentialId: target.credentialId,
                    acquisitionKind: target.acquisitionKind,
                    reference: target.reference,
                    displayName: input.displayName,
                    enabled: target.enabled,
                    createdAt: target.createdAt,
                    updatedAt: options.now(),
                  }
                : {
                    ...target,
                    displayName: input.displayName,
                    note: input.note,
                    updatedAt: options.now(),
                  };
            return {
              kind: "commit" as const,
              record: { ...current, profiles },
              value: Object.freeze({ outcome: "ok" as const }),
            };
          },
        );
        if (result.kind === "revision_conflict") {
          return mutationFailure(
            "conflict",
            "Credential Profile state changed; re-query and retry",
          );
        }
        await refreshProjection([input.providerId]);
        return resultWithProvider(result.value, input.providerId);
      } catch {
        return mutationFailure(
          "storage_failure",
          "Credential Profile storage is unavailable",
        );
      }
    },

    async activate(input: ActivateProfileInput) {
      if (providerFor(input.providerId) === undefined) {
        return mutationFailure("unknown_provider", "Provider is unknown");
      }
      try {
        const result = await options.recordStore.modifyManagement(
          input.providerId,
          input.expectedRevision,
          (current) => {
            const target = current?.profiles.find(
              (profile) => profile.credentialId === input.credentialId,
            );
            if (current === undefined || target === undefined) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "unknown_profile",
                  "Credential Profile is unknown",
                ),
              };
            }
            if (!target.enabled) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "invalid",
                  "Disabled Credential Profile cannot be activated",
                ),
              };
            }
            if (current.activeCredentialId === target.credentialId) {
              return {
                kind: "unchanged" as const,
                value: Object.freeze({ outcome: "ok" as const }),
              };
            }
            return {
              kind: "commit" as const,
              record: {
                ...current,
                activeCredentialId: target.credentialId,
                selectionGeneration: options.createId(),
              },
              value: Object.freeze({ outcome: "ok" as const }),
            };
          },
        );
        if (result.kind === "revision_conflict") {
          return mutationFailure(
            "conflict",
            "Credential Profile state changed; re-query and retry",
          );
        }
        await refreshProjection([input.providerId]);
        return resultWithProvider(result.value, input.providerId);
      } catch {
        return mutationFailure(
          "storage_failure",
          "Credential Profile storage is unavailable",
        );
      }
    },

    async setEnabled(input: SetProfileEnabledInput) {
      if (providerFor(input.providerId) === undefined) {
        return mutationFailure("unknown_provider", "Provider is unknown");
      }
      try {
        const result = await options.recordStore.modifyManagement(
          input.providerId,
          input.expectedRevision,
          (current) => {
            const index =
              current?.profiles.findIndex(
                (profile) => profile.credentialId === input.credentialId,
              ) ?? -1;
            if (current === undefined || index < 0) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "unknown_profile",
                  "Credential Profile is unknown",
                ),
              };
            }
            const target = current.profiles[index]!;
            if (target.enabled === input.enabled) {
              return {
                kind: "unchanged" as const,
                value: Object.freeze({ outcome: "ok" as const }),
              };
            }
            const profiles = [...current.profiles];
            profiles[index] = {
              ...target,
              enabled: input.enabled,
              updatedAt: options.now(),
            };
            const next =
              !input.enabled &&
              current.activeCredentialId === target.credentialId
                ? clearActive(
                    { ...current, profiles },
                    options.createId(),
                  )
                : { ...current, profiles };
            return {
              kind: "commit" as const,
              record: next,
              value: Object.freeze({ outcome: "ok" as const }),
            };
          },
        );
        if (result.kind === "revision_conflict") {
          return mutationFailure(
            "conflict",
            "Credential Profile state changed; re-query and retry",
          );
        }
        await refreshProjection([input.providerId]);
        return resultWithProvider(result.value, input.providerId);
      } catch {
        return mutationFailure(
          "storage_failure",
          "Credential Profile storage is unavailable",
        );
      }
    },

    async reorderProfiles(input: ReorderProfilesInput) {
      if (providerFor(input.providerId) === undefined) {
        return mutationFailure("unknown_provider", "Provider is unknown");
      }
      try {
        const result = await options.recordStore.modifyManagement(
          input.providerId,
          input.expectedRevision,
          (current) => {
            if (current === undefined) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "unknown_profile",
                  "Credential Profiles are unknown",
                ),
              };
            }
            if (
              input.credentialIds.length !== current.profiles.length ||
              new Set(input.credentialIds).size !== input.credentialIds.length
            ) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure("invalid", "Invalid Profile order"),
              };
            }
            const byId = new Map(
              current.profiles.map(
                (profile) => [profile.credentialId, profile] as const,
              ),
            );
            const profiles: PersistedCredentialProfile[] = [];
            for (const credentialId of input.credentialIds) {
              const profile = byId.get(credentialId);
              if (profile === undefined) {
                return {
                  kind: "unchanged" as const,
                  value: mutationFailure("invalid", "Invalid Profile order"),
                };
              }
              profiles.push(profile);
            }
            if (
              profiles.every(
                (profile, index) =>
                  profile.credentialId ===
                  current.profiles[index]?.credentialId,
              )
            ) {
              return {
                kind: "unchanged" as const,
                value: Object.freeze({ outcome: "ok" as const }),
              };
            }
            return {
              kind: "commit" as const,
              record: { ...current, profiles },
              value: Object.freeze({ outcome: "ok" as const }),
            };
          },
        );
        if (result.kind === "revision_conflict") {
          return mutationFailure(
            "conflict",
            "Credential Profile state changed; re-query and retry",
          );
        }
        await refreshProjection([input.providerId]);
        return resultWithProvider(result.value, input.providerId);
      } catch {
        return mutationFailure(
          "storage_failure",
          "Credential Profile storage is unavailable",
        );
      }
    },

    async remove(input: RemoveProfileInput) {
      if (providerFor(input.providerId) === undefined) {
        return mutationFailure("unknown_provider", "Provider is unknown");
      }
      try {
        const result = await options.recordStore.modifyManagement(
          input.providerId,
          input.expectedRevision,
          (current) => {
            const target = current?.profiles.find(
              (profile) => profile.credentialId === input.credentialId,
            );
            if (current === undefined || target === undefined) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "unknown_profile",
                  "Credential Profile is unknown",
                ),
              };
            }
            cooldownUntil.delete(
              cooldownKey(input.providerId, target.credentialId),
            );
            const profiles = current.profiles.filter(
              (profile) => profile.credentialId !== target.credentialId,
            );
            const next =
              current.activeCredentialId === target.credentialId
                ? clearActive(
                    { ...current, profiles },
                    options.createId(),
                  )
                : { ...current, profiles };
            return {
              kind: "commit" as const,
              record: next,
              value: Object.freeze({ outcome: "ok" as const }),
            };
          },
        );
        if (result.kind === "revision_conflict") {
          return mutationFailure(
            "conflict",
            "Credential Profile state changed; re-query and retry",
          );
        }
        await refreshProjection([input.providerId]);
        return resultWithProvider(result.value, input.providerId);
      } catch {
        return mutationFailure(
          "storage_failure",
          "Credential Profile storage is unavailable",
        );
      }
    },

    async setSwitchPolicy(input: SetProviderSwitchPolicyInput) {
      if (providerFor(input.providerId) === undefined) {
        return mutationFailure("unknown_provider", "Provider is unknown");
      }
      try {
        const result = await options.recordStore.modifyManagement(
          input.providerId,
          input.expectedRevision,
          (current) => {
            if (current === undefined) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "unknown_profile",
                  "Credential Profiles are unknown",
                ),
              };
            }
            if (
              current.switchPolicy.apiKeyOn429 === input.apiKeyOn429 &&
              current.switchPolicy.oauthOn429 === input.oauthOn429
            ) {
              return {
                kind: "unchanged" as const,
                value: Object.freeze({ outcome: "ok" as const }),
              };
            }
            return {
              kind: "commit" as const,
              record: {
                ...current,
                switchPolicy: {
                  apiKeyOn429: input.apiKeyOn429,
                  oauthOn429: input.oauthOn429,
                },
              },
              value: Object.freeze({ outcome: "ok" as const }),
            };
          },
        );
        if (result.kind === "revision_conflict") {
          return mutationFailure(
            "conflict",
            "Credential Profile state changed; re-query and retry",
          );
        }
        await refreshProjection([input.providerId]);
        return resultWithProvider(result.value, input.providerId);
      } catch {
        return mutationFailure(
          "storage_failure",
          "Credential Profile storage is unavailable",
        );
      }
    },

    async acquireLocal(input) {
      const provider = providerFor(input.providerId);
      if (provider === undefined) {
        return mutationFailure("unknown_provider", "Provider is unknown");
      }
      const registration = options.localOAuthRegistrations?.().find(
        (item) => item.providerId === input.providerId,
      );
      if (registration === undefined) {
        return mutationFailure("unavailable", "Local OAuth acquisition is unavailable");
      }
      if (!validDisplayName(input.displayName) || !validNote(input.note)) {
        return mutationFailure("invalid", "Credential Profile metadata is invalid");
      }
      input.signal?.throwIfAborted();

      let current: PersistedProviderCredentialRecord | undefined;
      try {
        current = await options.recordStore.read(input.providerId);
      } catch {
        return mutationFailure(
          "storage_failure",
          "Credential Profile storage is unavailable",
        );
      }
      if (
        current?.profiles.some(
          (profile) => profile.acquisitionKind === "local_oauth",
        )
      ) {
        return mutationFailure("duplicate", LOCAL_LOGIN_DUPLICATE_MESSAGE);
      }
      if (
        current !== undefined &&
        profileNameTaken(current.profiles, input.displayName)
      ) {
        return mutationFailure(
          "duplicate",
          "Credential Profile display name already exists",
        );
      }

      let discovered: Awaited<ReturnType<LocalOAuthRegistration["acquire"]>>;
      try {
        discovered = await registration.acquire(input.signal);
      } catch {
        input.signal?.throwIfAborted();
        throw new LocalAcquisitionError(LOCAL_LOGIN_FAILURE_MESSAGE);
      }
      input.signal?.throwIfAborted();
      if (
        discovered === null || typeof discovered !== "object" ||
        discovered.owner !== "external" || typeof discovered.path !== "string" ||
        !isExternalCredentialPath(discovered.path)
      ) {
        throw new LocalAcquisitionError(LOCAL_LOGIN_FAILURE_MESSAGE);
      }
      const reference = externalCredentialReference(
        await canonicalCredentialPath(discovered.path),
      );
      const document = await readCredentialDocumentFile(reference.path);
      input.signal?.throwIfAborted();
      const credential = document.state === "ok"
        ? readLocalOAuthCredential(registration, document.raw)
        : undefined;
      input.signal?.throwIfAborted();
      if (credential === undefined) {
        throw new LocalAcquisitionError(LOCAL_LOGIN_FAILURE_MESSAGE);
      }
      if (metadataContainsSecrets(
        input.displayName, input.note, credentialSecrets(credential),
      )) {
        return mutationFailure("invalid", "Credential Profile metadata must not contain credential secrets");
      }
      for (const secret of credentialSecrets(credential)) knownSecrets.add(secret);
      const credentialId = options.createId();
      const now = options.now();
      const profile: PersistedCredentialProfile = {
        credentialId,
        acquisitionKind: "local_oauth",
        reference,
        displayName: input.displayName,
        ...(input.note === undefined ? {} : { note: input.note }),
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };

      try {
        const result = await options.recordStore.publishCredential(
          input.providerId,
          {
            credentialId,
            reference: profile.reference,
          },
          (latest) => {
            input.signal?.throwIfAborted();
            if (
              latest?.profiles.some(
                (candidate) =>
                  candidate.acquisitionKind === "local_oauth",
              )
            ) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "duplicate",
                  LOCAL_LOGIN_DUPLICATE_MESSAGE,
                ),
              };
            }
            if (
              latest !== undefined &&
              profileNameTaken(latest.profiles, input.displayName)
            ) {
              return {
                kind: "unchanged" as const,
                value: mutationFailure(
                  "duplicate",
                  "Credential Profile display name already exists",
                ),
              };
            }
            const record =
              latest === undefined
                ? createInitialRecord({
                    providerId: input.providerId,
                    selectionGeneration: options.createId(),
                    profile,
                  })
                : appendAcquiredProfile(
                    latest,
                    profile,
                    options.createId(),
                  );
            return {
              kind: "commit" as const,
              record,
              value: Object.freeze({ outcome: "ok" as const }),
            };
          },
        );
        await refreshProjection([input.providerId]);
        return resultWithProvider(result.value, input.providerId);
      } catch {
        input.signal?.throwIfAborted();
        return mutationFailure(
          "storage_failure",
          "Credential Profile storage is unavailable",
        );
      }
    },
  };

  const binding: ProviderAuthBindingAuthority = {
    async capture(providerId: string) {
      const provider = providerFor(providerId);
      if (provider === undefined) {
        throw new ProviderAuthBindingError(
          "unknown_provider",
          "Provider implementation is unavailable",
        );
      }
      let record: PersistedProviderCredentialRecord | undefined;
      try {
        record = await options.recordStore.read(providerId);
      } catch (error) {
        throw new ProviderAuthBindingError(
          "storage_failure",
          "Provider credential state could not be read",
          { cause: error },
        );
      }
      if (record === undefined || record.profiles.length === 0) {
        return Object.freeze({
          facts: Object.freeze({
            kind: "unbound" as const,
            providerId,
          }),
        });
      }
      const profile =
        record.activeCredentialId === undefined
          ? undefined
          : record.profiles.find(
              (candidate) =>
                candidate.credentialId === record.activeCredentialId,
            );
      if (profile === undefined || !profile.enabled) {
        throw new ProviderAuthBindingError(
          "no_active_profile",
          "Provider has Profiles but no enabled active Profile",
        );
      }
      return Object.freeze({
        facts: await profileFacts(provider, record, profile),
      });
    },

    async captureProfile(providerId: string, credentialId: string) {
      const provider = providerFor(providerId);
      if (provider === undefined) {
        throw new ProviderAuthBindingError(
          "unknown_provider",
          "Provider implementation is unavailable",
        );
      }
      let record: PersistedProviderCredentialRecord | undefined;
      try {
        record = await options.recordStore.read(providerId);
      } catch (error) {
        throw new ProviderAuthBindingError(
          "storage_failure",
          "Provider credential state could not be read",
          { cause: error },
        );
      }
      const profile = record?.profiles.find(
        (candidate) => candidate.credentialId === credentialId,
      );
      if (record === undefined || profile === undefined) {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "Credential Profile no longer exists",
        );
      }
      return Object.freeze({
        facts: await profileFacts(provider, record, profile),
      }) as ProfileProviderAuthBindingCapture;
    },

    async createAcquisitionBinding(input: CreateAcquisitionBindingInput) {
      const provider = providerFor(input.providerId);
      if (provider === undefined) {
        throw new CredentialProfileOperationError(
          "unknown_provider",
          "Provider is unknown",
        );
      }
      if (
        !providerSupportsAcquisition(provider, input.acquisitionKind)
      ) {
        throw new CredentialProfileOperationError(
          "unavailable",
          "Provider authentication method is unavailable",
        );
      }
      if (!validDisplayName(input.displayName) || !validNote(input.note)) {
        throw new CredentialProfileOperationError(
          "invalid",
          "Credential Profile metadata is invalid",
        );
      }
      const record = await options.recordStore.read(input.providerId);
      if (
        record !== undefined &&
        profileNameTaken(record.profiles, input.displayName)
      ) {
        throw new CredentialProfileOperationError(
          "duplicate",
          "Credential Profile display name already exists",
        );
      }
      return Object.freeze({
        kind: "acquisition" as const,
        providerId: input.providerId,
        acquisitionKind: input.acquisitionKind,
        displayName: input.displayName,
        ...(input.note === undefined ? {} : { note: input.note }),
        credentialId: options.createId(),
      });
    },

    async advanceAfterFinal429(
      input: AdvanceAfterFinal429Input,
    ): Promise<AdvanceAfterFinal429Result> {
      input.signal?.throwIfAborted();
      const failedFacts = input.capture.facts;
      const attempted = new Set(input.attemptedCredentialIds);
      attempted.add(failedFacts.credentialId);
      if (attempted.size >= MAX_PROFILE_ATTEMPTS_PER_REQUEST) {
        return Object.freeze({ outcome: "exhausted" });
      }

      type SwitchValue =
        | {
            readonly outcome:
              | "disabled"
              | "exhausted"
              | "stale_binding";
          }
        | {
            readonly outcome: "switched";
            readonly credentialId: string;
          };

      let result;
      try {
        result = await options.recordStore.modifySelection<SwitchValue>(
          failedFacts.providerId,
          (current) => {
            input.signal?.throwIfAborted();
            const failed = current?.profiles.find(
              (profile) =>
                profile.credentialId === failedFacts.credentialId,
            );
            if (
              current === undefined ||
              failed === undefined ||
              current.selectionGeneration !==
                failedFacts.selectionGeneration ||
              current.activeCredentialId !== failedFacts.credentialId ||
              failed.acquisitionKind !== failedFacts.acquisitionKind
            ) {
              return {
                kind: "unchanged",
                value: { outcome: "stale_binding" as const },
              };
            }

            const enabled =
              authTypeFor(failed.acquisitionKind) === "api_key"
                ? current.switchPolicy.apiKeyOn429
                : current.switchPolicy.oauthOn429;
            if (!enabled) {
              return {
                kind: "unchanged",
                value: { outcome: "disabled" as const },
              };
            }

            const target = current.profiles.find(
              (candidate) =>
                candidate.enabled &&
                authTypeFor(candidate.acquisitionKind) ===
                  authTypeFor(failed.acquisitionKind) &&
                !attempted.has(candidate.credentialId) &&
                !isCoolingDown(
                  current.providerId,
                  candidate.credentialId,
                ),
            );
            if (target === undefined) {
              return {
                kind: "unchanged",
                value: { outcome: "exhausted" as const },
              };
            }

            return {
              kind: "commit",
              record: {
                ...current,
                activeCredentialId: target.credentialId,
                selectionGeneration: options.createId(),
              },
              value: {
                outcome: "switched" as const,
                credentialId: target.credentialId,
              },
            };
          },
        );
      } catch (error) {
        if (input.signal?.aborted === true) throw error;
        return Object.freeze({ outcome: "storage_failure" });
      }

      if (
        result.value.outcome !== "stale_binding" &&
        input.retryAfterMs !== undefined &&
        Number.isFinite(input.retryAfterMs) &&
        input.retryAfterMs >= 0 &&
        input.retryAfterMs <= 86_400_000
      ) {
        cooldownUntil.set(
          cooldownKey(
            failedFacts.providerId,
            failedFacts.credentialId,
          ),
          options.now() + input.retryAfterMs,
        );
      }

      const switchValue = result.value;
      if (switchValue.outcome !== "switched") {
        return Object.freeze({ outcome: switchValue.outcome });
      }

      const provider = providerFor(failedFacts.providerId);
      const record = result.record;
      const target = record?.profiles.find(
        (candidate) =>
          candidate.credentialId === switchValue.credentialId,
      );
      if (provider === undefined || record === undefined || target === undefined) {
        return Object.freeze({ outcome: "storage_failure" });
      }
      return Object.freeze({
        outcome: "switched" as const,
        capture: Object.freeze({
          facts: await profileFacts(provider, record, target),
        }),
      });
    },

    async publishIfCurrent(capture, publish, optionsForPublication) {
      const facts = capture.facts;
      const provider = providerFor(facts.providerId);
      if (provider === undefined) return false;
      return options.recordStore.withSelectionLock(
        facts.providerId,
        async (current, assertOwned) => {
          if (facts.kind === "unbound") {
            if (current !== undefined && current.profiles.length > 0) {
              return false;
            }
          } else {
            const profile = current?.profiles.find(
              (candidate) => candidate.credentialId === facts.credentialId,
            );
            if (
              current === undefined ||
              profile === undefined ||
              !profile.enabled ||
              (optionsForPublication?.requireActiveSelection !== false &&
                (current.activeCredentialId !== facts.credentialId ||
                  current.selectionGeneration !== facts.selectionGeneration)) ||
              profile.acquisitionKind !== facts.acquisitionKind ||
              profile.reference.owner !== facts.referenceOwner
            ) {
              return false;
            }
            if (facts.externalContentRevision !== undefined) {
              const read = await options.recordStore.readCredentialDocument(
                facts.providerId,
                facts.credentialId,
              );
              if (
                read.state !== "ok" ||
                read.contentRevision !== facts.externalContentRevision
              ) {
                return false;
              }
            }
          }
          assertOwned();
          await publish(assertOwned, facts);
          return true;
        },
      );
    },

    async runBound<T>(
      requestedBinding: CredentialAcquisitionBinding | ProviderAuthBindingCapture,
      operation: () => Promise<T>,
    ) {
      if (scope.getStore() !== undefined) {
        throw new Error("Provider Profile bindings cannot be nested");
      }
      if (
        "facts" in requestedBinding &&
        requestedBinding.facts.kind === "unbound"
      ) {
        return operation();
      }
      return scope.run(
        requestedBinding as BoundScope,
        operation,
      );
    },
  };

  const isAcquisitionScope = (
    current: BoundScope,
  ): current is CredentialAcquisitionBinding =>
    "kind" in current && current.kind === "acquisition";

  const boundProviderId = (current: BoundScope): string =>
    isAcquisitionScope(current)
      ? current.providerId
      : current.facts.providerId;

  const credentialStore: CredentialStore = {
    async read(providerId: string, operationOptions?: AuthOperationOptions) {
      throwIfAborted(operationOptions);
      const current = scope.getStore();
      if (current !== undefined && boundProviderId(current) !== providerId) {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "Credential operation escaped its Provider binding",
        );
      }
      if (current !== undefined && isAcquisitionScope(current)) {
        return undefined;
      }
      if (current !== undefined) {
        const resolved = await currentProfile(
          providerId,
          current.facts.credentialId,
        );
        const credential = await operations
          .resolve(providerId, resolved.profile)
          .read(providerId, resolved.profile);
        if (credential === undefined) {
          throw new ProviderAuthBindingError(
            "credential_unavailable",
            "Bound Credential Profile cannot currently be resolved",
          );
        }
        for (const secret of credentialSecrets(credential)) {
          knownSecrets.add(secret);
        }
        return structuredClone(credential);
      }

      const record = await options.recordStore.read(providerId);
      if (record === undefined || record.profiles.length === 0) return undefined;
      throw new ProviderAuthBindingError(
        "no_active_profile",
        "Credential Profile access requires an exact Profile binding",
      );
    },

    async list(
      operationOptions?: AuthOperationOptions,
    ): Promise<readonly CredentialInfo[]> {
      throwIfAborted(operationOptions);
      const entries: CredentialInfo[] = [];
      for (const providerId of await options.recordStore.listProviderIds()) {
        const record = await options.recordStore.read(providerId);
        const profile =
          record?.activeCredentialId === undefined
            ? undefined
            : record.profiles.find(
                (candidate) =>
                  candidate.credentialId === record.activeCredentialId &&
                  candidate.enabled,
              );
        if (profile === undefined) continue;
        entries.push({
          providerId,
          type: authTypeFor(profile.acquisitionKind),
        });
      }
      return Object.freeze(entries);
    },

    async modify(
      providerId: string,
      mutation: (
        current: Credential | undefined,
      ) => Promise<Credential | undefined>,
      operationOptions?: AuthOperationOptions,
    ) {
      throwIfAborted(operationOptions);
      const current = scope.getStore();
      if (current !== undefined && boundProviderId(current) !== providerId) {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "Credential operation escaped its Provider binding",
        );
      }

      if (current !== undefined && isAcquisitionScope(current)) {
        const credential = await mutation(undefined);
        throwIfAborted(operationOptions);
        if (
          credential === undefined ||
          credential.type !== authTypeFor(current.acquisitionKind)
        ) {
          throw new Error(
            "Provider login returned a credential with the wrong authentication type",
          );
        }
        if (
          metadataContainsSecrets(
            current.displayName,
            current.note,
            credentialSecrets(credential),
          )
        ) {
          throw new CredentialProfileOperationError(
            "invalid",
            "Credential Profile metadata must not contain credential secrets",
          );
        }
        for (const secret of credentialSecrets(credential)) {
          knownSecrets.add(secret);
        }

        const now = options.now();
        const reference = managedCredentialReference(
          providerId,
          current.credentialId,
        );
        const profile: PersistedCredentialProfile = {
          credentialId: current.credentialId,
          acquisitionKind: current.acquisitionKind,
          reference,
          displayName: current.displayName,
          ...(current.note === undefined ? {} : { note: current.note }),
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        const raw = serializeAcquiredCredential(
          current.acquisitionKind,
          credential,
        );
        const result = await options.recordStore.publishCredential(
          providerId,
          {
            credentialId: current.credentialId,
            reference,
            content: raw,
          },
          (record) => {
            if (
              record !== undefined &&
              profileNameTaken(record.profiles, current.displayName)
            ) {
              return {
                kind: "unchanged" as const,
                value: undefined,
              };
            }
            const next =
              record === undefined
                ? createInitialRecord({
                    providerId,
                    selectionGeneration: options.createId(),
                    profile,
                  })
                : appendAcquiredProfile(record, profile, options.createId());
            return {
              kind: "commit" as const,
              record: next,
              value: credential,
            };
          },
        );
        if (result.value === undefined) {
          throw new CredentialProfileOperationError(
            "duplicate",
            "Credential Profile display name already exists",
          );
        }
        await refreshProjection([providerId]);
        return structuredClone(result.value);
      }

      if (
        current === undefined ||
        isAcquisitionScope(current) ||
        !isProfileProviderAuthBindingCapture(current)
      ) {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "Credential mutation requires an exact Profile binding",
        );
      }
      const resolved = await currentProfile(
        providerId,
        current.facts.credentialId,
      );
      const credential = await operations
        .resolve(providerId, resolved.profile)
        .modify(providerId, resolved.profile, mutation);
      throwIfAborted(operationOptions);
      if (credential !== undefined) {
        for (const secret of credentialSecrets(credential)) {
          knownSecrets.add(secret);
        }
      }
      return credential === undefined
        ? undefined
        : structuredClone(credential);
    },

    async delete(
      providerId: string,
      operationOptions?: AuthOperationOptions,
    ) {
      throwIfAborted(operationOptions);
      const record = await options.recordStore.read(providerId);
      if (record !== undefined && record.profiles.length > 0) {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "Pi credential delete cannot remove Token Credential Profiles",
        );
      }
    },
  };

  return Object.freeze({
    management,
    binding,
    credentialStore,
  });
}
