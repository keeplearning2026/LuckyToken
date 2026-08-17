import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readCodexNativeCatalogEntries } from "../../src/integrations/codex/native-catalog-source.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex native catalog source", () => {
  it("reads only bare native metadata rows from the Codex models cache", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "luckytoken-codex-catalog-source-"));
    roots.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "models_cache.json"),
      `${JSON.stringify({
        fetched_at: "2026-08-17T00:00:00Z",
        models: [
          {
            slug: "gpt-native",
            display_name: "GPT Native",
            model_messages: { instructions_template: "You are Codex Native." },
          },
          {
            slug: "anthropic/claude-opus",
            display_name: "Routed row",
          },
          { display_name: "Missing slug" },
          "not-an-object",
        ],
      })}\n`,
      "utf8",
    );

    const entries = await readCodexNativeCatalogEntries(codexHome);

    expect(entries).toEqual([
      {
        slug: "gpt-native",
        display_name: "GPT Native",
        model_messages: { instructions_template: "You are Codex Native." },
      },
    ]);
  });

  it("treats a missing Codex models cache as no native metadata", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "luckytoken-codex-catalog-missing-"));
    roots.push(codexHome);

    await expect(readCodexNativeCatalogEntries(codexHome)).resolves.toEqual([]);
  });
});
