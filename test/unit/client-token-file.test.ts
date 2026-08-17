import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileClientTokenStore,
  loadFileClientTokenAuthority,
} from "../../src/client-auth/file-token-store.js";

describe("per-Client-Protocol token file", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function fixtureStore() {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-client-auth-"));
    directories.push(directory);
    const path = join(directory, "anthropic-messages.json");
    return {
      path,
      store: createFileClientTokenStore({
        path,
        generateToken: () => "lt_generated_global",
      }),
    };
  }

  it("creates one global token and exposes only an immutable authorization authority", async () => {
    const { path, store } = await fixtureStore();

    await expect(store.create({ type: "global" })).resolves.toBe(
      "lt_generated_global",
    );
    const authority = await loadFileClientTokenAuthority(path);

    expect(Object.keys(authority)).toEqual(["authorize", "scrub"]);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(authority.authorize("lt_generated_global")).toEqual({});
    expect(authority.authorize("wrong-token")).toBeUndefined();
    // F4: the authority owns its raw token and exposes only a narrow scrub
    // operation that removes it from arbitrary text.
    expect(authority.scrub("token=lt_generated_global")).toBe(
      "token=[REDACTED]",
    );
    expect(authority.scrub("benign text")).toBe("benign text");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: "lt_generated_global",
      globalDeleted: false,
      projects: {},
      revision: 1,
    });
  });

  it("maps one project token to its absolute directory without exposing file state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-client-auth-"));
    directories.push(directory);
    const projectDir = join(directory, "project");
    await mkdir(projectDir);
    const path = join(directory, "future-client-protocol.json");
    const store = createFileClientTokenStore({
      path,
    });

    await expect(
      store.create({ type: "project", projectDir }, "project-token"),
    ).resolves.toBe("project-token");
    const authority = await loadFileClientTokenAuthority(path);

    expect(authority.authorize("project-token")).toEqual({ projectDir });
    expect(authority.authorize("wrong-token")).toBeUndefined();
    expect(authority).not.toHaveProperty("path");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: null,
      globalDeleted: false,
      projects: { [projectDir]: "project-token" },
      revision: 1,
    });
  });

  it("adds independent scopes while listing no token values", async () => {
    const { path, store } = await fixtureStore();
    const firstProject = join(tmpdir(), "project-a");
    const secondProject = join(tmpdir(), "project-b");

    await store.create({ type: "global" }, "global-token");
    await store.create(
      { type: "project", projectDir: secondProject },
      "second-token",
    );
    await store.create(
      { type: "project", projectDir: firstProject },
      "first-token",
    );

    await expect(store.list()).resolves.toEqual([
      { type: "global" },
      { type: "project", projectDir: firstProject },
      { type: "project", projectDir: secondProject },
    ]);
    const authority = await loadFileClientTokenAuthority(path);
    expect(authority.authorize("global-token")).toEqual({});
    expect(authority.authorize("first-token")).toEqual({
      projectDir: firstProject,
    });
    expect(JSON.stringify(await store.list())).not.toContain("token");
  });

  it("refuses scope replacement and duplicate token authority during create", async () => {
    const { path, store } = await fixtureStore();
    const projectDir = join(tmpdir(), "duplicate-authority-project");
    await store.create({ type: "global" }, "original-global");

    await expect(
      store.create({ type: "global" }, "replacement-global"),
    ).rejects.toThrow("already has a token");
    await expect(
      store.create({ type: "project", projectDir }, "original-global"),
    ).rejects.toThrow("already belongs to another scope");

    const authority = await loadFileClientTokenAuthority(path);
    expect(authority.authorize("original-global")).toEqual({});
    expect(authority.authorize("replacement-global")).toBeUndefined();
    await expect(store.list()).resolves.toEqual([{ type: "global" }]);
  });

  it("rotates and removes file authority without mutating an existing runtime snapshot", async () => {
    const { path, store } = await fixtureStore();
    await store.create({ type: "global" }, "old-global");
    const oldAuthority = await loadFileClientTokenAuthority(path);

    await expect(
      store.rotate({ type: "global" }, "new-global"),
    ).resolves.toBe("new-global");
    const newAuthority = await loadFileClientTokenAuthority(path);

    expect(oldAuthority.authorize("old-global")).toEqual({});
    expect(oldAuthority.authorize("new-global")).toBeUndefined();
    expect(newAuthority.authorize("old-global")).toBeUndefined();
    expect(newAuthority.authorize("new-global")).toEqual({});

    await expect(store.remove({ type: "global" })).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
    await expect(loadFileClientTokenAuthority(path)).rejects.toThrow(
      "must contain at least one token",
    );
    expect(newAuthority.authorize("new-global")).toEqual({});
  });

  it("rejects rotation to the token already assigned to that scope", async () => {
    const { path, store } = await fixtureStore();
    await store.create({ type: "global" }, "unchanged-global");

    await expect(
      store.rotate({ type: "global" }, "unchanged-global"),
    ).rejects.toThrow("different from the current token");

    const authority = await loadFileClientTokenAuthority(path);
    expect(authority.authorize("unchanged-global")).toEqual({});
  });

  it("enforces the persisted revision as the file-level compare-and-swap generation", async () => {
    const { path, store } = await fixtureStore();
    await store.create({ type: "global" }, "canary-cas-token-1");

    // A stale expectedRevision never mutates the file.
    await expect(
      store.rotate({ type: "global" }, "canary-cas-token-2", 0),
    ).rejects.toThrow("revision is stale");
    await expect(
      store.remove({ type: "global" }, 0),
    ).rejects.toThrow("revision is stale");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "luckytoken-client-auth-v2",
      global: "canary-cas-token-1",
      globalDeleted: false,
      projects: {},
      revision: 1,
    });

    // The current revision succeeds and bumps the generation.
    await expect(
      store.rotate({ type: "global" }, "canary-cas-token-3", 1),
    ).resolves.toBe("canary-cas-token-3");
    await expect(store.snapshot()).resolves.toMatchObject({ revision: 2 });
  });

  it("refuses legacy v1 files without rewriting them", async () => {
    const { path, store } = await fixtureStore();
    const original = JSON.stringify({
      schemaVersion: "luckytoken-client-auth-v1",
      global: "canary-legacy-token-1",
      projects: {},
    });
    await writeFile(path, original, "utf8");

    await expect(store.snapshot()).rejects.toThrow(
      "schemaVersion must be luckytoken-client-auth-v2",
    );
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });

  it.each([
    [
      "unknown field",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: "token",
        globalDeleted: false,
        projects: {},
        revision: 0,
        extra: true,
      },
      "unknown field",
    ],
    [
      "relative project directory",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: null,
        globalDeleted: false,
        projects: { relative: "token" },
        revision: 0,
      },
      "must be absolute",
    ],
    [
      "non-normalized absolute project directory",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: null,
        globalDeleted: false,
        projects: {
          [`${tmpdir()}${sep}alias${sep}..${sep}project`]: "token",
        },
        revision: 0,
      },
      "must be normalized",
    ],
    [
      "duplicate token authority",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: "same-token",
        globalDeleted: false,
        projects: { [join(tmpdir(), "duplicate")]: "same-token" },
        revision: 0,
      },
      "belongs to multiple scopes",
    ],
    [
      "empty authority",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: null,
        globalDeleted: false,
        projects: {},
        revision: 0,
      },
      "must contain at least one token",
    ],
    [
      "missing revision",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: "token",
        projects: {},
      },
      "revision must be a non-negative integer",
    ],
    [
      "negative revision",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: "token",
        globalDeleted: false,
        projects: {},
        revision: -1,
      },
      "revision must be a non-negative integer",
    ],
    [
      "non-boolean deletion marker",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: null,
        globalDeleted: "yes",
        projects: {},
        revision: 0,
      },
      "globalDeleted must be a boolean",
    ],
    [
      "deletion marker while a token exists",
      {
        schemaVersion: "luckytoken-client-auth-v2",
        global: "token",
        globalDeleted: true,
        projects: {},
        revision: 0,
      },
      "globalDeleted must be false while a global token exists",
    ],
    [
      "unsupported legacy schema",
      {
        schemaVersion: "luckytoken-client-auth-v1",
        global: "token",
        projects: {},
        revision: 0,
      },
      "schemaVersion must be luckytoken-client-auth-v2",
    ],
  ])("rejects $name before constructing runtime authority", async (_name, data, error) => {
    const { path } = await fixtureStore();
    await writeFile(path, JSON.stringify(data), "utf8");

    await expect(loadFileClientTokenAuthority(path)).rejects.toThrow(error);
  });

  it("generates opaque 256-bit tokens without embedding protocol or scope facts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-client-auth-"));
    directories.push(directory);
    const store = createFileClientTokenStore({
      path: join(directory, "anthropic-messages.json"),
    });

    const first = await store.create({ type: "global" });
    const second = await store.rotate({ type: "global" });

    expect(first).toMatch(/^lt_[A-Za-z0-9_-]{43}$/u);
    expect(second).toMatch(/^lt_[A-Za-z0-9_-]{43}$/u);
    expect(second).not.toBe(first);
    expect(first).not.toContain("anthropic");
    expect(first).not.toContain("global");
  });
});
