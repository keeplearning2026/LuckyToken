import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceRoot = path.join(repositoryRoot, "src");
const anthropicRoot = path.join(sourceRoot, "protocols", "anthropic");
const responsesRoot = path.join(sourceRoot, "protocols", "openai-responses");
const commandCodeRoot = path.join(
  repositoryRoot,
  "packages",
  "provider-commandcode-private",
  "src",
);

const CLIENT_SHARED_SEAMS = new Set([
  "auth.ts",
  "execution.ts",
  "http.ts",
  "model-resolution.ts",
  "invocation-diagnostics/index.ts",
  "protocols/options.ts",
  // Ticket 15 neutral data-plane seams: both Client Protocols resolve
  // aliases and project passthrough bodies through these narrow shared
  // modules; neither imports concrete Providers or protocol modules
  // (alias-model-seam.ts is Pi/core-only, sse-lines.ts is import-free).
  "alias-model-seam.ts",
  "protocols/sse-lines.ts",
  // Ticket 18 neutral handler seam: both Client Protocols observe the
  // Request Lifecycle Ledger only through this narrow seam (observer
  // contract + safe no-op); persistence/configuration/store DTOs stay out
  // of the protocol boundary.
  "request-ledger/handler-seam.ts",
  // Ticket 22 neutral handler seam: both Client Protocols observe the one
  // global Deep Diagnostics capture decision only through this narrow seam
  // (authority contract + safe no-op); persistence/configuration/store
  // DTOs stay out of the protocol boundary.
  "deep-diagnostics/handler-seam.ts",
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

test("the private CommandCode Provider never imports concrete Client Protocols", async () => {
  for (const entry of await inspect(commandCodeRoot)) {
    if (!entry.specifier.startsWith(".")) {
      assert.ok(
        entry.specifier === "@earendil-works/pi-ai" ||
          entry.specifier === "@luckytoken/provider-contract/package" ||
          entry.specifier === "@luckytoken/provider-contract/diagnostics" ||
          entry.specifier === "@sindresorhus/slugify" ||
          entry.specifier.startsWith("node:"),
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
    if (target.startsWith(`${commandCodeRoot}${path.sep}`)) continue;
    assert.fail(
      `${slash(path.relative(repositoryRoot, entry.file))} imports outside its package: ${slash(path.relative(repositoryRoot, target))}`,
    );
  }
});
