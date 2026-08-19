import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileClientTokenStore,
  type FileClientTokenStore,
} from "../../src/client-auth/file-token-store.js";
import {
  ClientTokenInvalidValueError,
  ClientTokenScopeNotFoundError,
  ClientTokenStaleRevisionError,
  createLiveClientTokenAuthority,
  type ClientTokenAuthorityListing,
  type LiveClientTokenAuthority,
} from "../../src/client-auth/live-authority.js";

const GLOBAL_TOKEN = "canary-global-token-1";
const PROJECT_TOKEN = "canary-project-token-1";
const PROJECT_DIR = "C:\\projects\\ticket17";

describe("live protocol-global Client Token Authority", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function fixtureStore(): Promise<{
    readonly path: string;
    readonly store: FileClientTokenStore;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-live-auth-"));
    directories.push(directory);
    const path = join(directory, "anthropic-messages.json");
    return {
      path,
      store: createFileClientTokenStore({
        path,
        generateToken: () => "lt_generated_deterministic",
      }),
    };
  }

  async function authority(
    store: FileClientTokenStore,
  ): Promise<LiveClientTokenAuthority> {
    return createLiveClientTokenAuthority({
      store,
      generateToken: () => GLOBAL_TOKEN,
    });
  }

  it("creates exactly one protocol-global token on first enable and never replaces it", async () => {
    const { path, store } = await fixtureStore();
    const live = await authority(store);

    await expect(live.ensureGlobal()).resolves.toBe(true);
    const listing = await live.list();
    expect(listing.revision).toBe(1);
    expect(listing.scopes).toEqual([
      { type: "global", maskedToken: "canary-g…en-1" },
    ]);
    // The masked listing never exposes the raw token.
    expect(JSON.stringify(listing)).not.toContain(GLOBAL_TOKEN);
    expect(JSON.stringify(listing)).toContain("…");

    // A second enable must not create or replace the token.
    await expect(live.ensureGlobal()).resolves.toBe(false);
    await expect(live.list()).resolves.toEqual({
      revision: 1,
      scopes: [{ type: "global", maskedToken: "canary-g…en-1" }],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: GLOBAL_TOKEN,
      globalDeleted: false,
      projects: {},
      revision: 1,
    });
  });

  it("authorizes only its own protocol and preserves project-token authority", async () => {
    const { path, store } = await fixtureStore();
    const live = await authority(store);
    await store.create({ type: "project", projectDir: PROJECT_DIR }, PROJECT_TOKEN);
    await live.ensureGlobal();

    expect(live.authorize(GLOBAL_TOKEN)).toEqual({});
    expect(live.authorize(PROJECT_TOKEN)).toEqual({ projectDir: PROJECT_DIR });
    expect(live.authorize("canary-other-protocol-token-9")).toBeUndefined();
    expect(live.authorize("")).toBeUndefined();
    expect(live.authorize(GLOBAL_TOKEN)?.projectDir).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: GLOBAL_TOKEN,
      globalDeleted: false,
      projects: { [PROJECT_DIR]: PROJECT_TOKEN },
      revision: 2,
    });
  });

  it("rotates atomically: persists the replacement, hot-applies it, and rejects the prior token", async () => {
    const { path, store } = await fixtureStore();
    const live = await authority(store);
    await store.create({ type: "project", projectDir: PROJECT_DIR }, PROJECT_TOKEN);
    await live.ensureGlobal();
    const replacement = "canary-rotated-token-2";

    const rotated = await live.rotate(2, replacement);
    expect(rotated.revision).toBe(3);
    expect(rotated.scopes).toContainEqual({
      type: "global",
      maskedToken: "canary-r…en-2",
    });
    expect(JSON.stringify(rotated)).not.toContain(replacement);

    // Hot-applied: authorization switches immediately.
    expect(live.authorize(GLOBAL_TOKEN)).toBeUndefined();
    expect(live.authorize(replacement)).toEqual({});
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: replacement,
      globalDeleted: false,
      projects: { [PROJECT_DIR]: PROJECT_TOKEN },
      revision: 3,
    });

    // Rotating to the same token or a project token is invalid.
    await expect(live.rotate(3, replacement)).rejects.toBeInstanceOf(
      ClientTokenInvalidValueError,
    );
    await expect(live.rotate(3, PROJECT_TOKEN)).rejects.toBeInstanceOf(
      ClientTokenInvalidValueError,
    );
    // A stale revision never replaces the active token.
    await expect(live.rotate(2, "canary-stale-token-3")).rejects.toBeInstanceOf(
      ClientTokenStaleRevisionError,
    );
    expect(live.authorize(replacement)).toEqual({});
  });

  it("removes hot-applies without touching project tokens and reports an empty authority", async () => {
    const { path, store } = await fixtureStore();
    const live = await authority(store);
    await store.create({ type: "project", projectDir: PROJECT_DIR }, PROJECT_TOKEN);
    await live.ensureGlobal();

    const removed = await live.remove(2);
    expect(removed.revision).toBe(3);
    expect(removed.scopes).toEqual([
      { type: "project", projectDir: PROJECT_DIR, maskedToken: "canary-p…en-1" },
    ]);
    expect(live.authorize(GLOBAL_TOKEN)).toBeUndefined();
    expect(live.authorize(PROJECT_TOKEN)).toEqual({ projectDir: PROJECT_DIR });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: null,
      globalDeleted: true,
      projects: { [PROJECT_DIR]: PROJECT_TOKEN },
      revision: 3,
    });

    await expect(live.remove(3)).rejects.toBeInstanceOf(
      ClientTokenScopeNotFoundError,
    );
    await expect(live.rotate(3, "canary-after-remove-4")).rejects.toBeInstanceOf(
      ClientTokenScopeNotFoundError,
    );
    // Reveal of an absent global is an explicit not-found, never a secret.
    await expect(live.reveal()).rejects.toBeInstanceOf(
      ClientTokenScopeNotFoundError,
    );
  });

  it("reveals only the requested active global secret", async () => {
    const { store } = await fixtureStore();
    const live = await authority(store);
    await store.create({ type: "project", projectDir: PROJECT_DIR }, PROJECT_TOKEN);
    await live.ensureGlobal();

    await expect(live.reveal()).resolves.toBe(GLOBAL_TOKEN);
    await expect(live.reveal()).resolves.not.toBe(PROJECT_TOKEN);
  });

  it("serializes concurrent mutations and stale revisions can never resurrect an old token", async () => {
    const { path, store } = await fixtureStore();
    const live = await authority(store);
    await live.ensureGlobal();

    const [first, second] = await Promise.allSettled([
      live.rotate(1, "canary-winner-token-5"),
      live.rotate(1, "canary-loser-token-6"),
    ]);
    const winners = [first, second].filter(
      (
        result,
      ): result is PromiseFulfilledResult<ClientTokenAuthorityListing> =>
        result.status === "fulfilled",
    );
    const losers = [first, second].filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ClientTokenStaleRevisionError,
    );
    const active = winners[0]?.value.scopes[0]?.maskedToken;
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      readonly global: string;
    };
    expect(persisted.global).toBe(
      active === "canary-w…en-5" ? "canary-winner-token-5" : "canary-loser-token-6",
    );
    expect(live.authorize(GLOBAL_TOKEN)).toBeUndefined();
  });

  it("keeps its known-value scrub in sync with the active token after rotate", async () => {
    const { store } = await fixtureStore();
    const live = await authority(store);
    await live.ensureGlobal();

    expect(live.scrub(`token=${GLOBAL_TOKEN}`)).toBe("token=[REDACTED]");
    await live.rotate(1, "canary-rotated-token-2");
    expect(live.scrub(`token=canary-rotated-token-2`)).toBe(
      "token=[REDACTED]",
    );
    // The revoked prior token is no longer a live credential.
    expect(live.scrub(`token=${GLOBAL_TOKEN}`)).toBe(`token=${GLOBAL_TOKEN}`);
    expect(live.scrub("benign text")).toBe("benign text");
  });

  it("never hot-applies a rotation whose persistence fails", async () => {
    const { path, store } = await fixtureStore();
    const live = await authority(store);
    await live.ensureGlobal();
    const failingStore: FileClientTokenStore = {
      ...store,
      rotate: async () => {
        throw new Error("simulated disk-full failure");
      },
    };
    const failingAuthority = await createLiveClientTokenAuthority({
      store: failingStore,
      generateToken: () => "canary-unpersisted-token-8",
    });

    await expect(
      failingAuthority.rotate(1, "canary-unpersisted-token-8"),
    ).rejects.toThrow("simulated disk-full failure");
    // The prior token remains authoritative and the file is unchanged.
    expect(failingAuthority.authorize(GLOBAL_TOKEN)).toEqual({});
    expect(failingAuthority.authorize("canary-unpersisted-token-8")).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: GLOBAL_TOKEN,
      globalDeleted: false,
      projects: {},
      revision: 1,
    });
  });

  it("boots from an empty or missing token file without throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-live-auth-"));
    directories.push(directory);
    const path = join(directory, "missing.json");
    const live = await createLiveClientTokenAuthority({
      store: createFileClientTokenStore({ path }),
      generateToken: () => "canary-boot-token-9",
    });

    await expect(live.list()).resolves.toEqual({ revision: 0, scopes: [] });
    await expect(live.ensureGlobal()).resolves.toBe(true);
    await expect(live.reveal()).resolves.toBe("canary-boot-token-9");
  });

  it("refuses a corrupted token file instead of serving unvalidated state", async () => {
    const { path, store } = await fixtureStore();
    await writeFile(path, JSON.stringify({ schemaVersion: "wrong" }), "utf8");

    await expect(
      createLiveClientTokenAuthority({
        store,
        generateToken: () => GLOBAL_TOKEN,
      }),
    ).rejects.toThrow("schemaVersion");
  });
});

