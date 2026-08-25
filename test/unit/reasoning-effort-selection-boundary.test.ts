import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
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

describe("reasoning effort selection boundary", () => {
  it("keeps model-dependent effort selection out of Client Wire conversion", async () => {
    for (const filename of [
      resolve("src/protocols/openai-responses/request.ts"),
      resolve("src/protocols/anthropic/request.ts"),
    ]) {
      const source = await readFile(filename, "utf8");
      expect(source, filename).not.toMatch(/clampThinkingLevel|getSupportedThinkingLevels/u);
      expect(source, filename).not.toMatch(/options\.reasoning\s*=/u);
    }
  });

  it("keeps level discovery, ordering, and fallback out of target projection", async () => {
    const sources = (
      await Promise.all([
        typescriptSources(resolve("src/protocols/openai-responses/semantic/reasoning/adapters")),
        typescriptSources(resolve("src/protocols/anthropic/semantic/projection")),
      ])
    ).flat();

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
