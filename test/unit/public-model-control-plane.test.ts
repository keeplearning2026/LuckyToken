import { describe, expect, it } from "vitest";

import {
  createPublicModelAuthority,
  type PublicModelFileSystem,
} from "../../src/public-models/authority.js";
import { createPublicModelsControlPlaneHandler } from "../../src/public-models/control-plane.js";

function memoryFileSystem(): PublicModelFileSystem {
  const files = new Map<string, string>();
  return {
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      return value;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    rename: async (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error("missing temp file");
      files.delete(from);
      files.set(to, value);
    },
    mkdir: async () => undefined,
    rm: async (path) => {
      files.delete(path);
    },
  };
}

describe("Public Models Control Plane", () => {
  it("queries and mutates the one live PublicModelAuthority state", async () => {
    const authority = createPublicModelAuthority({
      path: "C:\\app\\public-models.json",
      initialEndpoint: { host: "127.0.0.1", port: 3000 },
      fileSystem: memoryFileSystem(),
    });
    await authority.reconcile({
      version: 1,
      providers: [
        { providerId: "anthropic", usable: true, models: ["claude/opus"] },
      ],
    });
    const handle = createPublicModelsControlPlaneHandler(authority);

    const queried = await handle({ command: "query" });
    expect(queried.outcome).toBe("ok");
    expect(queried.state.endpoint).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(queried.state.providers).toEqual([
      {
        providerId: "anthropic",
        on: true,
        favorite: false,
        models: [
          {
            alias: "anthropic/claude-opus",
            target: "claude/opus",
            on: true,
            favorite: false,
          },
        ],
      },
    ]);

    const changed = await handle({
      command: "set_model",
      revision: queried.state.revision,
      providerId: "anthropic",
      modelId: "claude/opus",
      on: false,
    });
    expect(changed.outcome).toBe("ok");
    expect(changed.state.providers[0]?.models[0]?.on).toBe(false);

    const favorited = await handle({
      command: "set_model_favorite",
      revision: changed.state.revision,
      providerId: "anthropic",
      modelId: "claude/opus",
      favorite: true,
    });
    expect(favorited.outcome).toBe("ok");
    expect(favorited.state.providers[0]?.models[0]?.favorite).toBe(true);
  });
});
