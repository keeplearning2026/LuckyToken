import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { replaceTextFileIfUnchanged } from "../../src/integrations/codex/file-update.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(content: string): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "Token-codex-file-update-"));
  roots.push(root);
  const path = join(root, "config.toml");
  await writeFile(path, content, "utf8");
  return { root, path };
}

describe("Codex config file compare-before-rename", () => {
  it("writes only when the current bytes still match the admitted bytes", async () => {
    const fx = await fixture('model = "before"\n');

    await expect(
      replaceTextFileIfUnchanged(
        fx.path,
        'model = "before"\n',
        'model = "after"\n',
      ),
    ).resolves.toBe("written");
    await expect(readFile(fx.path, "utf8")).resolves.toBe('model = "after"\n');
  });

  it("refuses to overwrite a newer external edit", async () => {
    const fx = await fixture('model = "before"\n');
    await writeFile(fx.path, 'model = "external"\n', "utf8");

    await expect(
      replaceTextFileIfUnchanged(
        fx.path,
        'model = "before"\n',
        'model = "Token"\n',
      ),
    ).resolves.toBe("conflict");
    await expect(readFile(fx.path, "utf8")).resolves.toBe('model = "external"\n');
  });

  it("does not touch the file when the requested content is already current", async () => {
    const fx = await fixture('model = "same"\n');

    await expect(
      replaceTextFileIfUnchanged(
        fx.path,
        'model = "same"\n',
        'model = "same"\n',
      ),
    ).resolves.toBe("unchanged");
    await expect(readFile(fx.path, "utf8")).resolves.toBe('model = "same"\n');
  });
});
