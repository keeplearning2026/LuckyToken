import type { Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createAgentInjectionSnapshot } from "../../src/integrations/agents/snapshot.js";
import {
  createPublicModelAuthority,
  type PublicModelFileSystem,
} from "../../src/public-models/authority.js";

function memoryFileSystem(): PublicModelFileSystem {
  const files = new Map<string, string>();
  return {
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    rename: async (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error("missing temp");
      files.delete(from);
      files.set(to, value);
    },
    mkdir: async () => undefined,
    rm: async (path) => {
      files.delete(path);
    },
  };
}

function model(id: string): Model<"anthropic-messages"> {
  return {
    id,
    name: id,
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
}

describe("Agent injection snapshot", () => {
  it("keeps Full published-only while Favorite includes a hidden favorite", async () => {
    const authority = createPublicModelAuthority({
      path: "C:\\app\\public-models.json",
      fileSystem: memoryFileSystem(),
      initialEndpoint: { host: "127.0.0.1", port: 3000 },
    });
    let state = await authority.reconcile({
      version: 1,
      providers: [
        {
          providerId: "anthropic",
          usable: true,
          models: ["claude-opus", "claude-sonnet"],
        },
      ],
    });
    state = (
      await authority.setModelOn({
        revision: state.revision,
        providerId: "anthropic",
        modelId: "claude-opus",
        on: false,
      })
    ).state;
    state = (
      await authority.setModelFavorite({
        revision: state.revision,
        providerId: "anthropic",
        modelId: "claude-opus",
        favorite: true,
      })
    ).state;
    const models: Pick<Models, "getModels"> = {
      getModels: () => [model("claude-opus"), model("claude-sonnet")],
    };

    const snapshot = createAgentInjectionSnapshot({
      publicModels: state.snapshot,
      models,
    });

    expect(snapshot.full.map((entry) => entry.alias)).toEqual([
      "anthropic/claude-sonnet",
    ]);
    expect(snapshot.favorite.map((entry) => entry.alias)).toEqual([
      "anthropic/claude-opus",
    ]);
  });
});
