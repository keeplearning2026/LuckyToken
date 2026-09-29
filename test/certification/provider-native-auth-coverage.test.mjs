import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

/** Every provider literal in a closed Native certification table, in order. */
function declaredTableProviders(text) {
  const providers = [...text.matchAll(/provider: "([^"]+)"/gu)].map(
    (entry) => entry[1],
  );
  assert.ok(
    providers.length > 0,
    "Native certification data must remain an explicit closed contract",
  );
  return providers;
}

test("Provider Native Responses claims only its certified provider/api tuples", async () => {
  const implementation = await source("src/provider-native-responses/index.ts");
  const certification = await source(
    "src/provider-native-responses/certification.ts",
  );
  const fixtures = await source("test/unit/responses-native-provider-sender.test.ts");
  const contract = await source("test/unit/provider-native-responses-contract.test.ts");
  const providers = declaredTableProviders(certification);

  assert.deepEqual(providers, [
    "openai",
    "xai",
    "opencode",
    "opencode-go",
    "cloudflare-ai-gateway",
    "github-copilot",
    "commandcode-goat",
    "openai-codex",
    "azure-openai-responses",
  ]);
  for (const providerId of providers) {
    assert.match(
      fixtures,
      new RegExp(`"${providerId}"`, "u"),
      `${providerId}/openai-responses needs a reviewed sender fixture`,
    );
  }
  assert.match(certification, /api: "openai-codex-responses"/u);
  assert.match(certification, /api: "azure-openai-responses"/u);
  assert.match(certification, /authTypes: \["managed", "ambient"\]/u);
  assert.match(certification, /provider: "openai-codex"[\s\S]*?authTypes: \["managed"\]/u);
  assert.match(implementation, /certifiedResponsesTransport/u);
  assert.match(contract, /custom-provider[\s\S]*?toBe\(false\)/u);
});

test("Anthropic Provider Native claims only reviewed first-party, Copilot, and Cloudflare tuples", async () => {
  const implementation = await source(
    "src/provider-native-anthropic/certification.ts",
  );
  const laneFixtures = await source("test/integration/anthropic-provider-native.test.ts");
  const cloudflareFixtures = await source(
    "test/unit/client-protocol-request-model-seam.test.ts",
  );
  const providers = declaredTableProviders(implementation);

  assert.deepEqual(providers, [
    "anthropic",
    "github-copilot",
    "cloudflare-ai-gateway",
  ]);
  assert.match(laneFixtures, /provider: "anthropic"/u);
  assert.match(laneFixtures, /provider: "github-copilot"/u);
  assert.match(cloudflareFixtures, /provider: "cloudflare-ai-gateway"/u);
  assert.match(laneFixtures, /provider: "unrelated-vendor"[\s\S]*?toBe\(false\)/u);
  assert.match(
    implementation,
    /provider: "anthropic"[\s\S]*?authTypes: \["api_key", "oauth", "ambient"\]/u,
  );
  assert.match(
    implementation,
    /provider: "github-copilot"[\s\S]*?authTypes: \["github_copilot", "ambient"\]/u,
  );
  assert.match(
    implementation,
    /provider: "cloudflare-ai-gateway"[\s\S]*?authTypes: \["api_key", "ambient"\]/u,
  );
  assert.match(laneFixtures, /fixedManagedProfileBindings\("api_key"\)/u);
  assert.match(laneFixtures, /fixedManagedProfileBindings\("oauth"\)/u);
});
