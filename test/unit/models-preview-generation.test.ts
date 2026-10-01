import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createModelsJsonAuthority } from "../../src/models-config/authority.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";

it("refreshes the edit preview for a new acquisition without changing the file revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "Token-preview-generation-"));
  try {
    const path = join(root, "models.json");
    await writeFile(path, '{"providers":{}}');
    let generation = "first";
    const authority = createModelsJsonAuthority({ path,
      compositionGeneration: () => generation,
      compose: () => composeEffectiveCatalog({ fixture: { api: "openai-completions", baseUrl: "https://example.invalid", models: [{ id: generation }] } }),
    });
    const before = await authority.query();
    generation = "second";
    const after = await authority.query();
    expect(after.catalog?.providers.find((provider) => provider.id === "fixture")?.models.map((model) => model.id)).toEqual(["second"]);
    expect(after.revision).toBe(before.revision);
    expect(after.raw).toBe(before.raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});
