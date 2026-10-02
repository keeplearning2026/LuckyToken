import type { Credential } from "@earendil-works/pi-ai";

import { parseCodexInternalAuth } from "./codex-internal-auth.js";
import {
  parseApiKeyCredentialDocument,
  parseOAuthCredentialDocument,
  serializeApiKeyCredentialDocument,
  serializeOAuthCredentialDocument,
} from "./credential-document.js";
import type {
  PersistedCredentialProfile,
  ProviderCredentialRecordStore,
} from "./profile-record-store.js";

export interface ProfileCredentialOperations {
  read(
    providerId: string,
    profile: PersistedCredentialProfile,
  ): Promise<Credential | undefined>;

  modify(
    providerId: string,
    profile: PersistedCredentialProfile,
    mutation: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
}

export interface ProfileCredentialOperationsOverride {
  readonly providerId: string;
  readonly acquisitionKind: PersistedCredentialProfile["acquisitionKind"];
  readonly read?: ProfileCredentialOperations["read"];
  readonly modify?: ProfileCredentialOperations["modify"];
}

function expectedCredentialType(
  acquisitionKind: PersistedCredentialProfile["acquisitionKind"],
): Credential["type"] {
  return acquisitionKind === "api_key" ? "api_key" : "oauth";
}

function parseDefault(
  profile: PersistedCredentialProfile,
  raw: string,
): Credential | undefined {
  return profile.acquisitionKind === "api_key"
    ? parseApiKeyCredentialDocument(raw)
    : parseOAuthCredentialDocument(raw);
}

function serializeDefault(
  profile: PersistedCredentialProfile,
  credential: Credential,
): string {
  if (credential.type !== expectedCredentialType(profile.acquisitionKind)) {
    throw new Error("Profile credential mutation returned the wrong credential type");
  }
  return credential.type === "api_key"
    ? serializeApiKeyCredentialDocument(credential)
    : serializeOAuthCredentialDocument(credential);
}

export function createProfileCredentialOperations(options: {
  readonly store: ProviderCredentialRecordStore;
  readonly overrides?: readonly ProfileCredentialOperationsOverride[];
}): {
  resolve(
    providerId: string,
    profile: PersistedCredentialProfile,
  ): ProfileCredentialOperations;
} {
  const overrides = new Map<string, ProfileCredentialOperationsOverride>();
  for (const override of options.overrides ?? []) {
    const key = `${override.providerId}\u0000${override.acquisitionKind}`;
    if (overrides.has(key)) {
      throw new Error(
        `Duplicate Profile credential operations override for ${override.providerId}/${override.acquisitionKind}`,
      );
    }
    overrides.set(key, override);
  }

  const defaultRead: ProfileCredentialOperations["read"] = async (
    providerId,
    profile,
  ) => {
    const read = await options.store.readCredentialDocument(
      providerId,
      profile.credentialId,
    );
    if (read.state !== "ok") return undefined;
    if (
      read.profile.credentialId !== profile.credentialId ||
      read.profile.acquisitionKind !== profile.acquisitionKind ||
      read.profile.reference.owner !== profile.reference.owner ||
      read.profile.reference.path !== profile.reference.path
    ) {
      return undefined;
    }
    const credential = parseDefault(profile, read.raw);
    return credential?.type === expectedCredentialType(profile.acquisitionKind)
      ? credential
      : undefined;
  };

  const defaultManagedModify: ProfileCredentialOperations["modify"] = async (
    providerId,
    profile,
    mutation,
  ) => {
    if (profile.reference.owner !== "managed") {
      throw new Error("Managed Profile credential operation requires managed reference");
    }
    const raw = await options.store.modifyManagedDocument(
      providerId,
      profile.credentialId,
      async (currentRaw) => {
        const current = parseDefault(profile, currentRaw);
        if (
          current === undefined ||
          current.type !== expectedCredentialType(profile.acquisitionKind)
        ) {
          return undefined;
        }
        const next = await mutation(structuredClone(current));
        return next === undefined ? undefined : serializeDefault(profile, next);
      },
    );
    if (raw === undefined) return undefined;
    return parseDefault(profile, raw);
  };

  const resolve = (
    providerId: string,
    profile: PersistedCredentialProfile,
  ): ProfileCredentialOperations => {
    const override = overrides.get(
      `${providerId}\u0000${profile.acquisitionKind}`,
    );
    const selectedRead = override?.read ?? defaultRead;

    const selectedModify: ProfileCredentialOperations["modify"] =
      override?.modify ??
      (profile.acquisitionKind === "local_oauth"
        ? async (modifyProviderId, modifyProfile) =>
            selectedRead(modifyProviderId, modifyProfile)
        : defaultManagedModify);

    return Object.freeze({
      read: selectedRead,
      modify: selectedModify,
    });
  };

  return Object.freeze({ resolve });
}

export function codexLocalOAuthOperations(
  store: ProviderCredentialRecordStore,
): ProfileCredentialOperationsOverride {
  return Object.freeze({
    providerId: "openai-codex",
    acquisitionKind: "local_oauth" as const,
    async read(
      providerId: string,
      profile: PersistedCredentialProfile,
    ) {
      const read = await store.readCredentialDocument(
        providerId,
        profile.credentialId,
      );
      if (
        read.state !== "ok" ||
        read.profile.credentialId !== profile.credentialId ||
        read.profile.reference.owner !== "external" ||
        read.profile.reference.path !== profile.reference.path
      ) {
        return undefined;
      }
      return parseCodexInternalAuth(read.raw);
    },
  });
}
