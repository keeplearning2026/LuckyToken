import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolvePackagedExecutable } from "../../packages/desktop-shell/test/support/packaged-executable.mjs";

test("distribution certification uses the explicitly selected packaged executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "Token-executable-binding-"));
  const outputRoot = join(root, ".electron-out");
  const selected = join(root, "candidate", "Token.exe");
  const newerUnselected = join(outputRoot, "newer", "token-win32-x64", "Token.exe");

  try {
    await Promise.all([
      mkdir(join(root, "candidate"), { recursive: true }),
      mkdir(join(outputRoot, "newer", "token-win32-x64"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(selected, "selected", "utf8"),
      writeFile(newerUnselected, "unselected", "utf8"),
    ]);

    assert.equal(
      await resolvePackagedExecutable(root, {
        TOKEN_PACKAGED_EXECUTABLE: selected,
      }),
      resolve(selected),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid explicit packaged executable fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "Token-executable-binding-"));
  try {
    await assert.rejects(
      resolvePackagedExecutable(root, {
        TOKEN_PACKAGED_EXECUTABLE: join(root, "missing", "Token.exe"),
      }),
      /selected packaged Token executable does not exist/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
