import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function staticImports(source: string, filename: string): readonly string[] {
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
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
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      imports.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return imports;
}

async function importsUnder(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { recursive: true });
  const sources = entries.filter((entry) => entry.endsWith(".ts"));
  return (
    await Promise.all(
      sources.map(async (entry) => {
        const filename = resolve(directory, entry);
        return staticImports(await readFile(filename, "utf8"), filename);
      }),
    )
  ).flat();
}

describe("Client Protocol import boundary", () => {
  it("prevents Anthropic and Responses from importing one another", async () => {
    const root = resolve("src/protocols");
    const anthropicImports = await importsUnder(resolve(root, "anthropic"));
    const responsesImports = await importsUnder(resolve(root, "openai-responses"));
    expect(
      anthropicImports.filter((entry) =>
        /protocols[\\/]openai-responses|\.\.\/(?:\.\.\/)*openai-responses/u.test(entry),
      ),
    ).toEqual([]);
    expect(
      responsesImports.filter((entry) =>
        /protocols[\\/]anthropic|\.\.\/[\w-]*anthropic/u.test(entry),
      ),
    ).toEqual([]);
  });
});
