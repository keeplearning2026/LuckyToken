import type {
  AuthInteraction,
  AuthType,
  Models,
} from "@earendil-works/pi-ai";

import type {
  CredentialProfileManagement,
  ProviderAuthBindingAuthority,
} from "../../src/credentials/profile-contract.js";

export interface OnlineProviderLoginInput {
  readonly models: Models;
  readonly providerAuthBindings: ProviderAuthBindingAuthority;
  readonly credentialManagement: CredentialProfileManagement;
  readonly providerId: string;
  readonly authType: AuthType;
  readonly displayName: string;
  readonly interaction: AuthInteraction;
}

/** Login helper used by online runners. */
export async function loginOnlineProvider(
  input: OnlineProviderLoginInput,
): Promise<void> {
  const before = await input.credentialManagement.query([input.providerId]);
  const provider = before.providers.find(
    (candidate) => candidate.providerId === input.providerId,
  );
  if (provider === undefined || !provider.implementationAvailable) {
    throw new Error(`Online Provider ${input.providerId} is unavailable`);
  }
  const binding = await input.providerAuthBindings.createAcquisitionBinding({
    providerId: input.providerId,
    acquisitionKind: input.authType,
    displayName: input.displayName,
  });
  await input.providerAuthBindings.runBound(binding, () =>
    input.models.login(
      input.providerId,
      input.authType,
      input.interaction,
    ),
  );
  const after = await input.credentialManagement.query([input.providerId]);
  const persisted = after.providers
    .find((candidate) => candidate.providerId === input.providerId)
    ?.profiles.find(
      (candidate) => candidate.credentialId === binding.credentialId,
    );
  if (persisted === undefined) {
    throw new Error(
      `Provider login did not persist a Profile for ${input.providerId}`,
    );
  }
}
