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
      schemaVersion: "luckytoken-client-auth-v1",
      global: "lt_generated_global",
      projects: {},
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
      schemaVersion: "luckytoken-client-auth-v1",
      global: null,
      projects: { [projectDir]: "project-token" },
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

  it.each([
    [
      "unknown field",
      {
        schemaVersion: "luckytoken-client-auth-v1",
        global: "token",
        projects: {},
        extra: true,
      },
      "unknown field",
    ],
    [
      "relative project directory",
      {
        schemaVersion: "luckytoken-client-auth-v1",
        global: null,
        projects: { relative: "token" },
      },
      "must be absolute",
    ],
    [
      "non-normalized absolute project directory",
      {
        schemaVersion: "luckytoken-client-auth-v1",
        global: null,
        projects: {
          [`${tmpdir()}${sep}alias${sep}..${sep}project`]: "token",
        },
      },
      "must be normalized",
    ],
    [
      "duplicate token authority",
      {
        schemaVersion: "luckytoken-client-auth-v1",
        global: "same-token",
        projects: { [join(tmpdir(), "duplicate")]: "same-token" },
      },
      "belongs to multiple scopes",
    ],
    [
      "empty authority",
      {
        schemaVersion: "luckytoken-client-auth-v1",
        global: null,
        projects: {},
      },
      "must contain at least one token",
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
