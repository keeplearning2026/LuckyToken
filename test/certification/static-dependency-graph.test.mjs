import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { findStaticDependencyViolations } from "./static-dependency-graph.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = path.join(
  repositoryRoot,
  "test",
  "certification",
  "fixtures",
  "static-dependency-graph",
);

test("static dependency closure reports type-only, re-export, and dynamic-import chains", async () => {
  const violations = await findStaticDependencyViolations({
    repositoryRoot,
    entries: [path.join(fixtureRoot, "entry.ts")],
    forbidden: (dependency) => dependency.specifier === "@forbidden/target",
  });

  assert.deepEqual(violations, [
    {
      specifier: "@forbidden/target",
      chain: [
        "test/certification/fixtures/static-dependency-graph/entry.ts",
        "test/certification/fixtures/static-dependency-graph/type-hop.ts",
        "test/certification/fixtures/static-dependency-graph/reexport-hop.ts",
        "@forbidden/target",
      ],
    },
  ]);
});

