import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFileCredentialStore } from "../../src/pi/file-credential-store.js";
import {
  createConfigValueResolver,
  type ConfigValueResolver,
} from "../../src/providers/config-value.js";
import {
  composeConfiguredAuth,
  createRequestCompositionModels,
} from "../../src/providers/request-composition.js";
import { createFixtureProvider } from "../support/credential-fixture.js";

/**
 * Ticket 12 request-path seam: a stored api_key credential whose value is a
 * literal, a `$ENV` reference or a `!command` source must resolve with the
 * pinned Pi semantics (mirroring AuthStorage.read) when the request path
 * reads it — through the same Ticket 10 config-value resolver, with
 * deterministic injected adapters and fake secrets only.
 */
describe("stored credential resolution in the request path", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function createFixture(options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly commandOutputs?: Readonly<Record<string, string>>;
  }) {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-stored-resolve-"),
    );
    directories.push(directory);
    const authPath = join(directory, "auth.json");
    const env: Record<string, string> = { ...(options.env ?? {}) };
    const commands: string[] = [];
    const configValues: ConfigValueResolver = createConfigValueResolver({
      envSource: (name) => env[name],
      commandRunner: (command) => {
        commands.push(command);
        return options.commandOutputs?.[command];
      },
    });
    const authContext = {
      env: async (name: string) => env[name],
      fileExists: async () => false,
    };
    // The exact LuckyToken request seam: the mutable catalog carries the
    // fixture Provider with the pinned auth composition applied (the same
    // overlay the production catalog applies to every built-in Provider),
    // and the composed Models adds the per-request model header layer.
    const fixtureProvider = createFixtureProvider({
      id: "fixture-provider",
      envVarName: "FIXTURE_API_KEY",
    });
    const mutableModels = createModels({
      credentials: createFileCredentialStore(authPath),
      authContext,
    });
    mutableModels.setProvider({
      ...fixtureProvider,
      auth: composeConfiguredAuth(
        "fixture-provider",
        fixtureProvider,
        undefined,
        { configValues },
      ),
    });
    const models = createRequestCompositionModels(mutableModels, undefined, {
      configValues,
    });
    return { models, authPath, commands, env };
  }

  it("resolves a stored literal, $ENV reference and !command key per request", async () => {
    const fixture = await createFixture({
      env: { FIXTURE_REF: "env-resolved-secret-11" },
      commandOutputs: { "print-secret": "command-resolved-secret-22" },
    });
    const store = createFileCredentialStore(fixture.authPath);

    // Literal stored raw, resolved to itself.
    await store.modify("fixture-provider", async () => ({
      type: "api_key",
      key: "sk-literal-33",
    }));
    await expect(fixture.models.getAuth("fixture-provider")).resolves.toEqual({
      auth: { apiKey: "sk-literal-33" },
      source: "stored credential",
    });

    // Environment reference stored raw, resolved from the env.
    await store.modify("fixture-provider", async () => ({
      type: "api_key",
      key: "$FIXTURE_REF",
    }));
    await expect(fixture.models.getAuth("fixture-provider")).resolves.toEqual({
      auth: { apiKey: "env-resolved-secret-11" },
      source: "stored credential",
    });

    // Command source stored raw, resolved through the injected runner.
    await store.modify("fixture-provider", async () => ({
      type: "api_key",
      key: "!print-secret",
    }));
    await expect(fixture.models.getAuth("fixture-provider")).resolves.toEqual({
      auth: { apiKey: "command-resolved-secret-22" },
      source: "stored credential",
    });
    expect(fixture.commands).toEqual(["print-secret"]);
  });

  it("falls back to ambient sources when a stored reference cannot resolve", async () => {
    const fixture = await createFixture({
      env: { FIXTURE_API_KEY: "ambient-fallback-44" },
    });
    const store = createFileCredentialStore(fixture.authPath);
    await store.modify("fixture-provider", async () => ({
      type: "api_key",
      key: "$MISSING_REF_55",
    }));
    // Pinned AuthStorage semantics: an unresolvable stored reference reads
    // as no key, so the ambient env source takes over.
    await expect(fixture.models.getAuth("fixture-provider")).resolves.toEqual({
      auth: { apiKey: "ambient-fallback-44" },
      source: "FIXTURE_API_KEY",
    });
  });

  it("a stored slot never falls through to the configured models.json key at request time", async () => {
    // Once a stored credential exists, the request path never consults the
    // models.json key: an unresolvable stored reference goes to the
    // ambient source or nowhere.
    const fixture = await createFixture({});
    const store = createFileCredentialStore(fixture.authPath);
    await store.modify("fixture-provider", async () => ({
      type: "api_key",
      key: "$MISSING_REF_55",
    }));
    await expect(
      fixture.models.getAuth("fixture-provider"),
    ).resolves.toBeUndefined();
  });

  it("has no fallback when a stored reference cannot resolve and nothing ambient exists", async () => {
    const fixture = await createFixture({});
    const store = createFileCredentialStore(fixture.authPath);
    await store.modify("fixture-provider", async () => ({
      type: "api_key",
      key: "$MISSING_REF_55",
    }));
    await expect(
      fixture.models.getAuth("fixture-provider"),
    ).resolves.toBeUndefined();
    await expect(
      fixture.models.checkAuth("fixture-provider"),
    ).resolves.toBeUndefined();
  });

  it("the store read itself stays raw; resolution happens at the request path", async () => {
    const fixture = await createFixture({
      env: { FIXTURE_REF: "env-resolved-secret-11" },
    });
    const store = createFileCredentialStore(fixture.authPath);
    await store.modify("fixture-provider", async () => ({
      type: "api_key",
      key: "$FIXTURE_REF",
    }));
    // The store never resolves: status/scrub consumers see the raw slot.
    await expect(store.read("fixture-provider")).resolves.toEqual({
      type: "api_key",
      key: "$FIXTURE_REF",
    });
  });

  it("the composed check classifies a stored reference without executing it", async () => {
    const fixture = await createFixture({
      env: { FIXTURE_REF: "env-resolved-secret-11" },
    });
    const store = createFileCredentialStore(fixture.authPath);
    await store.modify("fixture-provider", async () => ({
      type: "api_key",
      key: "$FIXTURE_REF",
    }));
    await expect(fixture.models.checkAuth("fixture-provider")).resolves.toEqual(
      { type: "api_key", source: "stored credential" },
    );
  });

  it("bare pi-ai Models pass a stored reference through without resolving it", async () => {
    // Resolution lives in the LuckyToken request composition (Ticket 10
    // resolver); pi-ai's bare Models + in-memory store have no resolver and
    // pass the raw slot through.
    const models = createModels({ credentials: new InMemoryCredentialStore() });
    models.setProvider(
      createFixtureProvider({
        id: "fixture-provider",
        envVarName: "FIXTURE_API_KEY",
      }),
    );
    await models.login("fixture-provider", "api_key", {
      prompt: async () => "$FIXTURE_REF",
      notify: () => {},
    });
    await expect(models.getAuth("fixture-provider")).resolves.toEqual({
      auth: { apiKey: "$FIXTURE_REF" },
      source: "stored credential",
    });
  });
});
