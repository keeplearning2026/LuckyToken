import { CredentialProfileOperationError } from "./profile-contract.js";
import { parseCodexInternalAuth } from "./codex-internal-auth.js";
import { readExternalCredentialFile } from "./external-credential-file.js";
import {
  credentialProfileCarrier,
  NO_PROVIDER_RECORD_REVISION,
  PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
  type ProviderCredentialRecordStore,
} from "./profile-record-store.js";

/** Acquisition owns the entire replacement, shared by startup and Reconnect.
 * Only parsed credential material is imported; the source is never mutated. */
export function createCodexLocalLogin(options: {
  readonly store: ProviderCredentialRecordStore;
  readonly authPath: string;
  readonly createId: () => string;
  readonly now: () => number;
  readonly authMethodLabel: () => string;
}) {
  return async (target?: { readonly credentialId: string; readonly expectedRevision: string }) => {
    const credentialId = options.createId();
    const credentialGeneration = options.createId();
    const result = await options.store.rebuildCredential(
      "openai-codex", credentialId, target?.expectedRevision, async (current) => {
        if (target !== undefined && !current?.profiles.some(
          (profile) => profile.credentialId === target.credentialId && profile.acquisition === "codex_local",
        )) {
          throw new CredentialProfileOperationError("unknown_profile", "Credential Profile is missing");
        }
        const removed = current?.profiles.filter((profile) => profile.acquisition === "codex_local") ?? [];
        let profiles = current?.profiles.filter((profile) => profile.acquisition !== "codex_local") ?? [];
        // Removal is staged in this locked transaction. No intermediate list
        // is visible, and a failed publication leaves the old record intact.
        const file = await readExternalCredentialFile(options.authPath);
        const credential = file.state === "ok" ? parseCodexInternalAuth(file.raw) ?? null : null;
        const names = new Set(profiles.map((profile) => profile.displayName.toLocaleLowerCase()));
        let index = 1;
        while (names.has(`profile ${index}`)) index += 1;
        let maximumPriority = profiles.reduce((maximum, item) => Math.max(maximum, item.priority), -1);
        if (maximumPriority === Number.MAX_SAFE_INTEGER) {
          profiles = [...profiles].sort((left, right) =>
            left.priority - right.priority || left.createdAt - right.createdAt,
          ).map((item, priority) => ({ ...item, priority }));
          maximumPriority = profiles.length - 1;
        }
        const time = options.now();
        const profile = {
          credentialId, credentialGeneration, acquisition: "codex_local" as const,
          authType: "oauth" as const, authMethodLabel: options.authMethodLabel(),
          displayName: `Profile ${index}`, enabled: true,
          priority: maximumPriority + 1,
          createdAt: time, updatedAt: time,
          ...credentialProfileCarrier("openai-codex", credentialId, credentialGeneration, credential),
        };
        const transfer = current === undefined || removed.some(
          (item) => item.credentialId === current.activeCredentialId,
        );
        return {
          publication: { credentialId, credentialGeneration, credential },
          record: {
            schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
            providerId: "openai-codex",
            revision: current?.revision ?? NO_PROVIDER_RECORD_REVISION,
            selectionGeneration: transfer ? options.createId() : current!.selectionGeneration,
            ...(transfer ? { activeCredentialId: credentialId } :
              current?.activeCredentialId === undefined ? {} : { activeCredentialId: current.activeCredentialId }),
            switchPolicy: current?.switchPolicy ?? { apiKeyOn429: false, oauthOn429: false },
            profiles: [...profiles, profile],
          },
          value: { credentialId, credentialGeneration },
        };
      },
    );
    if (result.kind === "revision_conflict") {
      throw new CredentialProfileOperationError("conflict", "Credential Profile state changed; re-query and retry");
    }
    return result.value;
  };
}
