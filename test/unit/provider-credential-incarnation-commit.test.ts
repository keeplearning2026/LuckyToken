import { describe, expect, it } from "vitest";

import {
  NO_PROVIDER_RECORD_REVISION,
  PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
  createInMemoryProviderCredentialRecordStore,
  managedCredentialReference,
  type PersistedCredentialProfile,
} from "../../src/credentials/profile-record-store.js";

function profile(
  credentialId: string,
  enabled = true,
): PersistedCredentialProfile {
  return {
    credentialId,
    acquisitionKind: "oauth",
    reference: managedCredentialReference("anthropic", credentialId),
    displayName: credentialId,
    enabled,
    createdAt: 1,
    updatedAt: 1,
  };
}

function recordWith(target: PersistedCredentialProfile) {
  return {
    schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
    providerId: "anthropic",
    revision: NO_PROVIDER_RECORD_REVISION,
    selectionGeneration: "selection-a",
    activeCredentialId: target.credentialId,
    switchPolicy: { apiKeyOn429: false, oauthOn429: false },
    profiles: [target],
  } as const;
}

describe("stable Provider credential document publication", () => {
  it("publishes one stable managed reference and reads the current document", async () => {
    let revision = 0;
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => `r-${++revision}`,
    });
    const target = profile("credential-a");

    await store.publishCredential(
      "anthropic",
      {
        credentialId: target.credentialId,
        reference: target.reference,
        content: JSON.stringify({
          type: "oauth",
          access: "access-a",
          refresh: "refresh-a",
          expires: 10_000,
        }),
      },
      () => ({
        kind: "commit",
        record: recordWith(target),
        value: undefined,
      }),
    );

    const first = await store.readCredentialDocument(
      "anthropic",
      "credential-a",
    );
    expect(first).toMatchObject({
      state: "ok",
      profile: {
        credentialId: "credential-a",
        reference: {
          owner: "managed",
          path: "anthropic/credential-a/credential.auth.json",
        },
      },
    });

    await store.modifyManagedDocument(
      "anthropic",
      "credential-a",
      async () =>
        JSON.stringify({
          type: "oauth",
          access: "access-b",
          refresh: "refresh-b",
          expires: 20_000,
        }),
    );
    const second = await store.readCredentialDocument(
      "anthropic",
      "credential-a",
    );
    expect(second.state).toBe("ok");
    if (second.state === "ok") {
      expect(second.profile.reference).toEqual(target.reference);
      expect(second.raw).toContain("access-b");
      expect(second.contentRevision).not.toBe(
        first.state === "ok" ? first.contentRevision : "",
      );
    }
  });

  it("discards a late managed refresh after Profile removal", async () => {
    let revision = 0;
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => `r-${++revision}`,
    });
    const target = profile("credential-a");
    const published = await store.publishCredential(
      "anthropic",
      {
        credentialId: target.credentialId,
        reference: target.reference,
        content: JSON.stringify({
          type: "oauth",
          access: "old",
          refresh: "refresh",
          expires: 1,
        }),
      },
      () => ({
        kind: "commit",
        record: recordWith(target),
        value: undefined,
      }),
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = store.modifyManagedDocument(
      "anthropic",
      "credential-a",
      async () => {
        await gate;
        return JSON.stringify({
          type: "oauth",
          access: "late",
          refresh: "refresh",
          expires: 99,
        });
      },
    );

    await Promise.resolve();
    if (published.kind !== "committed") {
      throw new Error("expected committed publication");
    }
    await store.modifyManagement(
      "anthropic",
      published.record.revision,
      (current) => {
        if (current === undefined) throw new Error("missing record");
        return {
          kind: "commit",
          record: {
            schemaVersion: current.schemaVersion,
            providerId: current.providerId,
            revision: current.revision,
            selectionGeneration: "selection-b",
            switchPolicy: current.switchPolicy,
            profiles: [],
          },
          value: undefined,
        };
      },
    );
    release();

    await expect(refresh).resolves.toBeUndefined();
    await expect(
      store.readCredentialDocument("anthropic", "credential-a"),
    ).resolves.toEqual({ state: "missing" });
    expect((await store.read("anthropic"))?.profiles).toEqual([]);
  });
});
