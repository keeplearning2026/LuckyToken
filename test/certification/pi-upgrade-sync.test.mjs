import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { synchronizePiIdentity, synchronizePiManifests } from "../../scripts/upgrade-pi-runtime.mjs";

test("Pi synchronization updates all existing pins and SDKs without expanding unrelated packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "Token-pi-sync-"));
  try {
    await mkdir(join(root, "packages", "one"), { recursive: true });
    await mkdir(join(root, "packages", "two"), { recursive: true });
    const writeJson = (path, value) => writeFile(join(root, path), JSON.stringify(value));
    const pi = { version: "1.0.0", dependencies: { openai: "7.19.0", "@anthropic-ai/sdk": "0.124.0" } };
    await writeJson("package.json", { dependencies: { "@earendil-works/pi-ai": "0.87.0", openai: "6.0.0", "@anthropic-ai/sdk": "0.1.0" } });
    await writeJson("packages/one/package.json", { peerDependencies: { "@earendil-works/pi-ai": "0.87.0" } });
    await writeJson("packages/two/package.json", { dependencies: { unrelated: "2.0.0" } });
    const before = await readFile(join(root, "package.json"), "utf8");
    await assert.rejects(synchronizePiManifests(root, pi, true), /dependency declarations differ/u);
    assert.equal(await readFile(join(root, "package.json"), "utf8"), before);
    assert.equal(await synchronizePiManifests(root, pi), true);
    assert.deepEqual(JSON.parse(await readFile(join(root, "package.json"), "utf8")).dependencies, { "@earendil-works/pi-ai": "1.0.0", ...pi.dependencies });
    assert.equal(JSON.parse(await readFile(join(root, "packages/one/package.json"), "utf8")).peerDependencies["@earendil-works/pi-ai"], pi.version);
    assert.deepEqual(JSON.parse(await readFile(join(root, "packages/two/package.json"), "utf8")), { dependencies: { unrelated: "2.0.0" } });
    assert.equal(await synchronizePiManifests(root, pi, true), false);
    await assert.rejects(synchronizePiManifests(root, { ...pi, dependencies: { ...pi.dependencies, openai: "^7.19.0" } }), /exact openai version/u);
    await mkdir(join(root, "node_modules/@earendil-works/pi-ai/dist/api"), { recursive: true });
    await mkdir(join(root, "src/provider-native-anthropic"), { recursive: true });
    const adapter = join(root, "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js");
    await writeFile(adapter, 'const claudeCodeVersion = "2.1.280";');
    await synchronizePiIdentity(root);
    const identity = join(root, "src/provider-native-anthropic/pi-identity.ts");
    await writeFile(identity, (await readFile(identity, "utf8")).replaceAll("\n", "\r\n"));
    await synchronizePiIdentity(root, true);
    await writeFile(adapter, 'const identityMoved = "2.1.280";');
    await assert.rejects(synchronizePiIdentity(root), /identity source changed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all installed Pi and SDK instances match root declarations and lockfile", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const pi = JSON.parse(await readFile(new URL("node_modules/@earendil-works/pi-ai/package.json", root), "utf8"));
  assert.equal(pi.version, manifest.dependencies["@earendil-works/pi-ai"]);
  await synchronizePiManifests(fileURLToPath(root), pi, true);
  await synchronizePiIdentity(fileURLToPath(root), true);
  for (const [path, entry] of Object.entries(lock.packages)) {
    for (const name of ["@earendil-works/pi-ai", "openai", "@anthropic-ai/sdk"]) {
      if (path.endsWith(`node_modules/${name}`)) assert.equal(entry.version, manifest.dependencies[name], path);
    }
  }
});
