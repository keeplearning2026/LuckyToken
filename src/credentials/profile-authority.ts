import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AuthOperationOptions,
  AuthType,
  Credential,
  CredentialInfo,
  CredentialStore,
  Provider,
} from "@earendil-works/pi-ai";

import {
  NO_PROVIDER_RECORD_REVISION,
  PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
  type PersistedCredentialProfileV1,
  type PersistedProviderCredentialRecordV1,
  type ProviderCredentialRecordStore,
  ProviderCredentialRecordShapeError,
  ProviderCredentialRecordSyntaxError,
} from "./profile-record-store.js";

import {
  CredentialProfileOperationError,
  MAX_PROFILE_ATTEMPTS_PER_REQUEST,
  ProviderAuthBindingError,
  type ActivateProfileInput,
  type AdvanceAfterFinal429Input,
  type AdvanceAfterFinal429Result,
  type CaptureProfileForRecheckInput,
  type CreateLoginBindingInput,
  type CreateReconnectBindingInput,
  type CredentialHealth,
  type CredentialLoginBinding,
  type CredentialProfileManagement,
  type CredentialProfileProjection,
  type CredentialProfilesProjection,
  type ProfileMutationOutcome,
  type ProfileMutationResult,
  type ProfileTargetInput,
  type ManagedProviderAuthBindingCapture,
  type ProviderAuthBindingAuthority,
  type ProviderAuthBindingCapture,
  type ProviderCredentialStateProjection,
  type RemoveProfileInput,
  type SetProfileEnabledInput,
  type SetProfilePriorityInput,
  type SetProviderSwitchPolicyInput,
  type UpdateProfileMetadataInput,
} from "./profile-contract.js";

export { NO_PROVIDER_RECORD_REVISION } from "./profile-record-store.js";
export * from "./profile-contract.js";

interface ManagedBindingScope {
  readonly kind: "managed";
  readonly providerId: string;
  readonly credentialId: string;
  readonly authType: AuthType;
  readonly authMethodLabel: string;
  readonly displayName: string;
  readonly credentialGeneration: string;
  readonly selectionGeneration: string;
}

interface AmbientBindingScope {
  readonly kind: "ambient";
  readonly providerId: string;
}

type BindingScope = CredentialLoginBinding | ManagedBindingScope | AmbientBindingScope;

/** Internal composition result. Consumers receive only `management` or
 * `binding`; the secret-bearing Pi adapter stays inside Provider Runtime
 * composition. */
interface ProviderCredentialProfilesComposition {
  readonly management: CredentialProfileManagement;
  readonly binding: ProviderAuthBindingAuthority;
  readonly credentialStore: CredentialStore;
  scrub(value: string): string;
}

function throwIfAborted(options: AuthOperationOptions | undefined): void {
  options?.signal?.throwIfAborted();
}

function providerAuthLabel(provider: Provider, authType: AuthType): string | undefined {
  return authType === "api_key" ? provider.auth.apiKey?.name : provider.auth.oauth?.name;
}

function providerSupportsLogin(provider: Provider, authType: AuthType): boolean {
  return authType === "api_key"
    ? provider.auth.apiKey?.login !== undefined
    : provider.auth.oauth !== undefined;
}

const INVALID_OAUTH_CREDENTIAL_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "unauthorized_client",
]);

/** Only structured Provider evidence may turn a usable Profile into a
 * reconnect-required terminal. Generic OAuth, timeout, cancellation,
 * network, and storage failures are not proof that the credential died. */
