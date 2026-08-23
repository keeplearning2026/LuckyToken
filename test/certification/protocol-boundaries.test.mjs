import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceRoot = path.join(repositoryRoot, "src");
const anthropicRoot = path.join(sourceRoot, "protocols", "anthropic");
const responsesRoot = path.join(sourceRoot, "protocols", "openai-responses");
const commandCodePrivateRoot = path.join(
  repositoryRoot,
  "packages",
  "provider-commandcode-private",
  "src",
);
const commandCodeGoatRoot = path.join(
  repositoryRoot,
  "packages",
  "provider-commandcode-goat",
  "src",
);
const commandCodeCatalogRoot = path.join(
  repositoryRoot,
  "packages",
  "commandcode-model-catalog",
  "src",
);

const CLIENT_SHARED_SEAMS = new Set([
  "request-identity.ts",
  "execution.ts",
  "http.ts",
  "model-resolution.ts",
  // Request Journey observation is a protocol-neutral, synchronous no-throw
  // vocabulary only. Persistence, Worker, query, and configuration modules
  // remain outside both Client Protocol boundaries.
  "diagnostics/contract.ts",
  // Secret-free request-local Profile attribution facts. This narrow seam
  // exposes no credential values, resolution, storage, or transport authority.
  "credentials/activity.ts",
  "protocols/options.ts",
  // Public Model resolution is a narrow Pi/core-only data-plane seam shared
  // by both Client Protocols; it does not import Provider implementations or
  // sibling protocol modules. SSE line parsing is likewise import-free.
  "public-model-seam.ts",
  "protocols/sse-lines.ts",
  // Provider Native is visible to the Responses protocol only as an
  // operation/claim contract. Credential resolution, request construction,
  // and transport implementations remain outside the Client Protocol tree.
  "provider-native-responses/contract.ts",
  // Semantic Conversion exposes one LuckyToken-owned Invocation contract,
  // protocol-neutral reasoning/supplement contracts, response continuity
  // extraction, and the wrapper execution entry. Client Protocols still
  // cannot import Provider projectors, registries, payload types, or Pi
  // Provider implementations.
  "semantic-conversion/contract.ts",
  "semantic-conversion/reasoning/contract.ts",
  "semantic-conversion/reasoning/response.ts",
  "semantic-conversion/supplement/contract.ts",
  "semantic-conversion/execution.ts",
  // Ticket 18 neutral handler seam: both Client Protocols observe the
  // Request Lifecycle Ledger only through this narrow seam (observer
  // contract + safe no-op); persistence/configuration/store DTOs stay out
  // of the protocol boundary.
]);

function slash(value) {
  return value.split(path.sep).join("/");
}

async function sourceFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function moduleSpecifiers(source, file) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      result.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return result;
}

function resolveRelative(sourceFile, specifier) {
  const resolved = path.resolve(path.dirname(sourceFile), specifier);
  return resolved.replace(/\.js$/u, ".ts");
}

async function inspect(root) {
  const imports = [];
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    for (const specifier of moduleSpecifiers(source, file)) {
      imports.push({ file, specifier });
    }
  }
  return imports;
}

function assertClosedProtocol(imports, ownRoot, siblingRoot) {
  for (const entry of imports) {
    if (!entry.specifier.startsWith(".")) {
      assert.ok(
        entry.specifier === "@earendil-works/pi-ai" ||
          entry.specifier === "@luckytoken/provider-contract/diagnostics" ||
          entry.specifier === "@luckytoken/provider-contract/usage" ||
          entry.specifier.startsWith("node:"),
        `${slash(path.relative(repositoryRoot, entry.file))} imports non-Pi package ${entry.specifier}`,
      );
      continue;
    }
    const target = resolveRelative(entry.file, entry.specifier);
    assert.ok(
      !target.startsWith(`${siblingRoot}${path.sep}`),
      `${slash(path.relative(repositoryRoot, entry.file))} imports sibling Client Protocol ${slash(path.relative(repositoryRoot, target))}`,
    );
    if (target.startsWith(`${ownRoot}${path.sep}`)) continue;
    const shared = slash(path.relative(sourceRoot, target));
    assert.ok(
      CLIENT_SHARED_SEAMS.has(shared),
      `${slash(path.relative(repositoryRoot, entry.file))} uses unclassified shared seam ${shared}`,
    );
  }
}

test("Client Protocols import only their own modules, Pi, Node, and narrow neutral seams", async () => {
  const [anthropic, responses] = await Promise.all([
    inspect(anthropicRoot),
    inspect(responsesRoot),
  ]);
  assertClosedProtocol(anthropic, anthropicRoot, responsesRoot);
  assertClosedProtocol(responses, responsesRoot, anthropicRoot);
});

async function assertClosedProvider(root, allowedPackages) {
  for (const entry of await inspect(root)) {
    if (!entry.specifier.startsWith(".")) {
      assert.ok(
        allowedPackages.has(entry.specifier) || entry.specifier.startsWith("node:"),
        `${slash(path.relative(repositoryRoot, entry.file))} imports unclassified package ${entry.specifier}`,
      );
      continue;
    }
    const target = resolveRelative(entry.file, entry.specifier);
    assert.ok(
      !target.startsWith(`${anthropicRoot}${path.sep}`) &&
        !target.startsWith(`${responsesRoot}${path.sep}`),
      `${slash(path.relative(repositoryRoot, entry.file))} imports a concrete Client Protocol`,
    );
    if (target.startsWith(`${root}${path.sep}`)) continue;
    assert.fail(
      `${slash(path.relative(repositoryRoot, entry.file))} imports outside its package: ${slash(path.relative(repositoryRoot, target))}`,
    );
  }
}

test("CommandCode Providers never import concrete Client Protocols or one another", async () => {
  await assertClosedProvider(
    commandCodePrivateRoot,
    new Set([
      "@earendil-works/pi-ai",
      "@luckytoken/commandcode-model-catalog",
      "@luckytoken/provider-contract/package",
      "@luckytoken/provider-contract/diagnostics",
      "@sindresorhus/slugify",
    ]),
  );
  await assertClosedProvider(
    commandCodeGoatRoot,
    new Set([
      "@earendil-works/pi-ai",
      "@earendil-works/pi-ai/api/openai-completions.lazy",
      "@luckytoken/commandcode-model-catalog",
      "@luckytoken/provider-contract/package",
      "@luckytoken/provider-contract/diagnostics",
    ]),
  );
});

test("the shared CommandCode model catalog imports no concrete Provider", async () => {
  await assertClosedProvider(
    commandCodeCatalogRoot,
    new Set(["@earendil-works/pi-ai"]),
  );
});
