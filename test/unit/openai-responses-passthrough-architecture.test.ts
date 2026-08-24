import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("OpenAI Responses three-lane architecture certification", () => {
  it("keeps Local Native independent from Provider Native, Pi IR, and Pi model identity", async () => {
    for (const file of [
      "src/codex-native-seam.ts",
      "src/codex-responses-passthrough.ts",
      "src/integrations/codex/local-responses.ts",
      "src/integrations/codex/local-compact.ts",
      "src/integrations/codex/native-catalog-source.ts",
    ]) {
      const text = await source(file);
      expect(text).not.toMatch(/alias-model-seam/u);
      expect(text).not.toMatch(/provider-native-responses/u);
      expect(text).not.toMatch(/openai-responses[\\/]semantic/u);
      expect(text).not.toMatch(/@earendil-works\/pi-ai/u);
      expect(text).not.toMatch(/builtinProviders|\bModels\b|streamSimple|executeSemanticResponses/u);
    }
  });

  it("keeps Provider Native independent from Local Native and Semantic conversion", async () => {
    for (const file of [
      "src/provider-native-responses/index.ts",
      "src/provider-native-responses/openai.ts",
      "src/provider-native-responses/codex.ts",
      "src/provider-native-responses/azure.ts",
      "src/provider-native-responses/common.ts",
      "src/provider-native-responses/contract.ts",
    ]) {
      const text = await source(file);
      expect(text).not.toMatch(/integrations[\\/]codex/u);
      expect(text).not.toMatch(/openai-responses[\\/]semantic/u);
      expect(text).not.toMatch(/convertResponsesRequest|streamSimple|Pi AI IR/u);
    }
  });

  it("keeps Semantic conversion independent from both Native transports", async () => {
    for (const file of [
      "src/credentials/profile-bound-pi-execution.ts",
      "src/protocols/openai-responses/semantic.ts",
      "src/protocols/openai-responses/compact-semantic.ts",
    ]) {
      const text = await source(file);
      expect(text).not.toMatch(/provider-native-responses/u);
      expect(text).not.toMatch(/integrations[\\/]codex/u);
      expect(text).not.toMatch(/codex-responses-passthrough/u);
      expect(text).not.toMatch(/passthroughResponsesRequest/u);
      expect(text).not.toMatch(/provider-native-anthropic/u);
    }
  });

  it("keeps Anthropic Provider Native and its OAuth projector independent from every other execution lane", async () => {
    for (const file of [
      "src/provider-native-anthropic/index.ts",
      "src/provider-native-anthropic/transport.ts",
      "src/provider-native-anthropic/body-projection.ts",
    ]) {
      const text = await source(file);
      expect(text).not.toMatch(/semantic-conversion/u);
      expect(text).not.toMatch(/provider-native-responses/u);
      expect(text).not.toMatch(/integrations[\\/]codex/u);
      expect(text).not.toMatch(/openai-responses[\\/]semantic/u);
      expect(text).not.toMatch(/streamSimple|Pi AI IR/u);
    }
    const projector = await source(
      "src/provider-native-anthropic/body-projection.ts",
    );
    expect(projector).not.toMatch(/@earendil-works\/pi-ai/u);
    expect(projector).not.toMatch(/credentials/u);
  });

  it("keeps the Responses handler as a lane selector instead of a concrete transport owner", async () => {
    const text = await source("src/protocols/openai-responses/handler.ts");
    expect(text).toContain("localNativeLane");
    expect(text).toContain("providerNativeLane");
    expect(text).toContain("executeSemanticResponses");
    expect(text).not.toMatch(/integrations[\\/]codex/u);
    expect(text).not.toMatch(/provider-native-responses[\\/](openai|codex|azure)/u);
    expect(text).not.toMatch(/github-copilot|cloudflare-ai-gateway|azure-openai-responses/u);
    expect(text).not.toMatch(/passthroughResponsesRequest/u);
  });

  it("keeps compact as the same three-lane selector without re-entering the full Responses handler", async () => {
    const text = await source("src/protocols/openai-responses/compact.ts");
    expect(text).toContain("localNativeLane");
    expect(text).toContain("providerNativeLane");
    expect(text).toContain("executeSemanticCompact");
    expect(text).not.toContain("executeSemanticResponses");
    expect(text).not.toMatch(/responsesHandler/u);
    expect(text).not.toMatch(/\.handle\(internalRequest/u);
    expect(text).not.toMatch(/integrations[\\/]codex/u);
    expect(text).not.toMatch(/github-copilot|cloudflare-ai-gateway|azure-openai-responses/u);
  });

  it("requires the Backend-owned Codex integration authority to supply Local Native identity", async () => {
    const text = await source("src/composition.ts");
    expect(text).not.toMatch(/createCodexNativeModelSource/u);
    expect(text).not.toMatch(/integrations[\\/]codex[\\/]native-models/u);
  });

  it("has no active production import of the retired generic native implementations", async () => {
    const files = [
      "src/protocols/openai-responses/handler.ts",
      "src/protocols/openai-responses/compact.ts",
      "src/composition.ts",
    ];
    for (const file of files) {
      const text = await source(file);
      expect(text).not.toMatch(/integrations[\\/]responses-native/u);
      expect(text).not.toMatch(/integrations[\\/]codex[\\/]compact/u);
      expect(text).not.toMatch(/openai-responses[\\/]passthrough/u);
    }
  });
});
