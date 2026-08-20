import { describe, expect, it } from "vitest";

import type { Model, Models } from "@earendil-works/pi-ai";

import { createPublicModelAuthority } from "../../src/public-models/authority.js";
import { resolvePublicModel } from "../../src/public-model-seam.js";

const model = {
  provider: "anthropic",
  id: "claude/opus",
} as Model<string>;

describe("Public Model request seam", () => {
  it("resolves a configured alias even when that model is OFF for publication", async () => {
    const authority = createPublicModelAuthority({
      path: "C:\\app\\public-models.json",
      initialEndpoint: { host: "127.0.0.1", port: 3000 },
      fileSystem: {
        readFile: async () =>
          `${JSON.stringify({
            schemaVersion: 1,
            endpoint: { host: "127.0.0.1", port: 3000 },
            providers: {
              anthropic: {
                enabled: true,
                models: {
                  "anthropic/opus": {
                    target: "claude/opus",
                    enabled: false,
                  },
                },
              },
            },
          })}\n`,
        writeFile: async () => undefined,
        rename: async () => undefined,
        mkdir: async () => undefined,
        rm: async () => undefined,
      },
    });
    const state = await authority.reconcile({
      version: 1,
      providers: [
        { providerId: "anthropic", usable: true, models: ["claude/opus"] },
      ],
    });
    const models = {
      getModels: () => [model],
    } as Pick<Models, "getModels">;

    expect(resolvePublicModel(models, state.snapshot, "anthropic/opus")).toEqual({
      kind: "model",
      alias: "anthropic/opus",
      model,
    });
    expect(state.snapshot.publishedModels()).toEqual([]);
  });
});
