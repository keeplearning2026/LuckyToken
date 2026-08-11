import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadPiModelsConfig } from "../../src/pi/model-config.js";

describe("Pi models.json configuration", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("loads one immutable provider snapshot with Pi JSON comments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-"));
    directories.push(directory);
    const path = join(directory, "models.json");
    await writeFile(
      path,
      `{
        // Pi provider configuration
        "providers": {
          "commandcode-private": {
            "baseUrl": "https://api.commandcode.ai",
            "api": "commandcode-private",
            "models": [{
              "id": "deepseek/deepseek-v4-flash",
              "name": "deepseek/deepseek-v4-flash",
              "reasoning": false,
              "input": ["text"],
              "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
              "contextWindow": 200000,
              "maxTokens": 64000,
            }],
          },
        },
      }`,
      "utf8",
    );

    const config = await loadPiModelsConfig(path);
    const provider = config.getProvider("commandcode-private");

    expect(provider).toMatchObject({
      baseUrl: "https://api.commandcode.ai",
      api: "commandcode-private",
      models: [{ id: "deepseek/deepseek-v4-flash" }],
    });
    expect(config.getProviderIds()).toEqual(["commandcode-private"]);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(Object.isFrozen(provider?.models)).toBe(true);
    expect(Object.isFrozen(provider?.models?.[0])).toBe(true);
  });

  it("rejects unknown root fields instead of inventing a second config authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-"));
    directories.push(directory);
    const path = join(directory, "models.json");
    await writeFile(path, JSON.stringify({ providers: {}, commandCode: {} }), "utf8");

    await expect(loadPiModelsConfig(path)).rejects.toThrow("unknown field");
  });

  it.each(["apiKey", "oauth", "headers", "modelOverrides"])(
    "rejects unused Provider config field %s",
    async (field) => {
      const directory = await mkdtemp(join(tmpdir(), "luckytoken-models-"));
      directories.push(directory);
      const path = join(directory, "models.json");
      await writeFile(
        path,
        JSON.stringify({
          providers: {
            "commandcode-private": {
              [field]: {},
              models: [{ id: "model" }],
            },
          },
        }),
        "utf8",
      );

      await expect(loadPiModelsConfig(path)).rejects.toThrow("unknown field");
    },
  );
});
