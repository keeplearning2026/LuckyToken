import { createModels } from "@earendil-works/pi-ai";
import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type AuthInteractionChannel,
} from "@token/application-control-plane/control-plane";
import { afterEach, describe, expect, it } from "vitest";

import { createCredentialProfilesControlPlaneHandlers } from "../../src/credentials/profile-control-plane.js";
import {
  createProviderCredentialProfiles,
  NO_PROVIDER_RECORD_REVISION,
} from "../../src/credentials/profile-authority.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { createFixtureProvider } from "../support/credential-fixture.js";

function interaction(answer: string): AuthInteractionChannel {
  const controller = new AbortController();
  return Object.freeze({
    signal: controller.signal,
    notify: async () => {},
    prompt: async () => answer,
  });
}

describe("Credential Profiles Control Plane", () => {
  const hosts: Array<Awaited<ReturnType<typeof startControlPlane>>> = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  it("adds two write-only Provider credentials and returns authoritative sanitized state", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "credential-b",
      "credential-generation-b",
    ];
    const revisions = ["revision-a", "revision-b", "revision-metadata"];
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      }),
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const postLoginCaptures: unknown[] = [];
    const handlers = createCredentialProfilesControlPlaneHandlers({
      models,
      management: profiles.management,
      binding: profiles.binding,
      providerSource: () => "pi_builtin",
      postLoginProvider: (_providerId, capture) => {
        postLoginCaptures.push(capture.facts);
      },
    });

    const initial = await handlers.auth({ command: "query" }, interaction("unused"));
    expect(initial).toMatchObject({
      outcome: "ok",
      state: {
        providers: [{
          providerId: provider.id,
          revision: NO_PROVIDER_RECORD_REVISION,
          ambient: { kind: "external", status: "unknown" },
          profiles: [],
        }],
      },
      options: {
        providers: [{
          providerId: provider.id,
          name: "Fixture Provider",
          source: "pi_builtin",
          authMethods: [{
            authType: "api_key",
            authMethodLabel: "Fixture API key",
            interactive: true,
          }],
        }],
      },
    });

    const first = await handlers.auth({
      command: "login",
      providerId: provider.id,
      authType: "api_key",
      displayName: "Production",
      note: "Primary release credential",
      useNow: false,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    }, interaction("control-plane-secret-alpha"));
    expect(first).toMatchObject({
      outcome: "ok",
      state: {
        providers: [{
          revision: "revision-a",
          activeCredentialId: "credential-a",
          profiles: [{
            credentialId: "credential-a",
            authMethodLabel: "Fixture API key",
            displayName: "Production",
            note: "Primary release credential",
            identityHint: "•••• lpha",
          }],
        }],
      },
    });
    expect(postLoginCaptures).toEqual([
      expect.objectContaining({
        kind: "managed",
        credentialId: "credential-a",
        credentialGeneration: "credential-generation-a",
        selectionGeneration: "selection-generation-a",
      }),
    ]);

    const second = await handlers.auth({
      command: "login",
      providerId: provider.id,
      authType: "api_key",
      displayName: "Backup",
      useNow: false,
      expectedRevision: "revision-a",
    }, interaction("control-plane-secret-beta"));
    expect(second).toMatchObject({
      outcome: "ok",
      state: {
        providers: [{
          revision: "revision-b",
          activeCredentialId: "credential-a",
          profiles: [
            expect.objectContaining({ credentialId: "credential-a" }),
            expect.objectContaining({ credentialId: "credential-b", displayName: "Backup" }),
          ],
        }],
      },
    });
    // An inactive addition must not replace the active account's Catalog.
    expect(postLoginCaptures).toHaveLength(1);

    const renamed = await handlers.credentials({
      command: "update_metadata",
      providerId: provider.id,
      credentialId: "credential-b",
      displayName: "Disaster recovery",
      note: "Use only during incidents",
      expectedRevision: "revision-b",
    });
    expect(renamed).toMatchObject({
      outcome: "ok",
      state: {
        providers: [{
          revision: "revision-metadata",
          profiles: [
            expect.objectContaining({ displayName: "Production" }),
            expect.objectContaining({
              displayName: "Disaster recovery",
              note: "Use only during incidents",
            }),
          ],
        }],
      },
    });
    const wire = JSON.stringify({ initial, first, second, renamed });
    expect(wire).not.toContain("control-plane-secret");
  });

  it("round-trips profile management and interactive login over the public pipe", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
    ];
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => "revision-a",
      }),
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    const handlers = createCredentialProfilesControlPlaneHandlers({
      models,
      management: profiles.management,
      binding: profiles.binding,
      providerSource: () => "pi_builtin",
    });
    const endpoint = {
      address: `\\\\.\\pipe\\Token-profile-${process.pid}-${Date.now()}`,
      capability: "profile-test-capability-0123456789",
    } as const;
    const host = await startControlPlane({
      endpoint,
      application: { id: "Token", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      credentialProfilesCommandHandler: handlers.credentials,
      providerProfileAuthCommandHandler: handlers.auth,
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    let nextRequest = 0;
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `profile-request-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(4);

    const before = await client.executeCredentialProfilesCommand({
      command: "query",
    });
    expect(before.state.providers[0]).toMatchObject({
      providerId: provider.id,
      profiles: [],
    });

    const events: string[] = [];
    const login = await client.executeProviderProfileAuthCommand({
      command: "login",
      providerId: provider.id,
      authType: "api_key",
      displayName: "Production",
      useNow: true,
      expectedRevision: NO_PROVIDER_RECORD_REVISION,
    }, (event) => {
      events.push(event.type);
      if (event.type === "prompt") {
        void client.respondAuthInteraction({
          type: "prompt_response",
          promptId: event.promptId,
          value: "pipe-secret-alpha",
        });
      }
    });
    expect(login).toMatchObject({
      outcome: "ok",
      state: {
        providers: [{
          activeCredentialId: "credential-a",
          profiles: [{ displayName: "Production", identityHint: "•••• lpha" }],
        }],
      },
    });
    expect(events).toEqual(["prompt"]);
    expect(JSON.stringify(login)).not.toContain("pipe-secret-alpha");

    await client.close();
  });

  it("rechecks only the exact active Profile without login or selection mutation", async () => {
    const generatedIds = [
      "credential-a",
      "credential-generation-a",
      "selection-generation-a",
      "credential-b",
      "credential-generation-b",
    ];
    const revisions = ["revision-a", "revision-b"];
    const provider = createFixtureProvider();
    const profiles = createProviderCredentialProfiles({
      recordStore: createInMemoryProviderCredentialRecordStore({
        createRevision: () => revisions.shift() ?? "unexpected-revision",
      }),
      providers: () => [provider],
      createId: () => generatedIds.shift() ?? "unexpected-id",
      now: () => 1_786_400_000_000,
    });
    const models = createModels({ credentials: profiles.credentialStore });
    models.setProvider(provider);
    let loginPrompts = 0;
    for (const [displayName, secret, expectedRevision] of [
      ["Primary", "profile-secret-primary", NO_PROVIDER_RECORD_REVISION],
      ["Backup", "profile-secret-backup", "revision-a"],
    ] as const) {
      const binding = await profiles.binding.createLoginBinding({
        providerId: provider.id,
        authType: "api_key",
        displayName,
        useNow: false,
        expectedRevision,
      });
      await profiles.binding.runBound(binding, () =>
        models.login(provider.id, "api_key", {
          prompt: async () => {
            loginPrompts += 1;
            return secret;
          },
          notify: () => {},
        }),
      );
    }
    const rechecked: string[] = [];
    let recheckOutcome: "succeeded" | "failed" = "failed";
    const handlers = createCredentialProfilesControlPlaneHandlers({
      models,
      management: profiles.management,
      binding: profiles.binding,
      recheckProvider: async (providerId, capture) => {
        rechecked.push(providerId);
        expect(capture.facts).toMatchObject({
          kind: "managed",
          credentialId: "credential-a",
          credentialGeneration: "credential-generation-a",
          selectionGeneration: "selection-generation-a",
        });
        await profiles.binding.runBound(capture, () => models.checkAuth(providerId));
        return recheckOutcome;
      },
    });

    const inactive = await handlers.credentials({
      command: "recheck",
      providerId: provider.id,
      credentialId: "credential-b",
      expectedRevision: "revision-b",
    });
    expect(inactive.outcome).toBe("invalid");
    expect(rechecked).toEqual([]);

    const failed = await handlers.credentials({
      command: "recheck",
      providerId: provider.id,
      credentialId: "credential-a",
      expectedRevision: "revision-b",
    });
    expect(failed).toMatchObject({
      outcome: "unavailable",
      error: "Provider credential recheck did not complete",
    });
    recheckOutcome = "succeeded";
    const active = await handlers.credentials({
      command: "recheck",
      providerId: provider.id,
      credentialId: "credential-a",
      expectedRevision: "revision-b",
    });
    expect(active).toMatchObject({
      outcome: "ok",
      state: {
        providers: [
          {
            revision: "revision-b",
            selectionGeneration: "selection-generation-a",
            activeCredentialId: "credential-a",
          },
        ],
      },
    });
    expect(rechecked).toEqual([provider.id, provider.id]);
    expect(loginPrompts).toBe(2);
  });
});