describe("live authority persisted state across restarts (repair findings 1-2)", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function fixtureStore(): Promise<{
    readonly path: string;
    readonly store: FileClientTokenStore;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-live-repair-"));
    directories.push(directory);
    const path = join(directory, "anthropic-messages.json");
    return {
      path,
      store: createFileClientTokenStore({
        path,
        generateToken: () => "lt_generated_deterministic",
      }),
    };
  }

  it("never re-creates a deliberately deleted global token on a fresh authority boot", async () => {
    const { path, store } = await fixtureStore();
    const first = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-repair-token-1",
    });
    await first.ensureGlobal();
    await first.remove(1);

    // Restart: a new authority boots from the same persisted file. The
    // deliberate deletion must survive: fresh boot-time enabling must NOT
    // create a replacement token.
    const restarted = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-replacement-token-9",
    });
    await expect(restarted.ensureGlobal({ freshOnly: true })).resolves.toBe(
      false,
    );
    await expect(restarted.list()).resolves.toEqual({ revision: 2, scopes: [] });
    expect(restarted.authorize("canary-repair-token-1")).toBeUndefined();
    expect(restarted.authorize("canary-replacement-token-9")).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: null,
      globalDeleted: true,
      projects: {},
      revision: 2,
    });

    // The disabled→enabled transition may create even after deletion.
    await expect(restarted.ensureGlobal()).resolves.toBe(true);
    await expect(restarted.reveal()).resolves.toBe("canary-replacement-token-9");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      global: "canary-replacement-token-9",
      globalDeleted: false,
      revision: 3,
    });
  });

  it("boots a fresh never-initialized scope and creates the initial global token once", async () => {
    const { store } = await fixtureStore();
    const live = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-fresh-token-1",
    });

    await expect(live.ensureGlobal({ freshOnly: true })).resolves.toBe(true);
    await expect(live.ensureGlobal({ freshOnly: true })).resolves.toBe(false);
    await expect(live.reveal()).resolves.toBe("canary-fresh-token-1");
  });

  it("persists a monotonic revision so a pre-restart stale revision conflicts", async () => {
    const { store } = await fixtureStore();
    const first = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-rev-token-1",
    });
    await first.ensureGlobal(); // revision 1
    await first.rotate(1, "canary-rev-token-2"); // revision 2

    // Restart: the revision continues from the authoritative file instead of
    // resetting, so a pre-restart revision can never match a reset value.
    const restarted = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-rev-token-3",
    });
    expect(restarted.revision).toBe(2);
    await expect(
      restarted.rotate(1, "canary-stale-pre-restart-token"),
    ).rejects.toBeInstanceOf(ClientTokenStaleRevisionError);
    await expect(
      restarted.remove(1),
    ).rejects.toBeInstanceOf(ClientTokenStaleRevisionError);

    const rotated = await restarted.rotate(2, "canary-rev-token-3");
    expect(rotated.revision).toBe(3);
    // The now-stale pre-restart revision can never rotate again.
    await expect(
      restarted.rotate(2, "canary-rev-token-4"),
    ).rejects.toBeInstanceOf(ClientTokenStaleRevisionError);
    expect(restarted.authorize("canary-rev-token-2")).toBeUndefined();
    expect(restarted.authorize("canary-rev-token-3")).toEqual({});
  });

  it("starts from empty state on legacy v1 and generates a fresh v2 authority without reusing the old token", async () => {
    const { path, store } = await fixtureStore();
    const legacyToken = "canary-v1-token-1";
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "luckytoken-client-auth-v1",
        global: legacyToken,
        projects: {},
      }),
      "utf8",
    );

    const live = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-fresh-v2-token",
    });
    expect(live.revision).toBe(0);
    expect(live.authorize(legacyToken)).toBeUndefined();
    await expect(live.ensureGlobal({ freshOnly: true })).resolves.toBe(true);
    expect(live.authorize("canary-fresh-v2-token")).toEqual({});
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: "canary-fresh-v2-token",
      projects: {},
      revision: 1,
      globalDeleted: false,
    });
  });

  it("conflicts when the authoritative file advanced behind the authority mirror and then converges", async () => {
    const { store } = await fixtureStore();
    const live = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-ext-token-1",
    });
    await live.ensureGlobal(); // revision 1
    // An offline directory-token CLI write advances the file directly while
    // the running authority still mirrors the older generation.
    await store.create(
      { type: "project", projectDir: PROJECT_DIR },
      "canary-offline-project-token",
      1,
    ); // revision 2

    // The running authority's next mutation can never clobber that write.
    await expect(
      live.rotate(1, "canary-clobber-token-9"),
    ).rejects.toBeInstanceOf(ClientTokenStaleRevisionError);
    // The mirror converges with the authoritative file.
    await expect(live.list()).resolves.toMatchObject({ revision: 2 });
    await expect(live.authorize("canary-offline-project-token")).toEqual({
      projectDir: PROJECT_DIR,
    });
    // The current generation succeeds.
    await expect(
      live.rotate(2, "canary-after-external-1"),
    ).resolves.toMatchObject({ revision: 3 });
  });
});

