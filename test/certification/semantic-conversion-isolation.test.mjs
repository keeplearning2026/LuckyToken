import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { findStaticDependencyViolations } from "./static-dependency-graph.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function display(target) {
  return path.relative(repositoryRoot, target).split(path.sep).join("/");
}

async function sourceFiles(target) {
  const resolved = path.resolve(target);
  if ((await stat(resolved)).isFile()) return [resolved];
  const entries = await readdir(resolved, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function assertNoDependency(input) {
  const violations = await findStaticDependencyViolations({
    repositoryRoot,
    entries: (await Promise.all(input.entries.map(sourceFiles))).flat(),
    forbidden: ({ resolved }) => resolved !== undefined && input.forbidden(display(resolved)),
  });
  assert.deepEqual(
    violations,
    [],
    violations.map((entry) => entry.chain.join(" -> ")).join("\n"),
  );
}

test("Anthropic semantic conversion imports no OpenAI Responses or shared conversion module", async () => {
  await assertNoDependency({
    entries: [path.join(repositoryRoot, "src/protocols/anthropic/semantic")],
    forbidden: (dependency) =>
      dependency.startsWith("src/protocols/openai-responses/") ||
      dependency.startsWith("src/semantic-conversion/"),
  });
});

test("OpenAI Responses semantic conversion has no Anthropic semantic dependency", async () => {
  await assertNoDependency({
    entries: [path.join(repositoryRoot, "src/protocols/openai-responses")],
    forbidden: (dependency) =>
      dependency.startsWith("src/protocols/anthropic/semantic/") ||
      dependency.startsWith("src/semantic-conversion/"),
  });
});

test("native preservation lanes have no Anthropic semantic-conversion dependency", async () => {
  await assertNoDependency({
    entries: [
      path.join(repositoryRoot, "src/provider-native-anthropic"),
      path.join(repositoryRoot, "src/provider-native-responses"),
      path.join(repositoryRoot, "src/codex-native-seam.ts"),
    ],
    forbidden: (dependency) =>
      dependency.startsWith("src/protocols/anthropic/semantic/"),
  });
});

test("Anthropic online certification has independent Provider-owned policies and Claude-only Agent entry points", async () => {
  const harness = await readFile(
    path.join(repositoryRoot, "test/online/run-anthropic-messages.ts"),
    "utf8",
  );
  assert.doesNotMatch(harness, /run-openai-responses|run-codex-cli|RequestJourney/u);
  for (const policyMarker of [
    "json-basic-final-wire",
    "sse-lifecycle",
    "complete-history-reasoning-replay",
    "tool-choice",
    "structured",
    "reasoning",
    "stop",
    "process.stdout.write",
    "process.exitCode",
  ]) {
    assert.doesNotMatch(harness, new RegExp(policyMarker.replaceAll(".", "\\."), "u"));
  }

  const entries = new Map();
  for (const provider of ["commandcode-private", "commandcode-goat", "opencode-go"]) {
    const entry = await readFile(
      path.join(repositoryRoot, `test/online/run-${provider}-anthropic.ts`),
      "utf8",
    );
    entries.set(provider, entry);
    assert.doesNotMatch(entry, /runAnthropicMessagesOnlineSuite/u);
    assert.match(entry, /createAnthropicOnlineHarness/u);
    for (const policyMarker of [
      "json-basic-final-wire",
      "sse-lifecycle",
      "complete-history-reasoning-replay",
      "tool-choice",
      "structured",
      "reasoning",
      "stop",
      "process.stdout.write",
      "process.exitCode",
    ]) {
      assert.match(entry, new RegExp(policyMarker.replaceAll(".", "\\."), "u"));
    }
    assert.doesNotMatch(entry, /runOpenAIResponsesOnlineSuite|runClaudeCliOnlineSuite/u);
  }
  assert.match(entries.get("commandcode-private"), /tool-choice-degraded-fallbacks/u);
  assert.match(entries.get("commandcode-private"), /structured-output-guidance-fallback/u);
  assert.match(entries.get("commandcode-private"), /reasoning-activation-degraded-fallbacks/u);
  assert.match(entries.get("commandcode-private"), /stop-sequence-omitted/u);

  assert.match(entries.get("commandcode-goat"), /tool-choice-auto-serial/u);
  assert.match(entries.get("commandcode-goat"), /forced-tool-choice-automatic-fallback/u);
  assert.match(entries.get("commandcode-goat"), /stop-and-structured-output/u);
  assert.match(entries.get("commandcode-goat"), /reasoning-activation-degraded-fallbacks/u);
  assert.match(entries.get("commandcode-goat"), /assertItemExtensionV1/u);

  assert.match(entries.get("opencode-go"), /tool-choice-required-any/u);
  assert.match(entries.get("opencode-go"), /tool-choice-named-serial/u);
  assert.match(entries.get("opencode-go"), /tool-choice-none/u);
  assert.match(entries.get("opencode-go"), /stop-and-structured-output/u);
  assert.match(entries.get("opencode-go"), /reasoning-disabled/u);
  assert.match(entries.get("opencode-go"), /reasoning-activation-degraded-fallbacks/u);
  assert.match(entries.get("opencode-go"), /assertItemExtensionV1/u);

  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  for (const provider of ["private", "goat", "opencode-go"]) {
    assert.match(
      packageJson.scripts[`test:online-claude:${provider}:inner`],
      /run-claude-cli\.ts/u,
    );
    assert.doesNotMatch(
      packageJson.scripts[`test:online-claude:${provider}:inner`],
      /run-codex-cli\.ts/u,
    );
  }
});
