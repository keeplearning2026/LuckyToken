import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import type { AgentInjectionSnapshot } from "../../src/integrations/agents/snapshot.js";
import { createDshIntegrationAdapter } from "../../src/integrations/dsh/adapter.js";

const snapshot: AgentInjectionSnapshot = {
  endpoint: { origin: "http://127.0.0.1:4317", openaiBaseUrl: "http://127.0.0.1:4317/v1" },
  favorite: [{
    alias: "provider/favorite",
    target: { providerId: "provider", modelId: "favorite" },
    reasoning: false,
    thinkingLevels: [],
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  }],
  full: [],
  warnings: [],
};

function provider(raw: string): unknown {
  const parsed = parseDocument(raw).toJS() as { config?: unknown }[];
  const row = parsed.find((entry) => (entry as { id?: string }).id === "llm-pi-ai") as {
    config: { providers: Record<string, unknown> };
  } | undefined;
  return row?.config.providers.Token;
}

describe("DeepSeek Harness integration adapter", () => {
  it("owns only its provider and env entry while preserving other config and comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-"));
    try {
      const profileDir = join(root, "dsh", "profiles", "web");
      const patchPath = join(profileDir, "cordis.patch.yml");
      const envPath = join(root, "dsh", ".env");
      await mkdir(profileDir, { recursive: true });
      await writeFile(patchPath, `- id: llm-pi-ai
  config:
    # User setting
    retry: 3
    providers:
      other:
        api: anthropic-messages
- id: agent-default-model
  config:
    provider: other
    model: native
`, "utf8");
      await writeFile(envPath, "OTHER_KEY=user-value\n", "utf8");
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "web", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: [...snapshot.favorite, {
        ...snapshot.favorite[0]!, alias: "provider/full-only",
      }] };
      expect((await adapter.inject(selected, "favorite")).observedState).toBe("managed");
      let patch = await readFile(patchPath, "utf8");
      expect(patch).toContain("# User setting");
      expect(patch).toContain("# Token managed");
      expect(patch).toContain("agent-default-model");
      expect(provider(patch)).toMatchObject({
        api: "openai-responses",
        apiKeyEnv: "TOKEN_API_KEY",
        baseURL: "http://127.0.0.1:4317/v1",
        models: [{ id: "provider/favorite", input: ["text", "image"] }],
      });
      expect(await readFile(envPath, "utf8")).toContain("TOKEN_API_KEY=token-local");
      expect((await adapter.inject(selected, "full")).modelCount).toBe(2);
      patch = await readFile(patchPath, "utf8");
      expect((provider(patch) as { models: unknown[] }).models).toHaveLength(2);
      expect((await adapter.restore()).observedState).toBe("native");
      patch = await readFile(patchPath, "utf8");
      expect(provider(patch)).toBeUndefined();
      expect(patch).toContain("other:");
      expect(patch).toContain("agent-default-model");
      expect(await readFile(envPath, "utf8")).toBe("OTHER_KEY=user-value\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("overwrites an existing Token provider and env key, then deletes those owned keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-conflict-"));
    try {
      const profileDir = join(root, "dsh", "profiles", "web");
      await mkdir(profileDir, { recursive: true });
      const patchPath = join(profileDir, "cordis.patch.yml");
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "web", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      const userPatch = "- id: llm-pi-ai\n  config:\n    providers:\n      other: {api: anthropic-messages}\n      Token: {api: anthropic-messages}\n";
      await writeFile(patchPath, userPatch, "utf8");
      await writeFile(join(root, "dsh", ".env"), "TOKEN_API_KEY=user-secret\n", "utf8");
      expect((await adapter.inject(selected, "favorite")).observedState).toBe("managed");
      expect(provider(await readFile(patchPath, "utf8"))).toMatchObject({ api: "openai-responses" });
      expect(await readFile(join(root, "dsh", ".env"), "utf8")).toContain("token-local");
      expect((await adapter.restore()).observedState).toBe("native");
      const restored = await readFile(patchPath, "utf8");
      expect(provider(restored)).toBeUndefined();
      expect(restored).toContain("other:");
      expect(await readFile(join(root, "dsh", ".env"), "utf8")).not.toContain("TOKEN_API_KEY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates and removes its row in an initialized profile without another pi-ai override", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-empty-"));
    try {
      const profileDir = join(root, "dsh", "profiles", "web");
      const patchPath = join(profileDir, "cordis.patch.yml");
      await mkdir(profileDir, { recursive: true });
      await writeFile(patchPath, "[]\n", "utf8");
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "web", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      expect((await adapter.inject(selected, "favorite")).observedState).toBe("managed");
      expect(provider(await readFile(patchPath, "utf8"))).toMatchObject({ displayName: "Token" });
      expect((await adapter.restore()).observedState).toBe("native");
      expect(parseDocument(await readFile(patchPath, "utf8")).toJS()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a missing DSH profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-missing-"));
    try {
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "web", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      expect((await adapter.inject(selected, "favorite")).observedState).toBe("unavailable");
      await expect(readFile(join(root, "dsh", "profiles", "web", "cordis.patch.yml"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