describe("live authority canonical directory scopes (Ticket 17)", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function directoryFixture(): Promise<{
    readonly root: string;
    readonly projectDir: string;
    readonly path: string;
    readonly store: FileClientTokenStore;
  }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-canonical-auth-"));
    directories.push(root);
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const path = join(root, "anthropic-messages.json");
    const store = createFileClientTokenStore({
      path,
      generateToken: () => "lt_generated_deterministic",
    });
    return { root, projectDir, path, store };
  }

  it("creates one canonical scope through an alias and persists only the canonical identity", async () => {
    const { root, projectDir, path, store } = await directoryFixture();
    const live = await createLiveClientTokenAuthority({ store });
    // Windows junction (no privilege needed); elsewhere a real symlink.
    const alias = join(root, "project-alias");
    await symlink(projectDir, alias, "junction").catch(() =>
      symlink(projectDir, alias, "dir"),
    );
    const aliasCase = `${alias.toUpperCase()}${sep}`;

    const created = await live.createProject(aliasCase, "canary-dir-token-1");
    expect(created.canonicalDir).toBe(projectDir);
    expect(created.listing.revision).toBe(1);
    expect(created.listing.scopes).toEqual([
      {
        type: "project",
        projectDir,
        maskedToken: "canary-d…en-1",
      },
    ]);
    // The authoritative file stores only the canonical identity.
    const persisted = JSON.parse(
      await readFile(path, "utf8"),
    ) as { projects: Record<string, string> };
    expect(Object.keys(persisted.projects)).toEqual([projectDir]);
    expect(JSON.stringify(persisted)).not.toContain(alias);
    expect(JSON.stringify(persisted)).not.toContain(aliasCase);

    // Authorization supplies the canonical projectDir.
    expect(live.authorize("canary-dir-token-1")).toEqual({ projectDir });
    // Aliases cannot create a duplicate scope.
    await expect(
      live.createProject(alias, "canary-dir-token-2"),
    ).rejects.toMatchObject({ code: "SCOPE_EXISTS" });
    expect(await store.snapshot()).toMatchObject({ revision: 1 });
  });

  it("reveals, rotates, and removes a directory scope through its aliases with the locked revision", async () => {
    const { root, projectDir, store } = await directoryFixture();
    const live = await createLiveClientTokenAuthority({ store });
    await live.createProject(projectDir, "canary-dir-token-1");
    const alias = join(root, "project-alias");
    await symlink(projectDir, alias, "junction").catch(() =>
      symlink(projectDir, alias, "dir"),
    );

    await expect(live.revealProject(alias)).resolves.toBe("canary-dir-token-1");
    // A stale revision can never rotate the scope.
    await expect(
      live.rotateProject(0, alias, "canary-dir-token-2"),
    ).rejects.toBeInstanceOf(ClientTokenStaleRevisionError);
    const rotated = await live.rotateProject(1, alias, "canary-dir-token-2");
    expect(rotated.revision).toBe(2);
    expect(live.authorize("canary-dir-token-1")).toBeUndefined();
    expect(live.authorize("canary-dir-token-2")).toEqual({ projectDir });
    // The scrub follows the hot rotation: only the active owned token
    // value is scrubbed; the revoked prior token is no longer owned.
    expect(live.scrub("prefix canary-dir-token-1 suffix")).toBe(
      "prefix canary-dir-token-1 suffix",
    );
    expect(live.scrub("prefix canary-dir-token-2 suffix")).toBe(
      "prefix [REDACTED] suffix",
    );

    const removed = await live.removeProject(2, alias);
    expect(removed.revision).toBe(3);
    expect(removed.scopes).toEqual([]);
    expect(live.authorize("canary-dir-token-2")).toBeUndefined();
    await expect(live.revealProject(alias)).rejects.toBeInstanceOf(
      ClientTokenScopeNotFoundError,
    );
  });

  it("rejects directory inputs with the value-free failure taxonomy", async () => {
    const { root, store } = await directoryFixture();
    const live = await createLiveClientTokenAuthority({ store });
    await expect(
      live.createProject(join(root, "missing"), "canary-x"),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY", reason: "not_found" });
    const file = join(root, "file.txt");
    await writeFile(file, "content");
    await expect(
      live.createProject(file, "canary-x"),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY", reason: "not_a_directory" });
    await expect(live.createProject("", "canary-x")).rejects.toMatchObject({
      code: "INVALID_DIRECTORY",
      reason: "invalid",
    });
    // Nothing was persisted and no error carries the raw input.
    expect(await store.snapshot()).toMatchObject({ revision: 0 });
  });

  it("supports an injectable resolver and keeps the lock across canonicalization", async () => {
    const { projectDir, store } = await directoryFixture();
    let resolutions = 0;
    const live = await createLiveClientTokenAuthority({
      store,
      resolveCanonicalDirectory: {
        async resolve(input: string) {
          resolutions += 1;
          if (input === "C:\projects\resolved") {
            return { outcome: "ok", canonicalDir: projectDir };
          }
          return { outcome: "not_found" };
        },
      },
    });
    await live.createProject("C:\projects\resolved", "canary-injected-1");
    expect(resolutions).toBe(1);
    expect(live.authorize("canary-injected-1")).toEqual({ projectDir });
    await expect(
      live.createProject("C:\projects\resolved", "canary-injected-2"),
    ).rejects.toMatchObject({ code: "SCOPE_EXISTS" });
    // Two mutations against the same alias serialize; the second resolution
    // still happened inside the lock before the scope-exists rejection.
    expect(resolutions).toBe(2);
  });

  it("keeps directory and global scopes independent with distinct tokens", async () => {
    const { projectDir, store } = await directoryFixture();
    const live = await createLiveClientTokenAuthority({
      store,
      generateToken: () => "canary-global-dir-1",
    });
    await live.ensureGlobal({ freshOnly: true });
    await live.createProject(projectDir, "canary-project-dir-1");
    expect(live.authorize("canary-global-dir-1")).toEqual({});
    expect(live.authorize("canary-project-dir-1")).toEqual({ projectDir });
    const listed = await live.list();
    expect(listed.scopes).toEqual([
      { type: "global", maskedToken: "canary-g…ir-1" },
      { type: "project", projectDir, maskedToken: "canary-p…ir-1" },
    ]);
  });
});

