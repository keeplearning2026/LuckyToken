import {
  createConfigValueResolver,
  type ConfigValueResolver,
} from "../../src/providers/config-value.js";
import { createFileCredentialStore } from "../../src/pi/file-credential-store.js";
import {
  createLiveCredentialAuthority,
  type LiveCredentialAuthority,
} from "../../src/credentials/authority.js";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsJsonProvider } from "../../src/providers/models-json-schema.js";
import {
  createFixtureAuthContext,
  createFixtureProvider,
} from "../support/credential-fixture.js";

/**
 * Ticket 12 unit seam: the single serialized Credential Authority. Every
 * case drives the real authority over a real auth.json in a temp directory
 * with fake independent secrets and deterministic env/command adapters —
 * never real credentials, never network, never the repository auth.json.
 */
describe("LiveCredentialAuthority", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  interface Fixture {
    readonly directory: string;
    readonly path: string;
    readonly authority: LiveCredentialAuthority;
    readonly second: () => Promise<LiveCredentialAuthority>;
    readonly env: Record<string, string>;
    readonly commands: string[];
    readonly modelsJson: Record<string, ModelsJsonProvider>;
  }

  async function createFixture(
    options: {
      readonly providers?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly now?: number;
    } = {},
  ): Promise<Fixture> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-cred-auth-"));
    directories.push(directory);
    const path = join(directory, "auth.json");
    const env: Record<string, string> = { ...(options.env ?? {}) };
    const commands: string[] = [];
    const modelsJson: Record<string, ModelsJsonProvider> = {};
    const configValues: ConfigValueResolver = createConfigValueResolver({
      envSource: (name) => env[name],
      commandRunner: (command) => {
        commands.push(command);
        return undefined;
      },
    });
    const authContext = createFixtureAuthContext(env);
    const providerIds = options.providers ?? ["fixture-provider"];
    const providers = providerIds.map((id) =>
      createFixtureProvider({
        id,
        envVarName: `${id.toUpperCase().replaceAll("-", "_")}_API_KEY`,
      }),
    );
    const makeAuthority = async (): Promise<LiveCredentialAuthority> =>
      createLiveCredentialAuthority({
        store: createFileCredentialStore(path),
        path,
        configValues,
        authContext,
        providers: () => providers,
        modelsJsonProviders: () => modelsJson,
        ...(options.now === undefined
          ? {}
          : { now: () => options.now as number }),
      });
    const authority = await makeAuthority();
    return {
      directory,
      path,
      authority,
      second: makeAuthority,
      env,
      commands,
      modelsJson,
    };
  }

  /** Stored value through the public Pi store contract (raw, unresolved). */
  async function storedValue(
    fixture: Fixture,
    providerId: string,
  ): Promise<string | undefined> {
    const credential = await createFileCredentialStore(fixture.path).read(
      providerId,
    );
    return credential?.type === "api_key" ? credential.key : undefined;
  }

  function statusRow(fixture: Fixture, providerId: string) {
    const state = fixture.authority.snapshot();
    const row = state.providers.find(
      (entry) => entry.providerId === providerId,
    );
    if (row === undefined) throw new Error(`no status row for ${providerId}`);
    return row;
  }

  it("logs in a literal secret and reports stored status with file facts", async () => {
    const fixture = await createFixture();
    const login = await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-literal-secret-1",
      overwrite: true,
    });
    expect(login.outcome).toBe("ok");
    expect(login.changed).toBe(true);
    expect(login.revision).toBe(1);
    expect(login.state).toMatchObject({
      revision: 1,
      present: true,
      valid: true,
      path: fixture.path,
    });
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "sk-literal-secret-1",
    );
    const row = statusRow(fixture, "fixture-provider");
    expect(row).toMatchObject({
      providerId: "fixture-provider",
      stored: true,
      storedType: "api_key",
      environment: false,
      modelsJson: false,
      commandDerived: false,
      expired: false,
      unavailable: false,
      effectiveSource: "stored",
    });
  });

  it("stores an environment reference and a !command source raw", async () => {
    const fixture = await createFixture({
      env: { FIXTURE_SECRET_REF: "resolved-ref-value-1" },
    });
    await expect(
      fixture.authority.login({
        providerId: "fixture-provider",
        expectedRevision: 0,
        value: "$FIXTURE_SECRET_REF",
        overwrite: true,
      }),
    ).resolves.toMatchObject({ outcome: "ok", revision: 1 });
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "$FIXTURE_SECRET_REF",
    );
    // The stored reference resolves from the environment, so the stored
    // credential is the effective source.
    const row = statusRow(fixture, "fixture-provider");
    expect(row).toMatchObject({ stored: true, effectiveSource: "stored" });
    await expect(
      fixture.authority.login({
        providerId: "fixture-provider",
        expectedRevision: 1,
        value: "!fixture-command-source",
        overwrite: true,
      }),
    ).resolves.toMatchObject({ outcome: "ok", revision: 2 });
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "!fixture-command-source",
    );
    // A stored !command source is classified without executing it: the
    // stored credential owns the slot.
    const commandRow = statusRow(fixture, "fixture-provider");
    expect(commandRow).toMatchObject({
      stored: true,
      effectiveSource: "stored",
    });
    expect(JSON.stringify(fixture.authority.snapshot())).not.toContain(
      "fixture-command-source",
    );
    expect(fixture.commands).toEqual([]);
  });

  it("falls through to the ambient environment when a stored env reference cannot resolve", async () => {
    const fixture = await createFixture({
      env: { FIXTURE_PROVIDER_API_KEY: "ambient-fallback-key-1" },
    });
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "$MISSING_REF_99",
      overwrite: true,
    });
    const row = statusRow(fixture, "fixture-provider");
    expect(row).toMatchObject({
      stored: true,
      storedType: "api_key",
      environment: true,
      modelsJson: false,
      unavailable: false,
      effectiveSource: "environment",
    });
  });

  it("reports unavailable when a stored env reference cannot resolve and nothing ambient exists", async () => {
    const fixture = await createFixture();
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "$MISSING_REF_99",
      overwrite: true,
    });
    const row = statusRow(fixture, "fixture-provider");
    expect(row).toMatchObject({
      stored: true,
      storedType: "api_key",
      environment: false,
      unavailable: true,
      effectiveSource: "none",
    });
  });

  it("a stored slot never falls through to the configured models.json key", async () => {
    // Request-time precedence (pinned): once a stored credential exists,
    // models.json is not consulted — an unresolvable stored reference goes
    // to the ambient source or nowhere.
    const fixture = await createFixture({
      env: { FIXTURE_PROVIDER_API_KEY: "ambient-fallback-key-2" },
    });
    fixture.modelsJson["fixture-provider"] = { apiKey: "configured-key-3" };
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "$MISSING_REF_99",
      overwrite: true,
    });
    const row = statusRow(fixture, "fixture-provider");
    expect(row).toMatchObject({
      stored: true,
      modelsJson: true,
      environment: true,
      effectiveSource: "environment",
    });
  });

  it("requires confirmation before replacing an occupied slot atomically", async () => {
    const fixture = await createFixture();
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-first-secret",
      overwrite: true,
    });
    const refused = await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 1,
      value: "sk-second-secret",
      overwrite: false,
    });
    expect(refused.outcome).toBe("overwrite_required");
    expect(refused.revision).toBe(1);
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "sk-first-secret",
    );
    const confirmed = await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 1,
      value: "sk-second-secret",
      overwrite: true,
    });
    expect(confirmed.outcome).toBe("ok");
    expect(confirmed.revision).toBe(2);
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "sk-second-secret",
    );
    // Exactly one stored slot remains for the Provider.
    const list = await createFileCredentialStore(fixture.path).list();
    expect(list).toEqual([{ providerId: "fixture-provider", type: "api_key" }]);
  });

  it("never lets concurrent UI/CLI logins lose an update", async () => {
    const fixture = await createFixture();
    const second = await fixture.second();
    await fixture.authority.query();
    await second.query();
    const first = await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-winner-1",
      overwrite: true,
    });
    expect(first.outcome).toBe("ok");
    const stale = await second.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-loser-1",
      overwrite: true,
    });
    expect(stale.outcome).toBe("conflict");
    expect(stale.revision).toBe(1);
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "sk-winner-1",
    );
    // The second authority re-queries and succeeds on the new revision.
    await second.query();
    const retried = await second.login({
      providerId: "fixture-provider",
      expectedRevision: 1,
      value: "sk-winner-2",
      overwrite: true,
    });
    expect(retried.outcome).toBe("ok");
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "sk-winner-2",
    );
  });

  it("detects an external file edit as a new revision and refuses stale mutations", async () => {
    const fixture = await createFixture();
    await fixture.authority.query();
    await writeFile(
      fixture.path,
      JSON.stringify({
        "fixture-provider": { type: "api_key", key: "sk-external" },
      }),
      "utf8",
    );
    const login = await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-stale",
      overwrite: true,
    });
    expect(login.outcome).toBe("conflict");
    expect(login.revision).toBe(1);
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "sk-external",
    );
  });

  it("logout removes only the stored auth.json value and reports the change", async () => {
    const fixture = await createFixture({
      providers: ["provider-a", "provider-b"],
      env: { PROVIDER_A_API_KEY: "ambient-key-a" },
    });
    fixture.modelsJson["provider-b"] = { apiKey: "configured-key-b" };
    await fixture.authority.login({
      providerId: "provider-a",
      expectedRevision: 0,
      value: "sk-a",
      overwrite: true,
    });
    await fixture.authority.login({
      providerId: "provider-b",
      expectedRevision: 1,
      value: "sk-b",
      overwrite: true,
    });
    const removed = await fixture.authority.logout({
      providerId: "provider-a",
      expectedRevision: 2,
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.changed).toBe(true);
    expect(removed.revision).toBe(3);
    await expect(
      createFileCredentialStore(fixture.path).read("provider-a"),
    ).resolves.toBeUndefined();
    // Provider B's stored slot is untouched.
    await expect(storedValue(fixture, "provider-b")).resolves.toBe("sk-b");
    // Effective sources remain and the status says so accurately: A falls
    // back to its ambient environment variable, B to its models.json key.
    const rowA = statusRow(fixture, "provider-a");
    expect(rowA).toMatchObject({
      stored: false,
      environment: true,
      effectiveSource: "environment",
      unavailable: false,
    });
    const rowB = statusRow(fixture, "provider-b");
    expect(rowB).toMatchObject({
      stored: true,
      modelsJson: true,
      effectiveSource: "stored",
    });
  });

  it("logout of an empty slot is a no-change success", async () => {
    const fixture = await createFixture();
    const removed = await fixture.authority.logout({
      providerId: "fixture-provider",
      expectedRevision: 0,
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.changed).toBe(false);
    expect(removed.revision).toBe(0);
  });

  it("a logout racing a concurrent login conflicts instead of resurrecting", async () => {
    const fixture = await createFixture();
    const second = await fixture.second();
    await fixture.authority.query();
    await second.query();
    await expect(
      second.login({
        providerId: "fixture-provider",
        expectedRevision: 0,
        value: "sk-live",
        overwrite: true,
      }),
    ).resolves.toMatchObject({ outcome: "ok" });
    const staleLogout = await fixture.authority.logout({
      providerId: "fixture-provider",
      expectedRevision: 0,
    });
    expect(staleLogout.outcome).toBe("conflict");
    await expect(storedValue(fixture, "fixture-provider")).resolves.toBe(
      "sk-live",
    );
  });

  it("reports the full status fact matrix without leaking values", async () => {
    const fixture = await createFixture({
      providers: ["provider-a", "provider-b", "provider-c", "provider-d"],
      env: { PROVIDER_A_API_KEY: "ambient-value-1" },
    });
    fixture.modelsJson["provider-b"] = { apiKey: "$MISSING_VAR_99" };
    fixture.modelsJson["provider-c"] = { apiKey: "!status-never-runs-this" };
    fixture.modelsJson["provider-d"] = { apiKey: "configured-literal" };

    await fixture.authority.query();
    const serialized = JSON.stringify(fixture.authority.snapshot());
    expect(serialized).not.toContain("ambient-value-1");
    expect(serialized).not.toContain("PROVIDER_A_API_KEY");
    expect(serialized).not.toContain("MISSING_VAR_99");
    expect(serialized).not.toContain("status-never-runs-this");
    expect(serialized).not.toContain("configured-literal");

    const rowA = statusRow(fixture, "provider-a");
    expect(rowA).toMatchObject({
      stored: false,
      environment: true,
      modelsJson: false,
      unavailable: false,
      effectiveSource: "environment",
    });
    // An env reference whose variable is missing is configured but not
    // effective: requests would fail, so the status says unavailable.
    const rowB = statusRow(fixture, "provider-b");
    expect(rowB).toMatchObject({
      modelsJson: true,
      environment: false,
      unavailable: true,
      effectiveSource: "none",
    });
    const rowC = statusRow(fixture, "provider-c");
    expect(rowC).toMatchObject({
      modelsJson: true,
      commandDerived: true,
      unavailable: false,
      effectiveSource: "command",
    });
    const rowD = statusRow(fixture, "provider-d");
    expect(rowD).toMatchObject({
      modelsJson: true,
      commandDerived: false,
      effectiveSource: "models.json",
    });
    // No status evaluation ever executes a configured command.
    expect(fixture.commands).toEqual([]);
  });

  it("reports stored, models.json and ambient facts with stored precedence", async () => {
    const fixture = await createFixture({
      env: { FIXTURE_PROVIDER_API_KEY: "ambient-1" },
    });
    fixture.modelsJson["fixture-provider"] = {
      apiKey: "$FIXTURE_PROVIDER_API_KEY",
    };
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-stored-1",
      overwrite: true,
    });
    const row = statusRow(fixture, "fixture-provider");
    expect(row).toMatchObject({
      stored: true,
      storedType: "api_key",
      environment: false,
      modelsJson: true,
      effectiveSource: "stored",
    });
  });

  it("reports an expired stored OAuth credential without exposing it", async () => {
    const fixture = await createFixture({ now: 1_700_000_000_000 });
    const store = createFileCredentialStore(fixture.path);
    await store.casWrite("fixture-provider", undefined, {
      type: "oauth",
      access: "oauth-access-canary-1",
      refresh: "oauth-refresh-canary-1",
      expires: 1_600_000_000_000,
    });
    await fixture.authority.query();
    const row = statusRow(fixture, "fixture-provider");
    expect(row).toMatchObject({
      stored: true,
      storedType: "oauth",
      expired: true,
      effectiveSource: "stored",
    });
    const serialized = JSON.stringify(fixture.authority.snapshot());
    expect(serialized).not.toContain("oauth-access-canary-1");
    expect(serialized).not.toContain("oauth-refresh-canary-1");
  });

  it("reports unavailable when nothing resolves", async () => {
    const fixture = await createFixture();
    await fixture.authority.query();
    const row = statusRow(fixture, "fixture-provider");
    expect(row).toMatchObject({
      stored: false,
      environment: false,
      modelsJson: false,
      unavailable: true,
      effectiveSource: "none",
    });
  });

  it("rejects an empty login value", async () => {
    const fixture = await createFixture();
    for (const value of ["", "   "]) {
      const login = await fixture.authority.login({
        providerId: "fixture-provider",
        expectedRevision: 0,
        value,
        overwrite: true,
      });
      expect(login.outcome).toBe("invalid");
      expect(login.error).toBeDefined();
    }
    await expect(
      createFileCredentialStore(fixture.path).list(),
    ).resolves.toEqual([]);
  });

  it("rejects login for an unknown Provider", async () => {
    const fixture = await createFixture();
    const login = await fixture.authority.login({
      providerId: "no-such-provider",
      expectedRevision: 0,
      value: "sk-ghost",
      overwrite: true,
    });
    expect(login.outcome).toBe("unknown_provider");
    await expect(
      createFileCredentialStore(fixture.path).list(),
    ).resolves.toEqual([]);
  });

  describe("import", () => {
    const importContent = (entries: Record<string, unknown>): string =>
      JSON.stringify(entries);

    it("previews a valid import and flags every overwrite", async () => {
      const fixture = await createFixture({ providers: ["provider-a"] });
      await fixture.authority.login({
        providerId: "provider-a",
        expectedRevision: 0,
        value: "sk-existing-a",
        overwrite: true,
      });
      const preview = await fixture.authority.importPreview({
        expectedRevision: 1,
        content: importContent({
          "provider-a": { type: "api_key", key: "sk-imported-a" },
          "provider-b": { type: "api_key", key: "sk-imported-b" },
        }),
      });
      expect(preview.outcome).toBe("ok");
      expect(preview.importId).toBeDefined();
      expect(preview.previewEntries).toEqual([
        { providerId: "provider-a", type: "api_key", wouldOverwrite: true },
        { providerId: "provider-b", type: "api_key", wouldOverwrite: false },
      ]);
    });

    it("rejects malformed import content with a value-free error", async () => {
      const fixture = await createFixture();
      const broken = await fixture.authority.importPreview({
        expectedRevision: 0,
        content: "{ not json",
      });
      expect(broken.outcome).toBe("invalid");
      expect(broken.error).toBeDefined();
      expect(broken.error).not.toContain("not json");
      const badShape = await fixture.authority.importPreview({
        expectedRevision: 0,
        content: importContent({
          "provider-a": { type: "api_key", key: 42 },
        }),
      });
      expect(badShape.outcome).toBe("invalid");
      expect(badShape.error).toContain("provider-a");
      expect(badShape.error).not.toContain("42");
      // Nothing was written.
      await expect(
        createFileCredentialStore(fixture.path).list(),
      ).resolves.toEqual([]);
    });

    it("applies selected providers and preserves unselected existing credentials", async () => {
      const fixture = await createFixture();
      // Seed an existing credential that the import must not touch.
      const store = createFileCredentialStore(fixture.path);
      await store.casWrite("provider-c", undefined, {
        type: "api_key",
        key: "sk-existing-c",
      });
      await fixture.authority.query();
      const preview = await fixture.authority.importPreview({
        expectedRevision: 1,
        content: importContent({
          "provider-a": { type: "api_key", key: "sk-imported-a" },
          "provider-b": { type: "api_key", key: "sk-imported-b" },
          "provider-c": { type: "api_key", key: "sk-imported-c" },
        }),
      });
      expect(preview.outcome).toBe("ok");
      const applied = await fixture.authority.importApply({
        expectedRevision: 1,
        importId: preview.importId as string,
        selections: [
          { providerId: "provider-a", overwrite: false },
          { providerId: "provider-b", overwrite: false },
          // provider-c is NOT selected: its stored credential must survive.
        ],
      });
      expect(applied.outcome).toBe("ok");
      expect(applied.entries).toEqual([
        { providerId: "provider-a", outcome: "applied" },
        { providerId: "provider-b", outcome: "applied" },
      ]);
      await expect(storedValue(fixture, "provider-a")).resolves.toBe(
        "sk-imported-a",
      );
      await expect(storedValue(fixture, "provider-b")).resolves.toBe(
        "sk-imported-b",
      );
      await expect(storedValue(fixture, "provider-c")).resolves.toBe(
        "sk-existing-c",
      );
    });

    it("asks before each overwrite and skips a declined overwrite", async () => {
      const fixture = await createFixture({ providers: ["provider-a"] });
      await fixture.authority.login({
        providerId: "provider-a",
        expectedRevision: 0,
        value: "sk-existing-a",
        overwrite: true,
      });
      const preview = await fixture.authority.importPreview({
        expectedRevision: 1,
        content: importContent({
          "provider-a": { type: "api_key", key: "sk-imported-a" },
        }),
      });
      expect(preview.previewEntries?.[0]).toMatchObject({
        providerId: "provider-a",
        wouldOverwrite: true,
      });
      // The user declines the overwrite: the entry is skipped/preserved,
      // the import still completes, and the existing credential survives.
      const declined = await fixture.authority.importApply({
        expectedRevision: 1,
        importId: preview.importId as string,
        selections: [{ providerId: "provider-a", overwrite: false }],
      });
      expect(declined.outcome).toBe("ok");
      expect(declined.entries).toEqual([
        { providerId: "provider-a", outcome: "skipped" },
      ]);
      await expect(storedValue(fixture, "provider-a")).resolves.toBe(
        "sk-existing-a",
      );
    });

    it("a declined overwrite does not block confirmed entries", async () => {
      const fixture = await createFixture({ providers: ["provider-a"] });
      await fixture.authority.login({
        providerId: "provider-a",
        expectedRevision: 0,
        value: "sk-existing-a",
        overwrite: true,
      });
      const preview = await fixture.authority.importPreview({
        expectedRevision: 1,
        content: importContent({
          "provider-a": { type: "api_key", key: "sk-imported-a" },
          "provider-b": { type: "api_key", key: "sk-imported-b" },
        }),
      });
      const applied = await fixture.authority.importApply({
        expectedRevision: 1,
        importId: preview.importId as string,
        selections: [
          { providerId: "provider-a", overwrite: false },
          { providerId: "provider-b", overwrite: false },
        ],
      });
      expect(applied.outcome).toBe("ok");
      expect(applied.entries).toEqual([
        { providerId: "provider-a", outcome: "skipped" },
        { providerId: "provider-b", outcome: "applied" },
      ]);
      await expect(storedValue(fixture, "provider-a")).resolves.toBe(
        "sk-existing-a",
      );
      await expect(storedValue(fixture, "provider-b")).resolves.toBe(
        "sk-imported-b",
      );
    });

    it("previews and applies an empty Pi-compatible auth.json", async () => {
      const fixture = await createFixture();
      const preview = await fixture.authority.importPreview({
        expectedRevision: 0,
        content: importContent({}),
      });
      expect(preview.outcome).toBe("ok");
      expect(preview.importId).toBeDefined();
      expect(preview.previewEntries).toEqual([]);
      const applied = await fixture.authority.importApply({
        expectedRevision: 0,
        importId: preview.importId as string,
        selections: [],
      });
      expect(applied.outcome).toBe("ok");
      expect(applied.entries).toEqual([]);
    });

    it("a concurrent mutation between preview and apply conflicts per entry", async () => {
      const fixture = await createFixture({
        providers: ["provider-a", "provider-b"],
      });
      const second = await fixture.second();
      await fixture.authority.query();
      await second.query();
      const preview = await fixture.authority.importPreview({
        expectedRevision: 0,
        content: importContent({
          "provider-a": { type: "api_key", key: "sk-imported-a" },
          "provider-b": { type: "api_key", key: "sk-imported-b" },
        }),
      });
      expect(preview.outcome).toBe("ok");
      // The UI logs in to provider-b while the import confirmation is open.
      await second.login({
        providerId: "provider-b",
        expectedRevision: 0,
        value: "sk-ui-b",
        overwrite: true,
      });
      const applied = await fixture.authority.importApply({
        expectedRevision: 0,
        importId: preview.importId as string,
        selections: [
          { providerId: "provider-a", overwrite: false },
          { providerId: "provider-b", overwrite: false },
        ],
      });
      expect(applied.entries).toEqual([
        { providerId: "provider-a", outcome: "applied" },
        { providerId: "provider-b", outcome: "conflict" },
      ]);
      // The UI's fresh login is never overwritten by the import.
      await expect(storedValue(fixture, "provider-b")).resolves.toBe("sk-ui-b");
      await expect(storedValue(fixture, "provider-a")).resolves.toBe(
        "sk-imported-a",
      );
    });

    it("fails explicitly for an unknown or stale import session", async () => {
      const fixture = await createFixture();
      const unknown = await fixture.authority.importApply({
        expectedRevision: 0,
        importId: "no-such-import",
        selections: [],
      });
      expect(unknown.outcome).toBe("conflict");
      expect(unknown.error).toBeDefined();
      const preview = await fixture.authority.importPreview({
        expectedRevision: 0,
        content: importContent({
          "provider-a": { type: "api_key", key: "sk-a" },
        }),
      });
      const stale = await fixture.authority.importApply({
        expectedRevision: 1,
        importId: preview.importId as string,
        selections: [{ providerId: "provider-a", overwrite: false }],
      });
      expect(stale.outcome).toBe("conflict");
    });

    it("import selections must reference providers present in the file", async () => {
      const fixture = await createFixture();
      const preview = await fixture.authority.importPreview({
        expectedRevision: 0,
        content: importContent({
          "provider-a": { type: "api_key", key: "sk-a" },
        }),
      });
      const invalid = await fixture.authority.importApply({
        expectedRevision: 0,
        importId: preview.importId as string,
        selections: [{ providerId: "provider-ghost", overwrite: false }],
      });
      expect(invalid.outcome).toBe("invalid");
    });
  });

  it("reports malformed auth.json as invalid and preserves the bytes", async () => {
    const fixture = await createFixture();
    const garbage = "{ this is not json";
    await writeFile(fixture.path, garbage, "utf8");
    const queried = await fixture.authority.query();
    expect(queried.outcome).toBe("ok");
    expect(queried.state).toMatchObject({ present: true, valid: false });
    expect(queried.state.error?.kind).toBe("parse");
    expect(queried.state.error?.message).not.toContain("this is not json");
    // Mutations fail explicitly and never touch the malformed bytes.
    const login = await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: queried.revision,
      value: "sk-must-not-write",
      overwrite: true,
    });
    expect(login.outcome).toBe("conflict");
    expect(login.error).toBeDefined();
    await expect(readFile(fixture.path, "utf8")).resolves.toBe(garbage);
    // A wrong-typed entry in auth.json is reported as an invalid shape.
    await writeFile(
      fixture.path,
      JSON.stringify({ "fixture-provider": { type: "api_key", key: 42 } }),
      "utf8",
    );
    const shape = await fixture.authority.query();
    expect(shape.state.valid).toBe(false);
    expect(shape.state.error?.kind).toBe("invalid");
  });

  it("keeps the last-good scrub coverage when auth.json becomes malformed", async () => {
    const fixture = await createFixture();
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-last-good-canary-77",
      overwrite: true,
    });
    expect(fixture.authority.scrub("sk-last-good-canary-77")).toBe(
      "[REDACTED]",
    );
    await writeFile(fixture.path, "{ this is not json", "utf8");
    const queried = await fixture.authority.query();
    expect(queried.state.valid).toBe(false);
    // The parse error is reported, but the last-good known-value scrub
    // capability still protects diagnostics from the stored secret.
    expect(fixture.authority.scrub("sk-last-good-canary-77")).toBe(
      "[REDACTED]",
    );
    // The last-good secret never appears in the projection.
    const serialized = JSON.stringify(fixture.authority.snapshot());
    expect(serialized).not.toContain("sk-last-good-canary-77");
    expect(serialized).toContain('"valid":false');
  });

  it("scrubs raw stored values and env-resolved values without executing commands", async () => {
    const fixture = await createFixture({
      env: { FIXTURE_ENV_CANARY: "env-resolved-canary-1" },
    });
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-raw-canary-1",
      overwrite: true,
    });
    expect(fixture.authority.scrub("sk-raw-canary-1")).toBe("[REDACTED]");
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 1,
      value: "$FIXTURE_ENV_CANARY",
      overwrite: true,
    });
    expect(fixture.authority.scrub("env-resolved-canary-1")).toBe("[REDACTED]");
    expect(fixture.authority.scrub("sk-raw-canary-1")).toBe("sk-raw-canary-1");
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 2,
      value: "!command-canary-1",
      overwrite: true,
    });
    // The command source itself is stored raw and scrubbed; its (unknown)
    // output is not known and the command was never executed.
    expect(fixture.authority.scrub("!command-canary-1")).toBe("[REDACTED]");
    expect(fixture.authority.scrub("command output canary")).toBe(
      "command output canary",
    );
    expect(fixture.commands).toEqual([]);
  });

  it("creates auth.json with restrictive permissions", async () => {
    if (process.platform === "win32") return; // Windows mode bits are advisory
    const fixture = await createFixture();
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-perm",
      overwrite: true,
    });
    const file = await stat(fixture.path);
    expect(file.mode & 0o777).toBe(0o600);
    const directory = await stat(fixture.directory);
    expect(directory.mode & 0o777).toBe(0o700);
  });

  it("never leaks credential values through any result surface", async () => {
    const fixture = await createFixture();
    await fixture.authority.login({
      providerId: "fixture-provider",
      expectedRevision: 0,
      value: "sk-super-secret-canary-42",
      overwrite: true,
    });
    const results = [
      await fixture.authority.query(),
      await fixture.authority.login({
        providerId: "fixture-provider",
        expectedRevision: 1,
        value: "sk-super-secret-canary-43",
        overwrite: true,
      }),
      await fixture.authority.logout({
        providerId: "fixture-provider",
        expectedRevision: 2,
      }),
    ];
    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("sk-super-secret-canary-42");
      expect(serialized).not.toContain("sk-super-secret-canary-43");
    }
  });
});
