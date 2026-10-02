import { createModels, type Models, type Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import type {
  ExternalCredentialResolution,
  ExternalCredentialSource,
  ExternalCredentialRead,
} from "../../src/credentials/external-credential-source.js";
import { createBrowserOAuthProvider } from "../support/auth-login-fixture.js";

const PROVIDER_ID = "fixture-external-oauth";

function resolverFixture(options: {
  readonly resolution: ExternalCredentialResolution;
  readonly now: () => number;
}): {
  readonly models: Models;
  readonly model: NonNullable<ReturnType<Models["getModel"]>>;
  readonly capture: () => Promise<
    Awaited<ReturnType<ReturnType<typeof createProviderCredentialProfiles>["binding"]["capture"]>>
  >;
  readonly binding: ReturnType<typeof createProviderCredentialProfiles>["binding"];
  readonly refreshCalls: () => number;
} {
  let refreshCalls = 0;
  const base = createBrowserOAuthProvider({ id: PROVIDER_ID });
  const oauth = base.auth.oauth!;
  const provider: Provider = {
    ...base,
    auth: {
      ...base.auth,
      oauth: {
        ...oauth,
        refresh: (async (credential: Parameters<typeof oauth.refresh>[0]) => {
          refreshCalls += 1;
          return credential;
        }) as typeof oauth.refresh,
      },
    },
  };
  const source: ExternalCredentialSource = Object.freeze({
    authType: "oauth", authMethodLabel: "Fixture OAuth", displayName: "Fixture file",
    async read(): Promise<ExternalCredentialRead> {
      if (options.resolution.state !== "ok") {
        return Object.freeze({
          state: "invalid",
          canonicalPath: "auth.json",
          reason: options.resolution.reason,
        });
      }
      return Object.freeze({
        state: "ok",
        canonicalPath: options.resolution.canonicalPath,
        tokenRevision: options.resolution.tokenRevision,
        identityKey: options.resolution.identityKey,
      });
    },
    async resolve(): Promise<ExternalCredentialResolution> {
      return options.resolution;
    },
  });
  const composition = createProviderCredentialProfiles({
    recordStore: createInMemoryProviderCredentialRecordStore({
      createRevision: () => "revision",
    }),
    providers: () => [provider],
    createId: () => "id",
    now: options.now,
    externalSources: { [PROVIDER_ID]: source },
  });
  const models = createModels({ credentials: composition.credentialStore });
  models.setProvider(provider);
  const model = models.getModel(PROVIDER_ID, "fixture-model");
  if (model === undefined) throw new Error("fixture model was not registered");
  return {
    models,
    model,
    binding: composition.binding,
    refreshCalls: () => refreshCalls,
    capture: () => composition.binding.capture(PROVIDER_ID),
  };
}

function resolution(options: {
  readonly expiresAt: number;
  readonly accessToken?: string;
  readonly tokenRevision?: string;
}): ExternalCredentialResolution {
  return Object.freeze({
    state: "ok",
    canonicalPath: "auth.json",
    tokenRevision: options.tokenRevision ?? "revision-1",
    identityKey: "acct-a",
    credential: Object.freeze({
      type: "oauth",
      access: options.accessToken ?? "external-access",
      refresh: "external-refresh",
      expires: options.expiresAt,
    }),
    refreshed: false,
  });
}

describe("real Pi resolver over an explicitly injected external binding", () => {
  it("resolves a fresh external credential without invoking Pi OAuth refresh", async () => {
    const now = 1_800_000_000_000;
    const fixture = resolverFixture({
      resolution: resolution({ expiresAt: now + 3_600_000 }),
      now: () => now,
    });
    const capture = await fixture.capture();

    const auth = await fixture.binding.runBound(capture, () =>
      fixture.models.getAuth(fixture.model),
    );

    expect(auth).toMatchObject({ auth: { apiKey: "external-access" } });
    expect(fixture.refreshCalls()).toBe(0);
  });

  it("never hands Pi a credential inside its five-minute refresh window", async () => {
    const now = 1_800_000_000_000;
    // The boundary resolves a credential that already has sufficient
    // validity; Pi's own near-expiry trigger is never reached.
    const fixture = resolverFixture({
      resolution: resolution({ expiresAt: now + 6 * 60_000 }),
      now: () => now,
    });
    const capture = await fixture.capture();

    const auth = await fixture.binding.runBound(capture, () =>
      fixture.models.getAuth(fixture.model),
    );

    expect(auth?.auth.apiKey).toBe("external-access");
    expect(fixture.refreshCalls()).toBe(0);
  });

  it("fails explicitly instead of refreshing when the credential is unsatisfiable", async () => {
    const now = 1_800_000_000_000;
    const fixture = resolverFixture({
      resolution: Object.freeze({
        state: "unavailable",
        canonicalPath: "auth.json",
        reason: "refresh_unavailable",
        detail: "no_runtime",
      }),
      now: () => now,
    });

    await expect(fixture.binding.capture(PROVIDER_ID)).rejects.toMatchObject({
      outcome: "external_unavailable",
    });
    expect(fixture.refreshCalls()).toBe(0);
  });

  it("refuses Pi's refresh callback when time advances past the resolved validity", async () => {
    // Real clock: the boundary hands over a credential just above Pi's own
    // five-minute trigger, then time advances past it before Pi resolves.
    const startedAt = Date.now();
    const fixture = resolverFixture({
      resolution: resolution({ expiresAt: startedAt + 5 * 60_000 + 400 }),
      now: () => startedAt,
    });
    const capture = await fixture.capture();
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));

    await expect(
      fixture.binding.runBound(capture, () => fixture.models.getAuth(fixture.model)),
    ).rejects.toMatchObject({ code: "auth" });
    expect(fixture.refreshCalls()).toBe(0);
  });
});
