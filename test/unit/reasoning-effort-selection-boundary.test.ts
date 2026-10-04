import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

async function typescriptSources(directory: string): Promise<readonly {
  readonly filename: string;
  readonly source: string;
}[]> {
  const entries = await readdir(directory, { recursive: true });
  return Promise.all(
    entries
      .filter((entry) => entry.endsWith(".ts"))
      .map(async (entry) => {
        const filename = resolve(directory, entry);
        return { filename, source: await readFile(filename, "utf8") };
      }),
  );
}

/** The explicit Native max query may map a neutral level; ordinary Client
 * conversion still cannot prepare execution options or select by Model. */
function reasoningAssignmentsOutsideMax(source: string, allowedMaxName: string): readonly string[] {
  const file = ts.createSourceFile("request.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const visit = (node: ts.Node, inMax: boolean): void => {
    if (ts.isFunctionDeclaration(node)) inMax = node.name?.text === allowedMaxName;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = node.left;
      const reasoning = ts.isPropertyAccessExpression(left) ? left.name.text === "reasoning"
        : ts.isElementAccessExpression(left) && left.argumentExpression !== undefined
          && ts.isStringLiteral(left.argumentExpression) && left.argumentExpression.text === "reasoning";
      if (reasoning && (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))
        && ts.isIdentifier(left.expression) && left.expression.text === "options" && !inMax)
        violations.push(node.getText(file));
    }
    ts.forEachChild(node, (child) => visit(child, inMax));
  };
  visit(file, false);
  return violations;
}

describe("reasoning effort selection boundary", () => {
  it("keeps model-dependent effort selection out of Client Wire conversion", async () => {
    for (const [filename, maxName] of [
      [resolve("src/protocols/openai-responses/request.ts"), "convertResponsesMaxContext"],
      [resolve("src/protocols/anthropic/request.ts"), "convertAnthropicMaxContext"],
    ] as const) {
      const source = await readFile(filename, "utf8");
      expect(source, filename).not.toMatch(/clampThinkingLevel|getSupportedThinkingLevels/u);
      expect(reasoningAssignmentsOutsideMax(source, maxName), filename).toEqual([]);
    }
  });

  it("limits the exception to the named max function and catches both property spellings", () => {
    const source = `
      function convertResponsesMaxContext() { options.reasoning = "low"; }
      function ordinary() { options.reasoning = "high"; }
      function semantic() { options["reasoning"] = "medium"; }
      options.reasoning = "max";
    `;
    expect(reasoningAssignmentsOutsideMax(source, "convertResponsesMaxContext")).toEqual([
      'options.reasoning = "high"', 'options["reasoning"] = "medium"', 'options.reasoning = "max"',
    ]);
  });

  it("keeps level discovery, ordering, and fallback out of continuity codecs", async () => {
    const sources = await typescriptSources(
      resolve("src/protocols/openai-responses/semantic/reasoning/adapters"),
    );

    for (const { filename, source } of sources) {
      expect(source, filename).not.toMatch(
        /clampThinkingLevel|getSupportedThinkingLevels|resolve(?:Responses|Anthropic)EffortPlan/u,
      );
      expect(source, filename).not.toMatch(/THINKING_LEVELS|EFFORT_LEVEL_ORDER/u);
    }
  });

  it("owns the Pi selection helpers only in each protocol's preparation path", async () => {
    const responsesLevels = await readFile(
      resolve("src/protocols/openai-responses/semantic/reasoning/levels.ts"),
      "utf8",
    );
    const anthropicLevels = await readFile(
      resolve("src/protocols/anthropic/semantic/reasoning/levels.ts"),
      "utf8",
    );
    const responsesPreparation = await readFile(
      resolve("src/protocols/openai-responses/semantic/reasoning/request.ts"),
      "utf8",
    );
    const anthropicPreparation = await readFile(
      resolve("src/protocols/anthropic/semantic/reasoning/request.ts"),
      "utf8",
    );

    expect(responsesLevels).toMatch(/clampThinkingLevel/u);
    expect(responsesLevels).toMatch(/getSupportedThinkingLevels/u);
    expect(anthropicLevels).toMatch(/clampThinkingLevel/u);
    expect(anthropicLevels).toMatch(/getSupportedThinkingLevels/u);
    expect(responsesPreparation).toMatch(/resolveResponsesEffortPlan/u);
    expect(anthropicPreparation).toMatch(/resolveAnthropicEffortPlan/u);
  });
});
