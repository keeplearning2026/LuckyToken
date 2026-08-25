import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type {
  AgentInjectionModel,
  AgentInjectionSnapshot,
} from "../../src/integrations/agents/snapshot.js";
import { createPiIntegrationAdapter } from "../../src/integrations/pi/adapter.js";
import { stripJsonComments } from "../../src/providers/models-json-schema.js";

function model(
  alias: string,
  thinkingLevels: readonly string[] = ["off", "low", "high", "xhigh"],
): AgentInjectionModel {
  return Object.freeze({
    alias,
    target: Object.freeze({ providerId: "anthropic", modelId: alias }),
    reasoning: true,
    thinkingLevels: Object.freeze([...thinkingLevels]),
    input: Object.freeze(["text", "image"] as const),
    cost: Object.freeze({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }),
    contextWindow: 200_000,
    maxTokens: 64_000,
  });
}

function snapshot(): AgentInjectionSnapshot {
  return Object.freeze({
    endpoint: Object.freeze({
      origin: "http://127.0.0.1:3000",
      openaiBaseUrl: "http://127.0.0.1:3000/v1",
    }),
    full: Object.freeze([model("full-only"), model("z-favorite"), model("a-favorite")]),
    favorite: Object.freeze([model("z-favorite"), model("a-favorite")]),
    warnings: Object.freeze([]),
  });
}

