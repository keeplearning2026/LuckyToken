import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("packaged backend carries the tracked CommandCode model authority byte-for-byte", async () => {
  const source = await readFile(
    resolve(
      repositoryRoot,
      "packages",
      "commandcode-model-catalog",
      "commandcode-models.json",
    ),
  );
  const packaged = await readFile(
    resolve(
      repositoryRoot,
      "packages",
      "desktop-shell",
      "backend",
      "node_modules",
      "@token",
      "commandcode-model-catalog",
      "commandcode-models.json",
    ),
  );

  assert.deepEqual(packaged, source);
});
