import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceRoot = path.join(repositoryRoot, "src");
const anthropicRoot = path.join(sourceRoot, "protocols", "anthropic");
const responsesRoot = path.join(sourceRoot, "protocols", "openai-responses");
const commandCodeRoot = path.join(sourceRoot, "providers", "commandcode-private");

const CLIENT_SHARED_SEAMS = new Set([
  "auth.ts",
  "execution.ts",
  "http.ts",
  "model-resolution.ts",
  "invocation-diagnostics/index.ts",
  "protocols/options.ts",
  "protocols/upstream-failure.ts",
]);
const PROVIDER_SHARED_SEAMS = new Set([
  "execution-facts.ts",
  "invocation-diagnostics/index.ts",
  "protocols/upstream-failure.ts",
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
    const shared = slash(path.relative(sourceRoot, target));
    assert.ok(
      PROVIDER_SHARED_SEAMS.has(shared),
      `${slash(path.relative(repositoryRoot, entry.file))} uses unclassified shared seam ${shared}`,
    );
  }
});