describe("Pi integration adapter", () => {
  it("fingerprints only the provider content produced for the selected scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-pi-fingerprint-"));
    const adapter = createPiIntegrationAdapter({
      agentDirectory: join(root, "pi-agent"),
      stateDirectory: join(root, "state"),
    });
    const first = snapshot();
    const changedFullOnly = Object.freeze({
      ...first,
      full: Object.freeze([...first.full, model("another-full-only")]),
    });
    const emptyAtAnotherEndpoint = Object.freeze({
      ...first,
      endpoint: Object.freeze({
        origin: "http://127.0.0.1:9999",
        openaiBaseUrl: "http://127.0.0.1:9999/v1",
      }),
      favorite: Object.freeze([]),
    });
    const emptyAtOriginalEndpoint = Object.freeze({
      ...first,
      favorite: Object.freeze([]),
    });

    await expect(adapter.projectionFingerprint(first, "favorite")).resolves.toBe(
      await adapter.projectionFingerprint(changedFullOnly, "favorite"),
    );
    await expect(adapter.projectionFingerprint(first, "full")).resolves.not.toBe(
      await adapter.projectionFingerprint(changedFullOnly, "full"),
    );
    await expect(
      adapter.projectionFingerprint(emptyAtOriginalEndpoint, "favorite"),
    ).resolves.toBe(
      await adapter.projectionFingerprint(emptyAtAnotherEndpoint, "favorite"),
    );
  });

  it("inserts only providers.Token into an existing JSONC document", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-pi-adapter-"));
    const agentDirectory = join(root, "pi-agent");
    const stateDirectory = join(root, "state");
    const modelsPath = join(agentDirectory, "models.json");
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      modelsPath,
      `{
  // This provider belongs to the user and must remain untouched.
  "providers": {
    "other": {
      "apiKey": "user-placeholder",
    },
  },
}
`,
      "utf8",
    );
    const adapter = createPiIntegrationAdapter({ agentDirectory, stateDirectory });

    const result = await adapter.inject(snapshot(), "favorite");

    expect(result).toMatchObject({
      observedState: "managed",
      modelCount: 2,
      changed: true,
    });
    const content = await readFile(modelsPath, "utf8");
    expect(content).toContain("// This provider belongs to the user");
    const parsed = JSON.parse(stripJsonComments(content)) as {
      providers: Record<string, unknown>;
    };
    expect(parsed.providers.other).toEqual({ apiKey: "user-placeholder" });
    expect(parsed.providers.Token).toEqual({
      name: "Token",
      baseUrl: "http://127.0.0.1:3000",
      apiKey: "Token-local",
      api: "anthropic-messages",
      compat: {
        forceAdaptiveThinking: true,
        supportsEagerToolInputStreaming: false,
        allowEmptySignature: true,
        sendSessionAffinityHeaders: true,
      },
      models: [
        {
          id: "a-favorite",
          name: "a-favorite",
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            medium: null,
            xhigh: "xhigh",
            max: null,
          },
          input: ["text", "image"],
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
        {
          id: "z-favorite",
          name: "z-favorite",
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            medium: null,
            xhigh: "xhigh",
            max: null,
          },
          input: ["text", "image"],
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
      ],
    });
  });

  it("restores by deleting the last injected provider and treats absence as success", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-pi-restore-"));
    const agentDirectory = join(root, "pi-agent");
    const stateDirectory = join(root, "state");
    const modelsPath = join(agentDirectory, "models.json");
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      modelsPath,
      `{
  // Preserve this comment and later user edits.
  "providers": {
    "other": { "apiKey": "before" },
  },
}
`,
      "utf8",
    );
    const adapter = createPiIntegrationAdapter({ agentDirectory, stateDirectory });
    await adapter.inject(snapshot(), "favorite");
    const injected = await readFile(modelsPath, "utf8");
    await writeFile(modelsPath, injected.replace('"before"', '"after"'), "utf8");

    const restored = await adapter.restore();
    const restoredAgain = await adapter.restore();

    expect(restored).toMatchObject({
      observedState: "native",
      modelCount: 0,
      changed: true,
    });
    expect(restoredAgain).toMatchObject({
      observedState: "native",
      modelCount: 0,
      changed: false,
    });
    const content = await readFile(modelsPath, "utf8");
    expect(content).toContain("// Preserve this comment and later user edits.");
    const parsed = JSON.parse(stripJsonComments(content)) as {
      providers: Record<string, unknown>;
    };
    expect(parsed.providers).toEqual({ other: { apiKey: "after" } });
  });

  it("does not delete a Token provider that no longer matches the last injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-pi-conflict-"));
    const agentDirectory = join(root, "pi-agent");
    const stateDirectory = join(root, "state");
    const modelsPath = join(agentDirectory, "models.json");
    const adapter = createPiIntegrationAdapter({ agentDirectory, stateDirectory });
    await adapter.inject(snapshot(), "favorite");
    const injected = await readFile(modelsPath, "utf8");
    const changed = injected.replace("http://127.0.0.1:3000", "http://user.example");
    await writeFile(modelsPath, changed, "utf8");

    const restored = await adapter.restore();

    expect(restored).toMatchObject({
      observedState: "conflict",
      changed: false,
    });
    expect(await readFile(modelsPath, "utf8")).toBe(changed);
  });

  it("does not claim or delete a pre-existing Token provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-pi-preexisting-"));
    const agentDirectory = join(root, "pi-agent");
    const stateDirectory = join(root, "state");
    const modelsPath = join(agentDirectory, "models.json");
    const original = `{
  "providers": {
    "Token": {
      "apiKey": "user-owned",
      "models": []
    }
  }
}\n`;
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(modelsPath, original, "utf8");
    const adapter = createPiIntegrationAdapter({ agentDirectory, stateDirectory });

    await expect(adapter.inject(snapshot(), "favorite")).resolves.toMatchObject({
      observedState: "conflict",
      changed: false,
    });
    await expect(adapter.restore()).resolves.toMatchObject({
      observedState: "conflict",
      changed: false,
    });
    expect(await readFile(modelsPath, "utf8")).toBe(original);
  });

  it("does not create models.json for an empty scope and removes an older injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-pi-empty-"));
    const agentDirectory = join(root, "pi-agent");
    const stateDirectory = join(root, "state");
    const modelsPath = join(agentDirectory, "models.json");
    const adapter = createPiIntegrationAdapter({ agentDirectory, stateDirectory });
    const emptyFavorite = Object.freeze({ ...snapshot(), favorite: Object.freeze([]) });

    const initiallyEmpty = await adapter.inject(emptyFavorite, "favorite");

    expect(initiallyEmpty).toMatchObject({
      observedState: "native",
      modelCount: 0,
      changed: false,
      message: "Pi is enabled in Favorite scope, but no model can be injected.",
    });
    await expect(readFile(modelsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await adapter.inject(snapshot(), "full");
    const emptied = await adapter.inject(emptyFavorite, "favorite");

    expect(emptied).toMatchObject({
      observedState: "native",
      modelCount: 0,
      changed: true,
      message: "Pi is enabled in Favorite scope, but no model can be injected.",
    });
    const content = await readFile(modelsPath, "utf8");
    const parsed = JSON.parse(stripJsonComments(content)) as {
      providers: Record<string, unknown>;
    };
    expect(parsed.providers.Token).toBeUndefined();
  });
});
