import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

describe("Public Model data-plane architecture", () => {
  it("production composition and application have no Alias Registry authority path", async () => {
    const [composition, application] = await Promise.all([
      source("../../src/composition.ts"),
      source("../../src/application.ts"),
    ]);

    expect(composition).toContain("publicModelAuthority");
    expect(application).toContain("createPublicModelAuthority");
    expect(composition).not.toContain("aliasAuthority");
    expect(composition).not.toContain("AliasRegistryAuthority");
    expect(application).not.toContain("createAliasRegistryAuthority");
    expect(application).not.toContain("aliasCommandHandler");
    expect(application).not.toContain("aliasesProjection");
  });

  it("all client protocol model resolution uses only the Public Model seam", async () => {
    const files = await Promise.all([
      source("../../src/protocols/anthropic/handler.ts"),
      source("../../src/protocols/openai-responses/handler.ts"),
      source("../../src/protocols/openai-responses/compact.ts"),
      source("../../src/models-discovery.ts"),
    ]);

    for (const text of files) {
      expect(text).not.toContain("AliasModelSource");
      expect(text).not.toContain("alias-model-seam");
      expect(text).not.toContain("aliasSource");
    }
    expect(files[0]).toContain("resolveDataPlanePublicModel");
    expect(files[1]).toContain("resolveDataPlanePublicModel");
    expect(files[2]).toContain("resolveDataPlanePublicModel");
    expect(files[3]).toContain("publishedModels()");
  });
});