function demonstratesInvalidOAuthCredential(
  providerId: string,
  error: unknown,
): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const candidate = current as {
      readonly code?: unknown;
      readonly error?: unknown;
      readonly cause?: unknown;
    };
    if (
      (typeof candidate.code === "string" &&
        INVALID_OAUTH_CREDENTIAL_CODES.has(candidate.code)) ||
      (typeof candidate.error === "string" &&
        INVALID_OAUTH_CREDENTIAL_CODES.has(candidate.error))
    ) {
      return true;
    }
    // Pinned Pi's Kimi OAuth implementation has already reduced 401, 403,
    // and `invalid_grant` responses to this fixed Provider-owned error
    // category before Models wraps it. This exact prefix is therefore typed
    // source evidence, not a guess from arbitrary Provider text.
    if (
      providerId === "kimi-coding" &&
      current instanceof Error &&
      /^Kimi Code token refresh unauthorized \(status \d{3}\)(?::|$)/u.test(
        current.message,
      )
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function identityHint(credential: Credential): string | undefined {
  if (
    credential.type !== "api_key" ||
    credential.key === undefined ||
    credential.key.length < 8 ||
    credential.key.startsWith("$") ||
    credential.key.startsWith("!")
  ) {
    return undefined;
  }
  return `•••• ${credential.key.slice(-4)}`;
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

function metadataContainsSecret(
  displayName: string,
  note: string | undefined,
  profiles: readonly PersistedCredentialProfileV1[],
): boolean {
  const metadata = note === undefined ? displayName : `${displayName}\n${note}`;
  return profiles.some((profile) =>
    credentialSecrets(profile.credential).some((secret) => metadata.includes(secret)),
  );
}

function recordMetadataContainsSecret(
  profiles: readonly PersistedCredentialProfileV1[],
): boolean {
  const secrets = profiles.flatMap((profile) => credentialSecrets(profile.credential));
  return profiles.some((profile) => {
    const metadata = profile.note === undefined
      ? profile.displayName
      : `${profile.displayName}\n${profile.note}`;
    return secrets.some((secret) => metadata.includes(secret));
  });
}

function validateCredential(credential: Credential | undefined, authType: AuthType): Credential {
  if (credential === undefined || credential.type !== authType) {
    throw new Error("Provider login returned a credential with the wrong authentication type");
  }
  return structuredClone(credential);
}

function projectProfile(
  profile: PersistedCredentialProfileV1,
  runtimeHealth: CredentialHealth | undefined,
  usage?: { readonly lastUsedAt: number; readonly lastSucceededAt?: number },
): CredentialProfileProjection {
  return Object.freeze({
    credentialId: profile.credentialId,
    authType: profile.authType,
    authMethodLabel: profile.authMethodLabel,
    displayName: profile.displayName,
    ...(profile.note === undefined ? {} : { note: profile.note }),
    ...(profile.identityHint === undefined ? {} : { identityHint: profile.identityHint }),
    enabled: profile.enabled,
    health: profile.enabled
      ? (runtimeHealth ?? (usage?.lastSucceededAt === undefined ? "not_yet_verified" : "ready"))
      : "disabled",
    priority: profile.priority,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(usage?.lastUsedAt === undefined ? {} : { lastUsedAt: usage.lastUsedAt }),
    ...(usage?.lastSucceededAt === undefined
      ? {}
      : { lastSucceededAt: usage.lastSucceededAt }),
  });
}

function projectRecord(
  record: PersistedProviderCredentialRecordV1,
  implementationAvailable: boolean,
  ambientStatus: "configured" | "unknown",
  healthFor?: (credentialId: string) => CredentialHealth | undefined,
  usageFor?: (
    credentialId: string,
  ) => { readonly lastUsedAt: number; readonly lastSucceededAt?: number } | undefined,
): ProviderCredentialStateProjection {
  return Object.freeze({
    providerId: record.providerId,
    implementationAvailable,
    revision: record.revision,
    selectionGeneration: record.selectionGeneration,
    ...(record.activeCredentialId === undefined
      ? {}
      : { activeCredentialId: record.activeCredentialId }),
    switchPolicy: Object.freeze({ ...record.switchPolicy }),
    ...(record.profiles.length === 0
      ? {
          ambient: Object.freeze({
            kind: "external" as const,
            status: ambientStatus,
            message: ambientStatus === "configured"
              ? "External auth is configured and resolved when the Provider is used"
              : "External auth is resolved only when the Provider is used",
          }),
        }
      : {}),
    profiles: Object.freeze(
      record.profiles.map((profile) =>
        projectProfile(
          profile,
          healthFor?.(profile.credentialId),
          usageFor?.(profile.credentialId),
        ),
      ),
    ),
  });
}

function validDisplayName(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && Array.from(normalized).length <= 64;
}

function validNote(value: string | undefined): boolean {
  return value === undefined || Array.from(value).length <= 200;
}

function createInitialRecord(input: {
  readonly providerId: string;
  readonly selectionGeneration: string;
  readonly profile: PersistedCredentialProfileV1;
}): PersistedProviderCredentialRecordV1 {
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

function withoutActiveCredential(
  record: PersistedProviderCredentialRecordV1,
): Omit<PersistedProviderCredentialRecordV1, "activeCredentialId"> {
  return {
    schemaVersion: record.schemaVersion,
    providerId: record.providerId,
    revision: record.revision,
    selectionGeneration: record.selectionGeneration,
    switchPolicy: record.switchPolicy,
    profiles: record.profiles,
  };
}

function withoutIdentityHint(
  profile: PersistedCredentialProfileV1,
): Omit<PersistedCredentialProfileV1, "identityHint"> {
  return {
    credentialId: profile.credentialId,
    credentialGeneration: profile.credentialGeneration,
    authType: profile.authType,
    authMethodLabel: profile.authMethodLabel,
    displayName: profile.displayName,
    ...(profile.note === undefined ? {} : { note: profile.note }),
    enabled: profile.enabled,
    priority: profile.priority,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    credential: profile.credential,
  };
}

function withoutNote(
  profile: PersistedCredentialProfileV1,
): Omit<PersistedCredentialProfileV1, "note"> {
  return {
    credentialId: profile.credentialId,
    credentialGeneration: profile.credentialGeneration,
    authType: profile.authType,
    authMethodLabel: profile.authMethodLabel,
    displayName: profile.displayName,
    ...(profile.identityHint === undefined
      ? {}
      : { identityHint: profile.identityHint }),
    enabled: profile.enabled,
    priority: profile.priority,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    credential: profile.credential,
  };
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
}): ProviderCredentialProfilesComposition {
  const scope = new AsyncLocalStorage<BindingScope>();
  const capturedScopes = new WeakMap<ProviderAuthBindingCapture, ManagedBindingScope | AmbientBindingScope>();
  const runtimeHealth = new Map<
    string,
    {
      refreshing: number;
      terminal?: "ready" | "reconnect_required";
      cooldownUntil?: number;
    }
  >();

  const healthKey = (providerId: string, credentialId: string): string =>
    `${providerId}\u0000${credentialId}`;
  let latestProjection: CredentialProfilesProjection = Object.freeze({
    providers: Object.freeze([]),
  });
  const knownSecrets = new Set<string>();
  const trackCredentialSecrets = (credential: Credential): void => {
    for (const secret of credentialSecrets(credential)) knownSecrets.add(secret);
  };
  const projectedRuntimeHealth = (
    providerId: string,
    credentialId: string,
  ): CredentialHealth | undefined => {
    const state = runtimeHealth.get(healthKey(providerId, credentialId));
    if (state === undefined) return undefined;
    if (state.refreshing > 0) return "refreshing";
    if (state.terminal === "reconnect_required") return "reconnect_required";
    if (state.cooldownUntil !== undefined && state.cooldownUntil > options.now()) {
      return "cooling_down";
    }
    return state.terminal;
  };

  const providerFor = (providerId: string): Provider | undefined =>
    options.providers().find((provider) => provider.id === providerId);

  const managedCapture = (
    record: PersistedProviderCredentialRecordV1,
    active: PersistedCredentialProfileV1,
  ): ManagedProviderAuthBindingCapture => {
    const managedScope: ManagedBindingScope = Object.freeze({
      kind: "managed",
      providerId: record.providerId,
      credentialId: active.credentialId,
      authType: active.authType,
      authMethodLabel: active.authMethodLabel,
      displayName: active.displayName,
      credentialGeneration: active.credentialGeneration,
      selectionGeneration: record.selectionGeneration,
    });
    const capture: ManagedProviderAuthBindingCapture = Object.freeze({
      facts: Object.freeze({ ...managedScope }),
    });
    capturedScopes.set(capture, managedScope);
    return capture;
  };
  const projectProviderRecord = (
    record: PersistedProviderCredentialRecordV1,
    implementationAvailable: boolean,
  ): ProviderCredentialStateProjection => {
    const usage = new Map(
      (options.credentialUsage?.(
        record.profiles.map((profile) => profile.credentialId),
      ) ?? []).map((entry) => [entry.credentialId, entry] as const),
    );
    return projectRecord(
      record,
      implementationAvailable,
      options.ambientStatus?.(record.providerId) ?? "unknown",
      (credentialId) => projectedRuntimeHealth(record.providerId, credentialId),
      (credentialId) => usage.get(credentialId),
    );
  };

  const mutateProfile = async (
    input: ProfileTargetInput,
    mutation: (input: {
      readonly current: PersistedProviderCredentialRecordV1;
      readonly profile: PersistedCredentialProfileV1;
      readonly profileIndex: number;
    }) =>
      | { readonly kind: "commit"; readonly record: PersistedProviderCredentialRecordV1 }
      | { readonly kind: "unchanged" }
      | { readonly kind: "reject"; readonly outcome: ProfileMutationOutcome; readonly error?: string },
  ): Promise<ProfileMutationResult> => {
    try {
      const result = await options.recordStore.modifyManagement(
        input.providerId,
        input.expectedRevision,
        (current) => {
          if (current === undefined) {
            return { kind: "unchanged", value: { outcome: "unknown_provider" as const } };
          }
          const profileIndex = current.profiles.findIndex(
            (profile) => profile.credentialId === input.credentialId,
          );
          if (profileIndex < 0) {
            return { kind: "unchanged", value: { outcome: "unknown_profile" as const } };
          }
          const next = mutation({
            current,
            profile: current.profiles[profileIndex]!,
            profileIndex,
          });
          if (next.kind === "reject") {
            return {
              kind: "unchanged",
              value: { outcome: next.outcome, ...(next.error === undefined ? {} : { error: next.error }) },
            };
          }
          if (next.kind === "unchanged") {
            return { kind: "unchanged", value: { outcome: "ok" as const } };
          }
          return {
            kind: "commit",
            record: next.record,
            value: { outcome: "ok" as const },
          };
        },
      );
      if (result.kind === "revision_conflict") {
        return Object.freeze({ outcome: "conflict" });
      }
      if (result.value.outcome !== "ok") {
        return Object.freeze(result.value);
      }
      if (result.record === undefined) {
        return Object.freeze({ outcome: "unknown_provider" });
      }
      return Object.freeze({
        outcome: "ok",
        provider: projectProviderRecord(
          result.record,
          providerFor(input.providerId) !== undefined,
        ),
      });
    } catch {
      return Object.freeze({
        outcome: "storage_failure",
        error: "Provider credential state could not be updated",
      });
    }
  };

  const credentialStore: CredentialStore = Object.freeze({
    async read(
      providerId: string,
      operationOptions?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
      throwIfAborted(operationOptions);
      const binding = scope.getStore();
      if (binding === undefined || binding.providerId !== providerId) {
        throw new Error("Pi credential read requires an exact Provider Profile binding");
      }
      if (binding.kind === "ambient" || binding.kind === "login") {
        return undefined;
      }
      let record: PersistedProviderCredentialRecordV1 | undefined;
      try {
        record = await options.recordStore.read(providerId);
      } catch {
        throw new ProviderAuthBindingError(
          "storage_failure",
          "Bound Provider credential state could not be read",
        );
      }
      const profile = record?.profiles.find(
        (candidate) => candidate.credentialId === binding.credentialId,
      );
      if (
        profile === undefined ||
        !profile.enabled ||
        profile.credentialGeneration !== binding.credentialGeneration ||
        profile.authType !== binding.authType
      ) {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "The bound Provider credential is no longer current",
        );
      }
      trackCredentialSecrets(profile.credential);
      return structuredClone(profile.credential);
    },

    async list(operationOptions?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      throwIfAborted(operationOptions);
      const binding = scope.getStore();
      if (binding === undefined) {
        throw new Error("Pi credential listing requires an exact Provider Profile binding");
      }
      if (binding.kind === "managed") {
        return Object.freeze([{ providerId: binding.providerId, type: binding.authType }]);
      }
      return Object.freeze([]);
    },

    async modify(
      providerId: string,
      mutation: (current: Credential | undefined) => Promise<Credential | undefined>,
      operationOptions?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
      throwIfAborted(operationOptions);
      const binding = scope.getStore();
      if (binding === undefined || binding.providerId !== providerId) {
        throw new Error("Pi credential mutation requires an exact Provider Profile binding");
      }

      if (binding.kind === "ambient") {
        throw new Error("Ambient Provider authentication is not LuckyToken-managed");
      }
      if (binding.kind === "managed") {
        const key = healthKey(providerId, binding.credentialId);
        const before = runtimeHealth.get(key) ?? { refreshing: 0 };
        runtimeHealth.set(key, { ...before, refreshing: before.refreshing + 1 });
        try {
          const result = await options.recordStore.modifyCredential(
            providerId,
            binding.credentialId,
            binding.credentialGeneration,
            async (current) => {
              trackCredentialSecrets(current);
              const next = await mutation(structuredClone(current));
              if (next === undefined) return undefined;
              const validated = validateCredential(next, binding.authType);
              trackCredentialSecrets(validated);
              return validated;
            },
          );
          const latest = runtimeHealth.get(key);
          if (latest !== undefined) {
            const refreshing = Math.max(0, latest.refreshing - 1);
            if (refreshing === 0 && latest.terminal === undefined) {
              runtimeHealth.delete(key);
            } else {
              runtimeHealth.set(key, { ...latest, refreshing });
            }
          }
          return result;
        } catch (error) {
          const latest = runtimeHealth.get(key) ?? { refreshing: 1 };
          const refreshing = Math.max(0, latest.refreshing - 1);
          if (demonstratesInvalidOAuthCredential(providerId, error)) {
            runtimeHealth.set(key, {
              ...latest,
              refreshing,
              terminal: "reconnect_required",
            });
          } else if (
            refreshing === 0 &&
            latest.terminal === undefined &&
            latest.cooldownUntil === undefined
          ) {
            runtimeHealth.delete(key);
          } else {
            runtimeHealth.set(key, { ...latest, refreshing });
          }
          throw error;
        }
      }

      const credential = validateCredential(await mutation(undefined), binding.authType);
      trackCredentialSecrets(credential);
      const provider = providerFor(providerId);
      const authMethodLabel = provider === undefined
        ? undefined
        : providerAuthLabel(provider, binding.authType);
      if (authMethodLabel === undefined) {
        throw new CredentialProfileOperationError(
          "unavailable",
          "Provider authentication method is no longer available",
        );
      }

      const timestamp = options.now();
      const hint = identityHint(credential);
      const profile: PersistedCredentialProfileV1 = {
        credentialId: binding.credentialId,
        credentialGeneration: binding.credentialGeneration,
        authType: binding.authType,
        authMethodLabel,
        displayName: binding.displayName,
        ...(binding.note === undefined ? {} : { note: binding.note }),
        ...(hint === undefined ? {} : { identityHint: hint }),
        enabled: true,
        priority: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        credential,
      };

      if (metadataContainsSecret(profile.displayName, profile.note, [profile])) {
        throw new CredentialProfileOperationError(
          "invalid",
          "Profile metadata must not contain stored credential secrets",
        );
      }

      const result = await options.recordStore.modifyManagement(
        providerId,
        binding.expectedRevision,
        (current) => {
          if (binding.mode === "reconnect") {
            if (current === undefined) {
              throw new CredentialProfileOperationError(
                "unknown_provider",
                "Provider credential state is missing",
              );
            }
            const profileIndex = current.profiles.findIndex(
              (candidate) => candidate.credentialId === binding.credentialId,
            );
            if (profileIndex < 0) {
              throw new CredentialProfileOperationError(
                "unknown_profile",
                "Credential Profile is missing",
              );
            }
            const target = current.profiles[profileIndex]!;
            if (target.authType !== binding.authType) {
              throw new CredentialProfileOperationError(
                "invalid",
                "Credential Profile authentication method changed",
              );
            }
            const replacement: PersistedCredentialProfileV1 = {
              ...withoutIdentityHint(target),
              credentialGeneration: binding.credentialGeneration,
              authMethodLabel,
              ...(hint === undefined ? {} : { identityHint: hint }),
              updatedAt: timestamp,
              credential,
            };
            const profiles = [...current.profiles];
            profiles[profileIndex] = replacement;
            if (recordMetadataContainsSecret(profiles)) {
              throw new CredentialProfileOperationError(
                "invalid",
                "Profile metadata must not contain stored credential secrets",
              );
            }
            const shouldActivate = binding.useNow && current.activeCredentialId !== binding.credentialId;
            return {
              kind: "commit",
              record: {
                ...current,
                ...(shouldActivate
                  ? {
                      activeCredentialId: binding.credentialId,
                      selectionGeneration: options.createId(),
                    }
                  : {}),
                profiles,
              },
              value: undefined,
            };
          }

          if (current?.profiles.some(
            (candidate) => candidate.displayName.toLocaleLowerCase() === binding.displayName.toLocaleLowerCase(),
          ) === true) {
            throw new CredentialProfileOperationError(
              "duplicate",
              "A Profile with this name already exists for the Provider",
            );
          }

          const nextProfile = {
            ...profile,
            priority: current?.profiles.length ?? 0,
          };
          if (current === undefined) {
            return {
              kind: "commit",
              record: createInitialRecord({
                providerId,
                selectionGeneration: options.createId(),
                profile: nextProfile,
              }),
              value: undefined,
            };
          }

          const profiles = [...current.profiles, nextProfile];
          if (recordMetadataContainsSecret(profiles)) {
            throw new CredentialProfileOperationError(
              "invalid",
              "Profile metadata must not contain stored credential secrets",
            );
          }
          const shouldActivate = current.profiles.length === 0 || binding.useNow;
          return {
            kind: "commit",
            record: {
              ...current,
              ...(shouldActivate
                ? {
                    activeCredentialId: binding.credentialId,
                    selectionGeneration: options.createId(),
                  }
                : {}),
              profiles,
            },
            value: undefined,
          };
        },
      );
      if (result.kind === "revision_conflict") {
        throw new CredentialProfileOperationError(
          "conflict",
          "Credential Profile state changed; re-query and retry",
        );
      }
      if (binding.mode === "reconnect") {
        runtimeHealth.delete(healthKey(providerId, binding.credentialId));
      }
      return structuredClone(credential);
    },

    async delete(providerId: string, operationOptions?: AuthOperationOptions): Promise<void> {
      throwIfAborted(operationOptions);
      const binding = scope.getStore();
      if (binding === undefined || binding.providerId !== providerId) {
        throw new Error("Pi credential deletion requires an exact Provider Profile binding");
      }
      throw new Error("Login bindings cannot delete Provider Profiles");
    },
  });

  const management: CredentialProfileManagement = Object.freeze({
    snapshot(): CredentialProfilesProjection {
      return latestProjection;
    },

    async query(providerIds?: readonly string[]): Promise<CredentialProfilesProjection> {
      const requested = providerIds === undefined
        ? new Set([
            ...options.providers().map((provider) => provider.id),
            ...(await options.recordStore.listProviderIds()),
          ])
        : new Set(providerIds);
      const projections: ProviderCredentialStateProjection[] = [];
      for (const providerId of [...requested].sort()) {
        let record: PersistedProviderCredentialRecordV1 | undefined;
        try {
          record = await options.recordStore.read(providerId);
        } catch (error) {
          const invalid =
            error instanceof ProviderCredentialRecordSyntaxError ||
            error instanceof ProviderCredentialRecordShapeError;
          projections.push(Object.freeze({
            providerId,
            implementationAvailable: providerFor(providerId) !== undefined,
            recordError: Object.freeze({
              code: invalid ? "invalid_record" : "storage_error",
              message: invalid
                ? "Stored Provider credential record is invalid"
                : "Stored Provider credential record is unavailable",
            }),
            profiles: Object.freeze([]),
          }));
          continue;
        }
        if (record === undefined) {
          if (providerFor(providerId) !== undefined) {
            projections.push(Object.freeze({
              providerId,
              implementationAvailable: true,
              revision: NO_PROVIDER_RECORD_REVISION,
              ambient: Object.freeze({
                kind: "external",
                status: options.ambientStatus?.(providerId) ?? "unknown",
                message: options.ambientStatus?.(providerId) === "configured"
                  ? "External auth is configured and resolved when the Provider is used"
                  : "External auth is resolved only when the Provider is used",
              }),
              profiles: Object.freeze([]),
            }));
          }
          continue;
        }
        for (const profile of record.profiles) {
          trackCredentialSecrets(profile.credential);
        }
        projections.push(projectProviderRecord(
          record,
          providerFor(providerId) !== undefined,
        ));
      }
      latestProjection = Object.freeze({ providers: Object.freeze(projections) });
      return latestProjection;
    },

    async updateMetadata(input: UpdateProfileMetadataInput): Promise<ProfileMutationResult> {
      if (!validDisplayName(input.displayName) || !validNote(input.note)) {
        return Object.freeze({
          outcome: "invalid",
          error: "Profile metadata is outside the supported bounds",
        });
      }
      try {
        const result = await options.recordStore.modifyManagement(
          input.providerId,
          input.expectedRevision,
          (current) => {
            if (current === undefined) {
              return { kind: "unchanged", value: "unknown_provider" as const };
            }
            const profileIndex = current.profiles.findIndex(
              (profile) => profile.credentialId === input.credentialId,
            );
            if (profileIndex < 0) {
              return { kind: "unchanged", value: "unknown_profile" as const };
            }
            const normalizedName = input.displayName.trim();
            if (metadataContainsSecret(normalizedName, input.note, current.profiles)) {
              return { kind: "unchanged", value: "invalid_secret" as const };
            }
            if (
              current.profiles.some(
                (profile, index) =>
                  index !== profileIndex &&
                  profile.displayName.toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
              )
            ) {
              return { kind: "unchanged", value: "duplicate" as const };
            }
            const target = current.profiles[profileIndex]!;
            const updated: PersistedCredentialProfileV1 = {
              ...withoutNote(target),
              displayName: normalizedName,
              ...(input.note === undefined ? {} : { note: input.note }),
              updatedAt: options.now(),
            };
            const nextProfiles = [...current.profiles];
            nextProfiles[profileIndex] = updated;
            return {
              kind: "commit",
              record: { ...current, profiles: nextProfiles },
              value: "ok" as const,
            };
          },
        );
        if (result.kind === "revision_conflict") {
          return Object.freeze({ outcome: "conflict" });
        }
        if (result.value !== "ok") {
          if (result.value === "invalid_secret") {
            return Object.freeze({
              outcome: "invalid",
              error: "Profile metadata must not contain stored credential secrets",
            });
          }
          return Object.freeze({ outcome: result.value });
        }
        return Object.freeze({
          outcome: "ok",
          provider: projectProviderRecord(
            result.record!,
            providerFor(input.providerId) !== undefined,
          ),
        });
      } catch {
        return Object.freeze({
          outcome: "storage_failure",
          error: "Provider credential state could not be updated",
        });
      }
    },

    async activate(input: ActivateProfileInput): Promise<ProfileMutationResult> {
      return mutateProfile(input, ({ current, profile }) => {
        if (!profile.enabled) {
          return {
            kind: "reject",
            outcome: "invalid",
            error: "A disabled Profile cannot be activated",
          };
        }
        if (current.activeCredentialId === profile.credentialId) {
          return { kind: "unchanged" };
        }
        return {
          kind: "commit",
          record: {
            ...current,
            activeCredentialId: profile.credentialId,
            selectionGeneration: options.createId(),
          },
        };
      });
    },

    async setEnabled(input: SetProfileEnabledInput): Promise<ProfileMutationResult> {
      return mutateProfile(input, ({ current, profile, profileIndex }) => {
        if (profile.enabled === input.enabled) {
          return { kind: "unchanged" };
        }
        const nextProfiles = [...current.profiles];
        nextProfiles[profileIndex] = {
          ...profile,
          enabled: input.enabled,
          updatedAt: options.now(),
        };
        if (!input.enabled && current.activeCredentialId === profile.credentialId) {
          return {
            kind: "commit",
            record: {
              ...withoutActiveCredential(current),
              selectionGeneration: options.createId(),
              profiles: nextProfiles,
            },
          };
        }
        return {
          kind: "commit",
          record: { ...current, profiles: nextProfiles },
        };
      });
    },

    async setPriority(input: SetProfilePriorityInput): Promise<ProfileMutationResult> {
      if (!Number.isSafeInteger(input.priority)) {
        return Object.freeze({
          outcome: "invalid",
          error: "Profile priority must be a safe integer",
        });
      }
      return mutateProfile(input, ({ current, profile, profileIndex }) => {
        if (profile.priority === input.priority) {
          return { kind: "unchanged" };
        }
        const nextProfiles = [...current.profiles];
        nextProfiles[profileIndex] = {
          ...profile,
          priority: input.priority,
          updatedAt: options.now(),
        };
        return {
          kind: "commit",
          record: { ...current, profiles: nextProfiles },
        };
      });
    },

    async remove(input: RemoveProfileInput): Promise<ProfileMutationResult> {
      const result = await mutateProfile(input, ({ current, profile, profileIndex }) => {
        const nextProfiles = current.profiles.filter((_candidate, index) => index !== profileIndex);
        if (current.activeCredentialId === profile.credentialId) {
          return {
            kind: "commit",
            record: {
              ...withoutActiveCredential(current),
              selectionGeneration: options.createId(),
              profiles: nextProfiles,
            },
          };
        }
        return {
          kind: "commit",
          record: { ...current, profiles: nextProfiles },
        };
      });
      if (result.outcome === "ok") {
        runtimeHealth.delete(healthKey(input.providerId, input.credentialId));
      }
      return result;
    },

    async setSwitchPolicy(
      input: SetProviderSwitchPolicyInput,
    ): Promise<ProfileMutationResult> {
      try {
        const result = await options.recordStore.modifyManagement(
          input.providerId,
          input.expectedRevision,
          (current) => {
            if (current === undefined) {
              return { kind: "unchanged", value: "unknown_provider" as const };
            }
            if (
              current.switchPolicy.apiKeyOn429 === input.apiKeyOn429 &&
              current.switchPolicy.oauthOn429 === input.oauthOn429
            ) {
              return { kind: "unchanged", value: "ok" as const };
            }
            return {
              kind: "commit",
              record: {
                ...current,
                switchPolicy: {
                  apiKeyOn429: input.apiKeyOn429,
                  oauthOn429: input.oauthOn429,
                },
              },
              value: "ok" as const,
            };
          },
        );
        if (result.kind === "revision_conflict") {
          return Object.freeze({ outcome: "conflict" });
        }
        if (result.value !== "ok" || result.record === undefined) {
          return Object.freeze({ outcome: "unknown_provider" });
        }
        return Object.freeze({
          outcome: "ok",
          provider: projectProviderRecord(
            result.record,
            providerFor(input.providerId) !== undefined,
          ),
        });
      } catch {
        return Object.freeze({
          outcome: "storage_failure",
          error: "Provider credential settings could not be updated",
        });
      }
    },
  });

  const binding: ProviderAuthBindingAuthority = Object.freeze({
    async capture(providerId: string): Promise<ProviderAuthBindingCapture> {
      if (providerFor(providerId) === undefined) {
        throw new ProviderAuthBindingError(
          "unknown_provider",
          "Provider implementation is unavailable",
        );
      }
      let record: PersistedProviderCredentialRecordV1 | undefined;
      try {
        record = await options.recordStore.read(providerId);
      } catch {
        throw new ProviderAuthBindingError(
          "storage_failure",
          "Provider credential state could not be read",
        );
      }

      if (record === undefined || record.profiles.length === 0) {
        const ambientScope: AmbientBindingScope = Object.freeze({
          kind: "ambient",
          providerId,
        });
        const capture: ProviderAuthBindingCapture = Object.freeze({
          facts: Object.freeze({ kind: "ambient", providerId }),
        });
        capturedScopes.set(capture, ambientScope);
        return capture;
      }

      const active = record.activeCredentialId === undefined
        ? undefined
        : record.profiles.find(
            (profile) => profile.credentialId === record.activeCredentialId,
          );
      const activeHealth = active === undefined
        ? undefined
        : runtimeHealth.get(healthKey(providerId, active.credentialId));
      if (
        active === undefined ||
        !active.enabled ||
        activeHealth?.terminal === "reconnect_required" ||
        (activeHealth?.cooldownUntil !== undefined && activeHealth.cooldownUntil > options.now())
      ) {
        throw new ProviderAuthBindingError(
          "no_active_profile",
          "Managed Provider Profiles exist but no enabled active Profile is selected",
        );
      }
      return managedCapture(record, active);
    },

    async captureForRecheck(
      input: CaptureProfileForRecheckInput,
    ): Promise<ProviderAuthBindingCapture> {
      if (providerFor(input.providerId) === undefined) {
        throw new ProviderAuthBindingError(
          "unknown_provider",
          "Provider implementation is unavailable",
        );
      }
      let record: PersistedProviderCredentialRecordV1 | undefined;
      try {
        record = await options.recordStore.read(input.providerId);
      } catch {
        throw new ProviderAuthBindingError(
          "storage_failure",
          "Provider credential state could not be read",
        );
      }
      if (record?.revision !== input.expectedRevision) {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "Credential Profile state changed before recheck",
        );
      }
      const active = record.profiles.find(
        (profile) => profile.credentialId === input.credentialId,
      );
      if (
        active === undefined ||
        !active.enabled ||
        record.activeCredentialId !== active.credentialId
      ) {
        throw new ProviderAuthBindingError(
          "no_active_profile",
          "Only the enabled active Profile can be rechecked",
        );
      }
      return managedCapture(record, active);
    },

    async createLoginBinding(input: CreateLoginBindingInput): Promise<CredentialLoginBinding> {
      const provider = providerFor(input.providerId);
      if (provider === undefined) {
        throw new CredentialProfileOperationError(
          "unavailable",
          "Provider implementation is unavailable",
        );
      }
      if (!providerSupportsLogin(provider, input.authType)) {
        throw new CredentialProfileOperationError(
          "unavailable",
          "Provider authentication method cannot be added interactively",
        );
      }
      if (!validDisplayName(input.displayName) || !validNote(input.note)) {
        throw new CredentialProfileOperationError(
          "invalid",
          "Profile display name is outside the supported bounds",
        );
      }
      let current: PersistedProviderCredentialRecordV1 | undefined;
      try {
        current = await options.recordStore.read(input.providerId);
      } catch {
        throw new CredentialProfileOperationError(
          "storage_failure",
          "Provider credential state could not be read",
        );
      }
      if ((current?.revision ?? NO_PROVIDER_RECORD_REVISION) !== input.expectedRevision) {
        throw new CredentialProfileOperationError(
          "conflict",
          "Credential Profile state changed; re-query and retry",
        );
      }
      if (
        current?.profiles.some(
          (profile) =>
            profile.displayName.toLocaleLowerCase() ===
            input.displayName.trim().toLocaleLowerCase(),
        ) === true
      ) {
        throw new CredentialProfileOperationError(
          "duplicate",
          "A Profile with this name already exists for the Provider",
        );
      }
      return Object.freeze({
        kind: "login",
        mode: "add",
        providerId: input.providerId,
        authType: input.authType,
        displayName: input.displayName.trim(),
        ...(input.note === undefined ? {} : { note: input.note }),
        useNow: input.useNow,
        expectedRevision: input.expectedRevision,
        credentialId: options.createId(),
        credentialGeneration: options.createId(),
      });
    },

    async createReconnectBinding(
      input: CreateReconnectBindingInput,
    ): Promise<CredentialLoginBinding> {
      const provider = providerFor(input.providerId);
      if (provider === undefined) {
        throw new CredentialProfileOperationError(
          "unavailable",
          "Provider implementation is unavailable",
        );
      }
      let current: PersistedProviderCredentialRecordV1 | undefined;
      try {
        current = await options.recordStore.read(input.providerId);
      } catch {
        throw new CredentialProfileOperationError(
          "storage_failure",
          "Provider credential state could not be read",
        );
      }
      if ((current?.revision ?? NO_PROVIDER_RECORD_REVISION) !== input.expectedRevision) {
        throw new CredentialProfileOperationError(
          "conflict",
          "Credential Profile state changed; re-query and retry",
        );
      }
      const profile = current?.profiles.find(
        (candidate) => candidate.credentialId === input.credentialId,
      );
      if (profile === undefined) {
        throw new CredentialProfileOperationError(
          "unknown_profile",
          "Credential Profile is missing",
        );
      }
      if (!providerSupportsLogin(provider, profile.authType)) {
        throw new CredentialProfileOperationError(
          "unavailable",
          "Provider authentication method cannot be reconnected interactively",
        );
      }
      return Object.freeze({
        kind: "login",
        mode: "reconnect",
        providerId: input.providerId,
        authType: profile.authType,
        displayName: profile.displayName,
        ...(profile.note === undefined ? {} : { note: profile.note }),
        useNow: input.useNow,
        expectedRevision: input.expectedRevision,
        credentialId: profile.credentialId,
        credentialGeneration: options.createId(),
      });
    },

    async advanceAfterFinal429(
      input: AdvanceAfterFinal429Input,
    ): Promise<AdvanceAfterFinal429Result> {
      input.signal?.throwIfAborted();
      const failedScope = capturedScopes.get(input.capture);
      if (failedScope === undefined || failedScope.kind !== "managed") {
        return Object.freeze({ outcome: "stale_binding" });
      }
      const attempted = new Set(input.attemptedCredentialIds);
      attempted.add(failedScope.credentialId);
      if (attempted.size >= MAX_PROFILE_ATTEMPTS_PER_REQUEST) {
        return Object.freeze({ outcome: "exhausted" });
      }

      type SwitchValue =
        | { readonly outcome: "disabled" | "exhausted" | "stale_binding" }
        | {
            readonly outcome: "switched";
            readonly target: Omit<ManagedBindingScope, "kind">;
          };
      let result;
      try {
        result = await options.recordStore.modifySelection<SwitchValue>(
          failedScope.providerId,
          (current) => {
            input.signal?.throwIfAborted();
            const failed = current?.profiles.find(
              (profile) => profile.credentialId === failedScope.credentialId,
            );
            if (
              current === undefined ||
              failed === undefined ||
              failed.credentialGeneration !== failedScope.credentialGeneration ||
              current.selectionGeneration !== failedScope.selectionGeneration ||
              current.activeCredentialId !== failedScope.credentialId
            ) {
              return {
                kind: "unchanged",
                value: { outcome: "stale_binding" as const },
              };
            }
            const enabled = failed.authType === "api_key"
              ? current.switchPolicy.apiKeyOn429
              : current.switchPolicy.oauthOn429;
            if (!enabled) {
              return {
                kind: "unchanged",
                value: { outcome: "disabled" as const },
              };
            }
            const candidates = current.profiles
              .filter((profile) => {
                if (
                  profile.authType !== failed.authType ||
                  !profile.enabled ||
                  attempted.has(profile.credentialId)
                ) {
                  return false;
                }
                const health = runtimeHealth.get(
                  healthKey(current.providerId, profile.credentialId),
                );
                return (
                  health?.terminal !== "reconnect_required" &&
                  !(health?.cooldownUntil !== undefined && health.cooldownUntil > options.now())
                );
              })
              .sort(
                (left, right) =>
                  left.priority - right.priority ||
                  left.credentialId.localeCompare(right.credentialId),
              );
            const target = candidates[0];
            if (target === undefined) {
              return {
                kind: "unchanged",
                value: { outcome: "exhausted" as const },
              };
            }
            const selectionGeneration = options.createId();
            return {
              kind: "commit",
              record: {
                ...current,
                activeCredentialId: target.credentialId,
                selectionGeneration,
              },
              value: {
                outcome: "switched" as const,
                target: {
                  providerId: current.providerId,
                  credentialId: target.credentialId,
                  authType: target.authType,
                  authMethodLabel: target.authMethodLabel,
                  displayName: target.displayName,
                  credentialGeneration: target.credentialGeneration,
                  selectionGeneration,
                },
              },
            };
          },
        );
      } catch (error) {
        if (input.signal?.aborted === true) throw error;
        return Object.freeze({ outcome: "storage_failure" });
      }

      const retryAfterMs = input.retryAfterMs;
      if (
        result.value.outcome !== "stale_binding" &&
        retryAfterMs !== undefined &&
        Number.isFinite(retryAfterMs) &&
        retryAfterMs >= 0 &&
        retryAfterMs <= 86_400_000
      ) {
        const key = healthKey(failedScope.providerId, failedScope.credentialId);
        const currentHealth = runtimeHealth.get(key) ?? { refreshing: 0 };
        runtimeHealth.set(key, {
          ...currentHealth,
          cooldownUntil: options.now() + retryAfterMs,
        });
      }
      if (result.value.outcome !== "switched") {
        return Object.freeze({ outcome: result.value.outcome });
      }

      const targetScope: ManagedBindingScope = Object.freeze({
        kind: "managed",
        ...result.value.target,
      });
      const capture: ManagedProviderAuthBindingCapture = Object.freeze({
        facts: Object.freeze({
          kind: "managed",
          providerId: targetScope.providerId,
          credentialId: targetScope.credentialId,
          authType: targetScope.authType,
          authMethodLabel: targetScope.authMethodLabel,
          displayName: targetScope.displayName,
          credentialGeneration: targetScope.credentialGeneration,
          selectionGeneration: targetScope.selectionGeneration,
        }),
      });
      capturedScopes.set(capture, targetScope);
      return Object.freeze({ outcome: "switched", capture });
    },

    async publishIfCurrent(
      capture: ProviderAuthBindingCapture,
      publish: (assertCurrent: () => void) => Promise<void> | void,
    ): Promise<boolean> {
      const captured = capturedScopes.get(capture);
      if (captured === undefined || providerFor(captured.providerId) === undefined) {
        return false;
      }
      return options.recordStore.withSelectionLock(
        captured.providerId,
        async (current, assertOwned) => {
            const currentMatches = captured.kind === "ambient"
              ? current === undefined || current.profiles.length === 0
              : (() => {
                  const health = runtimeHealth.get(
                    healthKey(captured.providerId, captured.credentialId),
                  );
                  return current !== undefined &&
                    current.activeCredentialId === captured.credentialId &&
                    current.selectionGeneration === captured.selectionGeneration &&
                    health?.terminal !== "reconnect_required" &&
                    !(
                      health?.cooldownUntil !== undefined &&
                      health.cooldownUntil > options.now()
                    ) &&
                    current.profiles.some(
                      (profile) =>
                        profile.credentialId === captured.credentialId &&
                        profile.credentialGeneration === captured.credentialGeneration &&
                        profile.authType === captured.authType &&
                        profile.enabled,
                    );
                })();
          if (!currentMatches) return false;
          assertOwned();
          await publish(assertOwned);
          return true;
        },
      );
    },

    async runBound<T>(
      requestedBinding: CredentialLoginBinding | ProviderAuthBindingCapture,
      operation: () => Promise<T>,
    ): Promise<T> {
      if (scope.getStore() !== undefined) {
        throw new Error("Provider Profile bindings cannot be nested");
      }
      const bindingScope: BindingScope | undefined = "facts" in requestedBinding
        ? capturedScopes.get(requestedBinding)
        : requestedBinding;
      if (bindingScope === undefined) {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "Provider Profile capture did not originate from this Authority",
        );
      }
      return scope.run(bindingScope, operation);
    },
  });

  return Object.freeze({
    management,
    binding,
    credentialStore,
    scrub(value: string): string {
      let scrubbed = value;
      for (const secret of [...knownSecrets].sort((left, right) => right.length - left.length)) {
        scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
      }
      return scrubbed;
    },
  });
}
