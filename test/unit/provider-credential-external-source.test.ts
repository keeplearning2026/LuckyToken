import type { Credential, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { syntheticCodexAccess } from "../support/codex-credential-fixture.js";

import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import {
  credentialProfileCarrier,
  createInMemoryProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";
import { ProviderAuthBindingError } from "../../src/credentials/profile-contract.js";
import type {
  ExternalCredentialResolution,
  ExternalCredentialSource,
  ExternalCredentialRead,
} from "../../src/credentials/external-credential-source.js";

const PROVIDER_ID = "openai-codex";

const provider = Object.freeze({
  id: PROVIDER_ID,
  name: "Codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  models: Object.freeze([]),
  auth: Object.freeze({}),
}) as unknown as Provider;

function externalSource(options: {
  readonly read: () => ExternalCredentialRead;
  readonly resolve?: () => ExternalCredentialResolution;
  readonly onResolve?: () => void;
}): ExternalCredentialSource {
  return Object.freeze({
    authType: "oauth", authMethodLabel: "Codex (ChatGPT)", displayName: "Codex login",
    async read() {
      return options.read();
    },
    async resolve() {
      options.onResolve?.();
      return (
        options.resolve?.() ?? {
          state: "ok",
          canonicalPath: "auth.json",
          tokenRevision: "revision-1",
          identityKey: "acct-a",
          credential: {
            type: "oauth",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 3600_000,
          },
          refreshed: false,
        }
      );
    },
  });
}

function readOk(revision = "revision-1", accountId = "acct-a"): ExternalCredentialRead {
  return Object.freeze({
    state: "ok",
    canonicalPath: "auth.json",
    tokenRevision: revision,
    identityKey: accountId,
  });
}

function createAuthority(source: ExternalCredentialSource | undefined) {
  const recordStore = createInMemoryProviderCredentialRecordStore({
    createRevision: (() => {
      let counter = 0;
      return () => `revision-${++counter}`;
    })(),
  });
  const composition = createProviderCredentialProfiles({
    recordStore,
    providers: () => [provider],
    createId: (() => {
      let counter = 0;
      return () => `id-${++counter}`;
    })(),
    now: () => Date.now(),
    ...(source === undefined ? {} : { externalSources: { [PROVIDER_ID]: source } }),
  });
  return Object.freeze({ composition, recordStore });
}

describe("external Codex credential binding", () => {
  it("captures identity only and resolves the secret inside the binding", async () => {
    const source = externalSource({ read: () => readOk() });
    const { composition } = createAuthority(source);

    const capture = await composition.binding.capture(PROVIDER_ID);

    expect(capture.facts).toMatchObject({
      kind: "external",
      providerId: PROVIDER_ID,
      authType: "oauth",
      canonicalPath: "auth.json",
      identityKey: "acct-a",
      tokenRevision: "revision-1",
    });
    const credential = await composition.binding.runBound(capture, () =>
      composition.credentialStore.read(PROVIDER_ID),
    );
    expect(credential).toMatchObject({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
    });
    expect(JSON.stringify(capture.facts)).not.toContain("access-token");
  });

  it("never executes Pi's refresh callback for the Codex-owned document", async () => {
    let resolved = 0;
    const source = externalSource({
      read: () => readOk(),
      onResolve: () => {
        resolved += 1;
      },
    });
    const { composition } = createAuthority(source);
    const capture = await composition.binding.capture(PROVIDER_ID);
    let callbackRan = false;

    await expect(
      composition.binding.runBound(capture, () =>
        composition.credentialStore.modify(PROVIDER_ID, async () => {
          callbackRan = true;
          return {} as Credential;
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderAuthBindingError);
    expect(callbackRan).toBe(false);
    expect(resolved).toBe(0);
  });

  it("fails closed instead of falling back to ambient when the document is unavailable", async () => {
    const source = externalSource({
      read: () => ({
        state: "invalid",
        canonicalPath: "auth.json",
        reason: "Document is not valid JSON",
      }),
    });
    const { composition } = createAuthority(source);

    await expect(composition.binding.capture(PROVIDER_ID)).rejects.toMatchObject({
      outcome: "external_unavailable",
    });
  });

  it("rejects a request that resolved after the account changed", async () => {
    let accountId = "acct-a";
    const source = externalSource({
      read: () => readOk("revision-1", accountId),
      resolve: () => ({
        state: "ok",
        canonicalPath: "auth.json",
        tokenRevision: "revision-2",
        identityKey: accountId,
        credential: {
          type: "oauth",
            access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600_000,
        },
        refreshed: false,
      }),
    });
    const { composition } = createAuthority(source);
    const capture = await composition.binding.capture(PROVIDER_ID);
    accountId = "acct-b";

    await expect(
      composition.binding.runBound(capture, () =>
        composition.credentialStore.read(PROVIDER_ID),
      ),
    ).rejects.toMatchObject({ outcome: "stale_binding" });
  });

  it("keeps publication bound to the resolved revision", async () => {
    let revision = "revision-1";
    const source = externalSource({ read: () => readOk(revision) });
    const { composition } = createAuthority(source);
    const capture = await composition.binding.capture(PROVIDER_ID);
    await composition.binding.runBound(capture, () =>
      composition.credentialStore.read(PROVIDER_ID),
    );

    let firstPublished = false;
    await expect(
      composition.binding.publishIfCurrent(capture, () => {
        firstPublished = true;
      }),
    ).resolves.toBe(true);
    expect(firstPublished).toBe(true);

    revision = "revision-2";
    let latePublished = false;
    await expect(
      composition.binding.publishIfCurrent(capture, () => {
        latePublished = true;
      }),
    ).resolves.toBe(false);
    expect(latePublished).toBe(false);
  });

  it("presents a connected external source in the management projection", async () => {
    const source = externalSource({ read: () => readOk() });
    const { composition } = createAuthority(source);

    const projection = await composition.management.query([PROVIDER_ID]);

    expect(projection.providers[0]).toMatchObject({
      providerId: PROVIDER_ID,
      implementationAvailable: true,
      profiles: [],
      ambient: { kind: "external", status: "connected" },
    });
  });

  it("keeps the external presentation after the last Profile is removed", async () => {
    const source = externalSource({ read: () => readOk() });
    const { composition, recordStore } = createAuthority(source);
    await recordStore.modifyManagement(PROVIDER_ID, "absent", () => ({
      kind: "commit",
      record: {
        schemaVersion: 2,
        providerId: PROVIDER_ID,
        revision: "record-1",
        selectionGeneration: "selection-1",
        switchPolicy: { apiKeyOn429: false, oauthOn429: false },
        profiles: [],
      },
      value: undefined,
    }));

    const projection = await composition.management.query([PROVIDER_ID]);

    expect(projection.providers[0]).toMatchObject({
      providerId: PROVIDER_ID,
      profiles: [],
      ambient: { kind: "external", status: "connected" },
    });
  });

  it("reports structured external failure reasons without message matching", async () => {
    const cases: readonly {
      readonly resolution: ExternalCredentialResolution;
      readonly expected: string;
    }[] = [
      {
        resolution: {
          state: "unavailable",
          canonicalPath: "auth.json",
          reason: "refresh_unavailable",
          detail: "timeout",
        },
        expected: "timeout",
      },
      {
        resolution: {
          state: "unavailable",
          canonicalPath: "auth.json",
          reason: "verification_failed",
          detail: "insufficient_validity",
        },
        expected: "insufficient_validity",
      },
      {
        resolution: {
          state: "unavailable",
          canonicalPath: "auth.json",
          reason: "verification_failed",
          detail: "identity_changed",
        },
        expected: "identity_changed",
      },
    ];
    for (const testCase of cases) {
      const { composition } = createAuthority(
        externalSource({
          read: () => readOk(),
          resolve: () => testCase.resolution,
        }),
      );
      const capture = await composition.binding.capture(PROVIDER_ID);
      await expect(
        composition.binding.runBound(capture, () =>
          composition.credentialStore.read(PROVIDER_ID),
        ),
      ).rejects.toMatchObject({
        outcome: "external_unavailable",
        externalReason: testCase.expected,
      });
    }
  });

  it("keeps a managed Profile authoritative over the external source", async () => {
    const source = externalSource({ read: () => readOk() });
    const { composition, recordStore } = createAuthority(source);
    const credential: Credential = {
      type: "oauth",
      access: syntheticCodexAccess("managed-access"),
      refresh: "managed-refresh",
      expires: 1_900_000_000_000,
    };
    await recordStore.publishCredential(
      PROVIDER_ID,
      "absent",
      {
        credentialId: "managed-1",
        credentialGeneration: "generation-1",
        credential,
      },
      () => ({
        kind: "commit",
        record: {
          schemaVersion: 2,
          providerId: PROVIDER_ID,
          revision: "record-1",
          selectionGeneration: "selection-1",
          activeCredentialId: "managed-1",
          switchPolicy: { apiKeyOn429: false, oauthOn429: false },
          profiles: [
            {
              credentialId: "managed-1",
              credentialGeneration: "generation-1",
              authType: "oauth",
              authMethodLabel: "Codex (ChatGPT)",
              displayName: "Profile 1",
              enabled: true,
              priority: 0,
              createdAt: 1,
              updatedAt: 1,
              ...credentialProfileCarrier(
                PROVIDER_ID,
                "managed-1",
                "generation-1",
                credential,
              ),
            },
          ],
        },
        value: undefined,
      }),
    );

    const capture = await composition.binding.capture(PROVIDER_ID);

    expect(capture.facts.kind).toBe("managed");
  });
});
