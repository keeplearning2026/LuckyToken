import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { findStaticDependencyViolations } from "./static-dependency-graph.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const responsesRoot = path.join(
  repositoryRoot,
  "src",
  "protocols",
  "openai-responses",
);

async function responsesSourceFiles() {
  const entries = await readdir(responsesRoot, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

test("OpenAI Responses owns its Semantic Conversion implementation", async () => {
  const violations = await findStaticDependencyViolations({
    repositoryRoot,
    entries: await responsesSourceFiles(),
    forbidden: ({ resolved }) => {
      if (resolved === undefined) return false;
      const dependency = path
        .relative(repositoryRoot, resolved)
        .split(path.sep)
        .join("/");
      return (
        dependency.startsWith("src/semantic-conversion/") ||
        dependency.startsWith("src/protocols/anthropic/")
      );
    },
  });

  assert.deepEqual(
    violations,
    [],
    violations.map((entry) => entry.chain.join(" -> ")).join("\n"),
  );
});
