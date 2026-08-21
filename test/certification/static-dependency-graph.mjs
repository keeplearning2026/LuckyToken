import { access, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function importsOf(source, filename) {
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return imports;
}

async function resolveLocalImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const unresolved = path.resolve(path.dirname(fromFile), specifier);
  const extension = path.extname(unresolved);
  const withoutRuntimeExtension = [".js", ".mjs", ".cjs"].includes(extension)
    ? unresolved.slice(0, -extension.length)
    : unresolved;
  const candidates = extension === ".ts" || extension === ".tsx"
    ? [unresolved]
    : [
        `${withoutRuntimeExtension}.ts`,
        `${withoutRuntimeExtension}.tsx`,
        path.join(withoutRuntimeExtension, "index.ts"),
        path.join(withoutRuntimeExtension, "index.tsx"),
      ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

function display(repositoryRoot, target) {
  return path.relative(repositoryRoot, target).split(path.sep).join("/");
}

/**
 * Walk the complete static TypeScript dependency closure from each entry.
 * Type-only imports carry architecture knowledge and are deliberately
 * indistinguishable from runtime imports here.
 */
export async function findStaticDependencyViolations(options) {
  const queue = options.entries.map((entry) => ({
    file: path.resolve(entry),
    chain: [path.resolve(entry)],
  }));
  const visited = new Set();
  const violations = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.file)) continue;
    visited.add(current.file);
    const source = await readFile(current.file, "utf8");
    for (const specifier of importsOf(source, current.file)) {
      const resolved = await resolveLocalImport(current.file, specifier);
      const dependency = Object.freeze({
        fromFile: current.file,
        specifier,
        ...(resolved === undefined ? {} : { resolved }),
      });
      if (options.forbidden(dependency)) {
        violations.push({
          specifier,
          chain: [
            ...current.chain.map((entry) => display(options.repositoryRoot, entry)),
            resolved === undefined
              ? specifier
              : display(options.repositoryRoot, resolved),
          ],
        });
        continue;
      }
      if (resolved !== undefined && !visited.has(resolved)) {
        queue.push({ file: resolved, chain: [...current.chain, resolved] });
      }
    }
  }

  return violations.sort((left, right) =>
    left.chain.join(" -> ").localeCompare(right.chain.join(" -> ")),
  );
}

