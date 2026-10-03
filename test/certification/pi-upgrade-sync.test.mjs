import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { synchronizePiManifests } from "../../scripts/upgrade-pi-runtime.mjs";
import { renderPiNative, synchronizePiNative } from "../../scripts/sync-pi-native.mjs";

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
  await synchronizePiNative(fileURLToPath(root), true);
  for (const [path, entry] of Object.entries(lock.packages)) {
    for (const name of ["@earendil-works/pi-ai", "openai", "@anthropic-ai/sdk"]) {
      if (path.endsWith(`node_modules/${name}`)) assert.equal(entry.version, manifest.dependencies[name], path);
    }
  }
});

test("Native extraction rejects changed private seams and new dependencies before publication", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const source = await readFile(join(root, "node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js"), "utf8");
  await assert.rejects(renderPiNative(root, { "openai-responses": source.replace("function createClient(", "function renamedClient(") }), /missing createClient/u);
  await assert.rejects(renderPiNative(root, { "openai-responses": source.replace("model, context, apiKey, optionsHeaders, fetch, sessionId)", "model, context, apiKey, optionsHeaders, fetch, sessionId, newOption)") }), /signature changed/u);
  await assert.rejects(renderPiNative(root, { "openai-responses": source.replace("model, context, apiKey, optionsHeaders, fetch, sessionId)", "model, context, optionsHeaders, apiKey, fetch, sessionId)") }), /signature changed/u);
  await assert.rejects(renderPiNative(root, { "openai-responses": source.replace("model, context, apiKey, optionsHeaders, fetch, sessionId)", "model, context, apiKey, optionsHeaders, fetch, sessionId = 'new-default')") }), /signature changed/u);
  await assert.rejects(renderPiNative(root, { "openai-responses": source.replace("function createClient(", "async function createClient(") }), /signature changed/u);
  await assert.rejects(renderPiNative(root, { "openai-responses": source.replace("function createClient(", "function* createClient(") }), /signature changed/u);
  await assert.rejects(renderPiNative(root, { "openai-responses": source.replace('const headers = { "User-Agent": getPiUserAgent(), ...model.headers };', "const headers = ;") }), /upstream syntax/u);
  await assert.rejects(renderPiNative(root, { "openai-responses": source.replace('const headers = { "User-Agent": getPiUserAgent(), ...model.headers };', "const headers = newPrivateDependency(model);") }), /dependencies changed/u);
});

test("Native patches reject new semantics inside replaced or omitted regions", async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sources = {};
  for (const api of ["openai-responses", "anthropic-messages"]) sources[api] = await readFile(join(root, `node_modules/@earendil-works/pi-ai/dist/api/${api}.js`), "utf8");
  const cases = [
    ["Copilot extra header", "openai-responses", "Object.assign(headers, copilotHeaders);", 'Object.assign(headers, copilotHeaders); headers["x-new-wire-fact"] = "new";', /Copilot branch patch structure changed/u],
    ["Copilot changed vision semantics", "openai-responses", "const hasImages = hasCopilotVisionInput(context.messages);", "const hasImages = !hasCopilotVisionInput(context.messages);", /Copilot branch patch structure changed/u],
    ["Copilot changed declaration kind", "openai-responses", "const copilotHeaders = buildCopilotDynamicHeaders({", "let copilotHeaders = buildCopilotDynamicHeaders({", /Copilot branch patch structure changed/u],
    ["Copilot new branch", "openai-responses", "Object.assign(headers, copilotHeaders);", "Object.assign(headers, copilotHeaders); } else { headers.accept = 'new';", /Copilot branch patch structure changed/u],
    ["Copilot input collision", "openai-responses", 'const headers = { "User-Agent": getPiUserAgent(), ...model.headers };', 'const dynamicHeaders = {}; const headers = { "User-Agent": getPiUserAgent(), ...model.headers };', /patch input dynamicHeaders conflicts/u],
    ["federation extra header", "anthropic-messages", "const key = JSON.stringify([model.baseUrl, federation]);", 'defaultHeaders["x-federation"] = "new"; const key = JSON.stringify([model.baseUrl, federation]);', /federation branch patch structure changed/u],
    ["federation changed caching", "anthropic-messages", "const key = JSON.stringify([model.baseUrl, federation]);", "const key = JSON.stringify([model.id, model.baseUrl, federation]);", /federation branch patch structure changed/u],
    ["OAuth extra condition", "anthropic-messages", "if (apiKey && isOAuthToken(apiKey))", "if (apiKey && isOAuthToken(apiKey) && model.provider === 'anthropic')", /OAuth condition patch structure changed/u],
    ["OAuth input collision", "anthropic-messages", "// OAuth: Bearer auth, Claude Code identity headers", "const isOAuthCredential = false; // OAuth: Bearer auth, Claude Code identity headers", /patch input isOAuthCredential conflicts/u],
    ["tools changed extraction", "anthropic-messages", "return getCurrentTools(context.messages).length > 0 &&", "return getCurrentTools(context.messages.slice(1)).length > 0 &&", /tools predicate patch structure changed/u],
    ["tools extra decision", "anthropic-messages", "return getCurrentTools(context.messages).length > 0 &&", "return context.messages.length > 1 && getCurrentTools(context.messages).length > 0 &&", /tools predicate patch structure changed/u],
    ["beta changed tools call", "anthropic-messages", "if (shouldUseFineGrainedToolStreamingBeta(model, context))", "if (shouldUseFineGrainedToolStreamingBeta(model, context, options))", /beta tools call patch structure changed/u],
    ["beta new Context consumer", "anthropic-messages", "let configuredFeatures;", "let configuredFeatures; const extraFact = context.messages.length;", /beta Context reads changed/u],
    ["beta input collision", "anthropic-messages", "let configuredFeatures;", "let configuredFeatures; const hasTools = true;", /patch input hasTools conflicts/u],
  ];
  for (const [name, api, before, after, error] of cases) await t.test(name, async () => {
    assert.ok(sources[api].includes(before), `${name}: fixture must target actual upstream`);
    const changed = sources[api].replace(before, after);
    await assert.rejects(renderPiNative(root, { [api]: changed }), error);
  });
  // Failed rendering must leave every published artifact untouched.
  await synchronizePiNative(root, true);
});

test("Native patches accept formatting and copy untouched envelope evolution", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const source = await readFile(join(root, "node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js"), "utf8");
  const headers = 'const headers = { "User-Agent": getPiUserAgent(), ...model.headers };';
  const changed = source.replace(headers, `${headers}\nheaders["x-new-wire-fact"] = "adopted";`)
    .replace('if (model.provider === "github-copilot") {', "if ( model.provider === 'github-copilot' ) {")
    .replace("Object.assign(headers, copilotHeaders);", "/* upstream comment */ Object.assign( headers,\n copilotHeaders );");
  assert.notEqual(changed, source);
  const rendered = await renderPiNative(root, { "openai-responses": changed });
  const openai = rendered.get(join(root, "src/provider-native-responses/pi-openai.generated.ts"));
  assert.ok(openai.includes('headers["x-new-wire-fact"] = "adopted";'));
  assert.ok(openai.includes('if (model.provider === "github-copilot") Object.assign(headers, dynamicHeaders);'));
  assert.ok(!openai.includes("copilotHeaders"));
});