describe("live authority orphaned directory scopes (Ticket 17 repair 01)", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function orphanFixture(options?: {
    readonly keepDirectory?: boolean;
  }): Promise<{
    readonly root: string;
    readonly projectDir: string;
    readonly store: FileClientTokenStore;
    readonly live: LiveClientTokenAuthority;
  }> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-orphan-auth-"));
    directories.push(root);
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const store = createFileClientTokenStore({
      path: join(root, "anthropic-messages.json"),
    });
    const live = await createLiveClientTokenAuthority({ store });
    await live.createProject(projectDir, "canary-orphan-token-1");
    if (options?.keepDirectory !== true) {
      // The directory disappears while the persisted canonical scope stays.
      await rm(projectDir, { recursive: true, force: true });
    }
    return { root, projectDir, store, live };
  }

  it("lists the persisted orphan scope and removes it by its stored canonical identity", async () => {
    const { projectDir, store, live } = await orphanFixture();

    // The persisted scope still lists with its stored canonical identity.
    const listed = await live.list();
    expect(listed.scopes).toEqual([
      { type: "project", projectDir, maskedToken: "canary-o…en-1" },
    ]);
    expect(await store.snapshot()).toMatchObject({
      projects: { [projectDir]: "canary-orphan-token-1" },
    });

    // Remove succeeds when addressed by the listed canonical scope
    // identity, and the old token immediately stops authorizing.
    const removed = await live.removeProject(listed.revision, projectDir);
    expect(removed.revision).toBe(listed.revision + 1);
    expect(removed.scopes).toEqual([]);
    expect(live.authorize("canary-orphan-token-1")).toBeUndefined();
    // The identity is no longer persisted, so the missing directory is a
    // plain value-free rejection again.
    await expect(live.revealProject(projectDir)).rejects.toMatchObject({
      code: "INVALID_DIRECTORY",
      reason: "not_found",
    });
  });

  it("reveals and rotates an orphan scope by its stored canonical identity, keeping the identity", async () => {
    const { projectDir, live } = await orphanFixture();

    await expect(live.revealProject(projectDir)).resolves.toBe(
      "canary-orphan-token-1",
    );
    const rotated = await live.rotateProject(
      (await live.list()).revision,
      projectDir,
      "canary-orphan-token-2",
    );
    expect(rotated.revision).toBe(2);
    // The old token is immediately invalid; the new token retains the same
    // stored canonical projectDir.
    expect(live.authorize("canary-orphan-token-1")).toBeUndefined();
    expect(live.authorize("canary-orphan-token-2")).toEqual({ projectDir });
    expect(rotated.scopes).toEqual([
      { type: "project", projectDir, maskedToken: "canary-o…en-2" },
    ]);
    // The scrub follows the hot rotation on the orphan scope.
    expect(live.scrub("prefix canary-orphan-token-2 suffix")).toBe(
      "prefix [REDACTED] suffix",
    );
  });

  it("never lets an arbitrary missing path, a former alias, or a creation use the fallback", async () => {
    const { root, projectDir, store, live } = await orphanFixture();
    // A junction alias to the deleted directory no longer resolves and is
    // not a persisted canonical identity: every lookup still rejects.
    const alias = join(root, "former-alias");
    await symlink(projectDir, alias, "junction").catch(() =>
      symlink(projectDir, alias, "dir"),
    );
    await rm(alias, { force: true });
    for (const input of [alias, join(root, "never-existed")]) {
      await expect(live.revealProject(input)).rejects.toMatchObject({
        code: "INVALID_DIRECTORY",
        reason: "not_found",
      });
      await expect(
        live.rotateProject((await live.list()).revision, input),
      ).rejects.toMatchObject({ code: "INVALID_DIRECTORY", reason: "not_found" });
      await expect(
        live.removeProject((await live.list()).revision, input),
      ).rejects.toMatchObject({ code: "INVALID_DIRECTORY", reason: "not_found" });
    }
    // Creating a token for a missing directory still fails (not_found),
    // even when the input matches the persisted canonical identity, and
    // nothing new is persisted.
    await expect(
      live.createProject(projectDir, "canary-orphan-token-2"),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY", reason: "not_found" });
    await expect(
      live.createProject(join(root, "missing"), "canary-orphan-token-2"),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY", reason: "not_found" });
    expect(await store.snapshot()).toMatchObject({
      projects: { [projectDir]: "canary-orphan-token-1" },
      revision: 1,
    });
  });

  it("keeps realpath alias resolution while the directory exists and only then", async () => {
    const { root, projectDir, live } = await orphanFixture({
      keepDirectory: true,
    });
    const alias = join(root, "alias");
    await symlink(projectDir, alias, "junction").catch(() =>
      symlink(projectDir, alias, "dir"),
    );
    // While the directory exists, the alias resolves to the canonical
    // scope (the stored identity is not required for management).
    await expect(live.revealProject(alias)).resolves.toBe(
      "canary-orphan-token-1",
    );
    await expect(
      live.rotateProject((await live.list()).revision, alias, "canary-orphan-token-2"),
    ).resolves.toMatchObject({ revision: 2 });
    // The directory then disappears: the alias can no longer resolve and
    // only the stored canonical identity remains usable.
    await rm(projectDir, { recursive: true, force: true });
    const stored = (await live.list()).scopes.find(
      (entry) => entry.type === "project",
    )?.projectDir as string;
    expect(stored).toBe(projectDir);
    await expect(live.revealProject(alias)).rejects.toMatchObject({
      code: "INVALID_DIRECTORY",
      reason: "not_found",
    });
    await expect(live.revealProject(stored)).resolves.toBe(
      "canary-orphan-token-2",
    );
  });
});
