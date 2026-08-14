import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Ticket 19 architecture certification: the Responses passthrough profile is
 * fully independent of the Anthropic passthrough profile. The two native
 * passthrough modules must not share a classifier, config type, renderer,
 * header policy, or conformance test.
 */

describe("19: Responses passthrough architecture isolation", () => {
  it("imports no Anthropic passthrough module from the Responses passthrough module", async () => {
    const source = await readFile(
      "src/protocols/openai-responses/passthrough.ts",
      "utf8",
    );
    expect(source).not.toMatch(/protocols[\\/]anthropic/u);
    expect(source).not.toMatch(/anthropic-messages/u);
    expect(source).not.toMatch(/anthropic-pass/u);
  });

  it("imports no Anthropic passthrough module from the Responses handler", async () => {
    const source = await readFile(
      "src/protocols/openai-responses/handler.ts",
      "utf8",
    );
    expect(source).not.toMatch(/protocols[\\/]anthropic/u);
    expect(source).not.toMatch(/anthropic-messages/u);
    expect(source).not.toMatch(/anthropic-pass/u);
  });

  it("keeps the passthrough classifier Responses-owned (declared wire compatibility)", async () => {
    const source = await readFile(
      "src/protocols/openai-responses/passthrough.ts",
      "utf8",
    );
    // The selection rule is the Responses wire protocol declaration, not a
    // concrete Provider name or an Anthropic term.
    expect(source).toContain('"openai-responses"');
    expect(source).not.toContain("anthropic-messages");
  });

  it("imports no Anthropic passthrough config or renderer module", async () => {
    // The architecture test proves isolation across the whole Responses
    // module: configuration (config type), SSE renderer, and error renderer
    // must not import or name the Anthropic profile.
    for (const file of [
      "src/protocols/openai-responses/configuration.ts",
      "src/protocols/openai-responses/sse.ts",
      "src/protocols/openai-responses/error-rendering.ts",
    ]) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(/protocols[\\/]anthropic/u);
      expect(source).not.toMatch(/anthropic-messages/u);
      expect(source).not.toMatch(/anthropic-pass/u);
    }
  });

  it("does not share conformance tests with the Anthropic passthrough profile", async () => {
    const responsesTests = await readFile(
      "test/unit/openai-responses-passthrough-contract.test.ts",
      "utf8",
    );
    // No import path may reference the Anthropic protocol tree.
    expect(responsesTests).not.toMatch(
      /from\s+["'].*protocols[\\/]anthropic/u,
    );
    expect(responsesTests).not.toMatch(/from\s+["'].*anthropic-messages/u);
  });
});
