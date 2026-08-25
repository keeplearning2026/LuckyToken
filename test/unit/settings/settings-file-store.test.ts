import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileSettingsStore } from "../../../src/settings/file-store.js";

describe("file settings store commit lifecycle", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("does not publish current state before the atomic rename succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-settings-store-"));
    roots.push(root);
    const path = join(root, "settings.json");
    const store = createFileSettingsStore(path);
    await expect(store.load()).resolves.toEqual({});
    await mkdir(path);

    await expect(store.save({ enabled: true })).rejects.toBeDefined();
    await expect(store.load()).resolves.toEqual({});
  });

  it("shares concurrent reads and permits a retry after read failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-settings-load-"));
    roots.push(root);
    const path = join(root, "settings.json");
    await writeFile(path, "not json", "utf8");
    const store = createFileSettingsStore(path);

    await expect(Promise.all([store.load(), store.load()])).rejects.toThrow(
      "Failed to read Settings file",
    );
    await writeFile(path, JSON.stringify({ enabled: true }), "utf8");
    await expect(store.load()).resolves.toEqual({ enabled: true });
  });
});
