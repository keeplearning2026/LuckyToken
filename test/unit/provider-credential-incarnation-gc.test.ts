import { describe, expect, it } from "vitest";

import {
  NO_PROVIDER_RECORD_REVISION,
  PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
  createInMemoryProviderCredentialRecordStore,
  managedCredentialReference,
} from "../../src/credentials/profile-record-store.js";

describe("managed credential garbage collection", () => {
  it("collects only an unreferenced managed document", async () => {
    let revision = 0;
    const store = createInMemoryProviderCredentialRecordStore({
      createRevision: () => `r-${++revision}`,
      now: () => 100,
    });
    const reference = managedCredentialReference("anthropic", "credential-a");
    const published = await store.publishCredential(
      "anthropic",
      {
        credentialId: "credential-a",
        reference,
        content: "secret\n",
      },
      () => ({
        kind: "commit",
        record: {
          schemaVersion: PROVIDER_CREDENTIAL_RECORD_SCHEMA_VERSION,
          providerId: "anthropic",
          revision: NO_PROVIDER_RECORD_REVISION,
          selectionGeneration: "s1",
          activeCredentialId: "credential-a",
          switchPolicy: { apiKeyOn429: false, oauthOn429: false },
          profiles: [{
            credentialId: "credential-a",
            acquisitionKind: "api_key",
            reference,
            displayName: "Primary",
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          }],
        },
        value: undefined,
      }),
    );

    expect(
      await store.collectOrphans("anthropic", {
        graceMs: 0,
        now: () => 101,
      }),
    ).toEqual([]);

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
            selectionGeneration: "s2",
            switchPolicy: current.switchPolicy,
            profiles: [],
          },
          value: undefined,
        };
      },
    );

    expect(
      await store.collectOrphans("anthropic", {
        graceMs: 0,
        now: () => 101,
      }),
    ).toEqual(["anthropic/credential-a/credential.auth.json"]);
  });
});
