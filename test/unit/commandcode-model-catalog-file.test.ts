import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMMANDCODE_MODEL_CATALOG_SCHEMA,
  loadCommandCodeModelCatalog,
  parseCommandCodeModelCatalogText,
  selectCommandCodeModelApi,
} from "@token/commandcode-model-catalog";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "token-commandcode-catalog-"));
  directories.push(directory);
  return directory;
}

function model(
  id: string,
  supportedEndpoints: readonly string[],
): Record<string, unknown> {
  return {
    id,
    name: id,
    description: `${id} fixture`,
    supportedEndpoints,
    input: ["text"],
    reasoning: false,
    contextWindow: 100_000,
    minimumPlan: "go",
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("CommandCode model catalog file authority", () => {
  it("selects one Pi API deterministically from supported endpoints", () => {
    const catalog = parseCommandCodeModelCatalogText(
      JSON.stringify({
        schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
        models: [
          model("messages-only", ["/messages"]),
          model("chat-only", ["/chat/completions"]),
          model("chat-and-responses", ["/chat/completions", "/responses"]),
        ],
      }),
      "fixture.json",
    );

    expect(selectCommandCodeModelApi(catalog.models[0]!)).toBe(
      "anthropic-messages",
    );
    expect(selectCommandCodeModelApi(catalog.models[1]!)).toBe(
      "openai-completions",
    );
    expect(selectCommandCodeModelApi(catalog.models[2]!)).toBe(
      "openai-responses",
    );
  });

  it("rejects an ambiguous Messages-plus-Responses endpoint combination", () => {
    expect(() =>
      parseCommandCodeModelCatalogText(
        JSON.stringify({
          schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
          models: [
            model("ambiguous", ["/messages", "/responses"]),
          ],
        }),
        "fixture.json",
      ),
    ).toThrow(/supportedEndpoints/u);
  });

  it("rejects unsupported reasoning effort mappings", () => {
    expect(() =>
      parseCommandCodeModelCatalogText(
        JSON.stringify({
          schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
          models: [{
            ...model("reasoning-invalid", ["/responses"]),
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: "bogus",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            },
          }],
        }),
        "fixture.json",
      ),
    ).toThrow(/supported reasoning effort/u);
  });

  it("rejects mapping explicit off to an upstream effort", () => {
    expect(() =>
      parseCommandCodeModelCatalogText(
        JSON.stringify({
          schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
          models: [{
            ...model("reasoning-off-invalid", ["/responses"]),
            reasoning: true,
            thinkingLevelMap: {
              off: "high",
              minimal: null,
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            },
          }],
        }),
        "fixture.json",
      ),
    ).toThrow(/\.off must be null/u);
  });

  it("seeds a missing user catalog and then reads user edits on the next startup", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "commandcode-models.json");

    const seeded = await loadCommandCodeModelCatalog(path);
    expect(seeded.source).toBe("seeded_default");
    expect(seeded.catalog.models.length).toBeGreaterThan(0);

    const seededDocument = JSON.parse(await readFile(path, "utf8")) as {
      schema?: unknown;
    };
    expect(seededDocument.schema).toBe(COMMANDCODE_MODEL_CATALOG_SCHEMA);

    await writeFile(
      path,
      JSON.stringify(
        {
          schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
          models: [model("user-updated", ["/chat/completions"])],
        },
        null,
        2,
      ),
      "utf8",
    );

    const restarted = await loadCommandCodeModelCatalog(path);
    expect(restarted.source).toBe("file");
    expect(restarted.catalog.models.map((entry) => entry.id)).toEqual([
      "user-updated",
    ]);
    expect(selectCommandCodeModelApi(restarted.catalog.models[0]!)).toBe(
      "openai-completions",
    );
  });

  it("falls back to the bundled default without overwriting an invalid user file", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "commandcode-models.json");
    await writeFile(path, "{not-json", "utf8");

    const result = await loadCommandCodeModelCatalog(path);

    expect(result.source).toBe("fallback_default");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.catalog.models.length).toBeGreaterThan(0);
    await expect(readFile(path, "utf8")).resolves.toBe("{not-json");
  });
});
