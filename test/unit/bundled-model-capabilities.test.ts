import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMMANDCODE_MODEL_CATALOG_SCHEMA,
  DEFAULT_COMMANDCODE_MODEL_CATALOG,
} from "@token/commandcode-model-catalog";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBundledModelCapabilities,
  loadBundledProviderConfigurations,
} from "../../src/providers/bundled-configuration.js";

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "token-bundled-capabilities-"),
  );
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("bundled Provider Native model capabilities", () => {
  it("answers the catalog facts by Provider and model identity", () => {
    const capabilities = createBundledModelCapabilities(
      DEFAULT_COMMANDCODE_MODEL_CATALOG,
    );

    expect(
      capabilities.responsesStreamOptions(
        "commandcode-goat",
        "deepseek/deepseek-v4.1-flash",
      ),
    ).toBe("omit");
    expect(
      capabilities.responsesStreamOptions(
        "commandcode-private",
        "deepseek/deepseek-v4.1-flash",
      ),
    ).toBe("omit");
    expect(
      capabilities.responsesStreamOptions("commandcode-goat", "moonshotai/Kimi-K3"),
    ).toBe("preserve");
    expect(
      capabilities.responsesStreamOptions(
        "commandcode-goat",
        "stepfun/Step-3.5-Flash",
      ),
    ).toBeUndefined();
    expect(
      capabilities.responsesStreamOptions(
        "commandcode-goat",
        "unknown-model",
      ),
    ).toBeUndefined();
    expect(
      capabilities.responsesStreamOptions(
        "openai",
        "deepseek/deepseek-v4.1-flash",
      ),
    ).toBeUndefined();
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it("follows the loaded catalog snapshot instead of a built-in table", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "commandcode-models.json");
    await writeFile(
      path,
      JSON.stringify({
        schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
        models: [
          {
            id: "fixture-model",
            supportedEndpoints: ["/responses"],
            responsesStreamOptions: "omit",
            name: "Fixture",
            description: "loaded catalog fixture",
            input: ["text"],
            reasoning: false,
            contextWindow: 100_000,
            minimumPlan: "go",
          },
        ],
      }),
      "utf8",
    );

    const loaded = await loadBundledProviderConfigurations(path);

    expect(loaded.commandCodeCatalog.source).toBe("file");
    expect(
      loaded.modelCapabilities.responsesStreamOptions(
        "commandcode-goat",
        "fixture-model",
      ),
    ).toBe("omit");
    expect(
      loaded.modelCapabilities.responsesStreamOptions(
        "commandcode-goat",
        "deepseek/deepseek-v4.1-flash",
      ),
    ).toBeUndefined();
  });
});
