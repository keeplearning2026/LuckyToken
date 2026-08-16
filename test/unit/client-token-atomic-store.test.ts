import { open, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ClientTokenStaleRevisionError,
  createFileClientTokenStore,
  loadFileClientTokenAuthority,
} from "../../src/client-auth/file-token-store.js";
import { createLiveClientTokenAuthority } from "../../src/client-auth/live-authority.js";

/**
 * Repair turn 2 public seam: the token file's read-check-mutate-write
 * sequence must be serialized by a real filesystem lock shared across
 * independent store instances/processes, and each persist must publish
 * through a private temporary file plus atomic replace so a fault can never
 * corrupt or truncate the last valid credential file.
 */
describe("locked atomic client token persistence", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function fixture(): Promise<{
    readonly directory: string;
    readonly path: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-atomic-"));
    directories.push(directory);
    return { directory, path: join(directory, "anthropic-messages.json") };
  }

  it("races two independent store instances from the same revision: exactly one mutation wins", async () => {
    const { directory, path } = await fixture();
    const seed = createFileClientTokenStore({ path });
    await seed.create({ type: "global" }, "canary-race-seed", 0);

    const first = createFileClientTokenStore({ path });
    const second = createFileClientTokenStore({ path });
    // Both independent instances observe the same revision before mutating,
    // exactly like two CLI processes that snapshot before writing.
    const [snapshotFirst, snapshotSecond] = await Promise.all([
      first.snapshot(),
      second.snapshot(),
    ]);
    expect(snapshotFirst.revision).toBe(1);
    expect(snapshotSecond.revision).toBe(1);

    const [a, b] = await Promise.allSettled([
      first.rotate({ type: "global" }, "canary-race-winner-a", 1),
      second.rotate({ type: "global" }, "canary-race-winner-b", 1),
    ]);
    const winners = [a, b].filter(
      (result): result is PromiseFulfilledResult<string> =>
        result.status === "fulfilled",
    );
    const losers = [a, b].filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    // Exactly one mutation wins; the loser receives an explicit stale
    // conflict after the filesystem lock serialized the two writers.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ClientTokenStaleRevisionError,
    );

    // No lost update, no duplicate revision: exactly one candidate is
    // persisted at revision 2 and nothing else remains in the directory.
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      readonly global: string;
      readonly revision: number;
    };
    expect(["canary-race-winner-a", "canary-race-winner-b"]).toContain(
      persisted.global,
    );
    expect(persisted.revision).toBe(2);
    expect(await readdir(directory)).toEqual([
      "anthropic-messages.json",
    ]);
  });

  it("races two creates for the same scope: one wins and the other conflicts", async () => {
    const { path } = await fixture();
    const first = createFileClientTokenStore({ path });
    const second = createFileClientTokenStore({ path });

    const [a, b] = await Promise.allSettled([
      first.create({ type: "global" }, "canary-create-winner-a", 0),
      second.create({ type: "global" }, "canary-create-winner-b", 0),
    ]);
    const winners = [a, b].filter(
      (result): result is PromiseFulfilledResult<string> =>
        result.status === "fulfilled",
    );
    const losers = [a, b].filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ClientTokenStaleRevisionError,
    );
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      readonly global: string;
      readonly revision: number;
    };
    expect(["canary-create-winner-a", "canary-create-winner-b"]).toContain(
      persisted.global,
    );
    expect(persisted.revision).toBe(1);
  });

  it("keeps the last valid bytes when temporary-file creation fails", async () => {
    const { directory, path } = await fixture();
    const normal = createFileClientTokenStore({ path });
    await normal.create({ type: "global" }, "canary-atomic-old-1", 0);
    const originalBytes = await readFile(path, "utf8");

    const faulted = createFileClientTokenStore({
      path,
      fileOperations: {
        createTemporary: async () => {
          throw new Error("injected temp-create failure");
        },
        flush: (handle) => handle.sync(),
        replace: (from, to) => import("node:fs/promises").then((fs) => fs.rename(from, to)),
      },
    });
    await expect(
      faulted.rotate({ type: "global" }, "canary-atomic-new-2", 1),
    ).rejects.toThrow("injected temp-create failure");

    expect(await readFile(path, "utf8")).toBe(originalBytes);
    await expect(faulted.snapshot()).resolves.toMatchObject({
      revision: 1,
      global: "canary-atomic-old-1",
    });
    const authority = await loadFileClientTokenAuthority(path);
    expect(authority.authorize("canary-atomic-old-1")).toEqual({});
    expect(authority.authorize("canary-atomic-new-2")).toBeUndefined();
    expect(await readdir(directory)).toEqual(["anthropic-messages.json"]);
  });

  it("keeps the last valid bytes and cleans the temporary file when flush fails", async () => {
    const { directory, path } = await fixture();
    const normal = createFileClientTokenStore({ path });
    await normal.create({ type: "global" }, "canary-atomic-old-3", 0);
    const originalBytes = await readFile(path, "utf8");

    const faulted = createFileClientTokenStore({
      path,
      fileOperations: {
        createTemporary: (temporaryPath) => open(temporaryPath, "wx", 0o600),
        flush: async () => {
          throw new Error("injected flush failure");
        },
        replace: (from, to) => import("node:fs/promises").then((fs) => fs.rename(from, to)),
      },
    });
    await expect(
      faulted.rotate({ type: "global" }, "canary-atomic-new-4", 1),
    ).rejects.toThrow("injected flush failure");

    expect(await readFile(path, "utf8")).toBe(originalBytes);
    const authority = await loadFileClientTokenAuthority(path);
    expect(authority.authorize("canary-atomic-old-3")).toEqual({});
    expect(authority.authorize("canary-atomic-new-4")).toBeUndefined();
    // The unpublished temporary file was cleaned safely.
    expect(await readdir(directory)).toEqual(["anthropic-messages.json"]);
  });

  it("keeps the last valid bytes and cleans the temporary file when atomic replace fails", async () => {
    const { directory, path } = await fixture();
    const normal = createFileClientTokenStore({ path });
    await normal.create({ type: "global" }, "canary-atomic-old-5", 0);
    const originalBytes = await readFile(path, "utf8");

    const faulted = createFileClientTokenStore({
      path,
      fileOperations: {
        createTemporary: (temporaryPath) => open(temporaryPath, "wx", 0o600),
        flush: (handle) => handle.sync(),
        replace: async () => {
          throw new Error("injected replace failure");
        },
      },
    });
    await expect(
      faulted.rotate({ type: "global" }, "canary-atomic-new-6", 1),
    ).rejects.toThrow("injected replace failure");

    expect(await readFile(path, "utf8")).toBe(originalBytes);
    const authority = await loadFileClientTokenAuthority(path);
    expect(authority.authorize("canary-atomic-old-5")).toEqual({});
    expect(authority.authorize("canary-atomic-new-6")).toBeUndefined();
    expect(await readdir(directory)).toEqual(["anthropic-messages.json"]);
  });

  it("never hot-applies a rotation whose atomic publication fails", async () => {
    const { path } = await fixture();
    const normal = createFileClientTokenStore({ path });
    await normal.create({ type: "global" }, "canary-publish-old-7", 0);
    const originalBytes = await readFile(path, "utf8");

    const faulted = createFileClientTokenStore({
      path,
      fileOperations: {
        createTemporary: (temporaryPath) => open(temporaryPath, "wx", 0o600),
        flush: (handle) => handle.sync(),
        replace: async () => {
          throw new Error("injected replace failure");
        },
      },
    });
    const live = await createLiveClientTokenAuthority({
      store: faulted,
      generateToken: () => "canary-publish-new-8",
    });

    await expect(
      live.rotate(1, "canary-publish-new-8"),
    ).rejects.toThrow("injected replace failure");

    // The mirror never hot-applied the unpersisted token and the persisted
    // bytes stay byte-identical.
    expect(live.authorize("canary-publish-old-7")).toEqual({});
    expect(live.authorize("canary-publish-new-8")).toBeUndefined();
    await expect(live.reveal()).resolves.toBe("canary-publish-old-7");
    expect(await readFile(path, "utf8")).toBe(originalBytes);
  });
});
