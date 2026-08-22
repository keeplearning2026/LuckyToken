import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function declaredProviders(text, constantName) {
  const match = new RegExp(
    `const ${constantName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`,
    "u",
  ).exec(text);
  assert.ok(match, `${constantName} must remain an explicit closed contract`);
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
}

test("Provider Native Responses claims only its certified provider/api tuples", async () => {
  const implementation = await source("src/provider-native-responses/index.ts");
  const fixtures = await source("test/unit/responses-native-provider-sender.test.ts");
  const contract = await source("test/unit/openai-responses-passthrough-contract.test.ts");
  const providers = declaredProviders(
    implementation,
    "CERTIFIED_OPENAI_RESPONSES_PROVIDERS",
  );

  assert.deepEqual(providers, [
    "openai",
    "xai",
    "opencode",
    "opencode-go",
    "cloudflare-ai-gateway",
    "github-copilot",
  ]);
  for (const providerId of providers) {
    assert.match(
      fixtures,
      new RegExp(`"${providerId}"`, "u"),
      `${providerId}/openai-responses needs a reviewed sender fixture`,
    );
  }
  assert.match(implementation, /model\.provider === "openai-codex"/u);
  assert.match(implementation, /model\.provider === "azure-openai-responses"/u);
  assert.match(contract, /custom-provider[\s\S]*?toBe\(false\)/u);
});

test("Anthropic Provider Native claims only reviewed first-party, Copilot, and Cloudflare tuples", async () => {
  const implementation = await source("src/provider-native-anthropic/transport.ts");
  const laneFixtures = await source("test/integration/anthropic-provider-native.test.ts");
  const cloudflareFixtures = await source(
    "test/unit/client-protocol-request-model-seam.test.ts",
  );
  const providers = declaredProviders(
    implementation,
    "CERTIFIED_ANTHROPIC_NATIVE_PROVIDERS",
  );

  assert.deepEqual(providers, [
    "anthropic",
    "github-copilot",
    "cloudflare-ai-gateway",
  ]);
  assert.match(laneFixtures, /provider: "anthropic"/u);
  assert.match(laneFixtures, /provider: "github-copilot"/u);
  assert.match(cloudflareFixtures, /provider: "cloudflare-ai-gateway"/u);
  assert.match(laneFixtures, /provider: "unrelated-vendor"[\s\S]*?toBe\(false\)/u);
  assert.match(laneFixtures, /fixedManagedProfileBindings\("api_key"\)/u);
  assert.match(laneFixtures, /fixedManagedProfileBindings\("oauth"\)/u);
});
