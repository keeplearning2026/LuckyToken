import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createClaudeIntegrationAdapter } from "../../src/integrations/claude/adapter.js";
import type { AgentInjectionModel, AgentInjectionSnapshot } from "../../src/integrations/agents/snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function model(alias: string, contextWindow: number): AgentInjectionModel {
  return Object.freeze({
    alias,
    target: Object.freeze({ providerId: "commandcode-private", modelId: alias }),
    reasoning: true,
    thinkingLevels: Object.freeze(["low", "medium", "high"]),
    input: Object.freeze(["text"] as const),
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow,
    maxTokens: 64_000,
  });
}

function snapshot(origin = "http://127.0.0.1:3000"): AgentInjectionSnapshot {
  const models = Object.freeze([
    model("main-model", 200_000),
    model("opus-model", 1_000_000),
    model("sonnet-model", 999_999),
    model("haiku-model", 2_000_000),
    model("subagent-model", 200_000),
    model("misleading[1m]", 200_000),
  ]);
  return Object.freeze({
    endpoint: Object.freeze({
      origin,
      openaiBaseUrl: `${origin}/v1`,
    }),
    full: models,
    favorite: models,
    warnings: Object.freeze([]),
  });
}

async function fixture(settings?: string) {
  const root = await mkdtemp(join(tmpdir(), "Token-claude-integration-"));
  roots.push(root);
  const settingsPath = join(root, ".claude", "settings.json");
  const stateDirectory = join(root, "state");
  if (settings !== undefined) {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(settingsPath, settings, "utf8");
  }
  let selections = {
    main: "main-model",
    opus: "opus-model",
    sonnet: "sonnet-model",
    haiku: "haiku-model",
    subagent: "subagent-model",
  } as const;
  const aliases = new Set(snapshot().full.map((entry) => entry.alias));
  const adapter = createClaudeIntegrationAdapter({
    settingsPath,
    stateDirectory,
    selectedModels: () => selections,
    isPublicModelAlias: (alias) => aliases.has(alias),
  });
  return {
    adapter,
    settingsPath,
    setSelections(value: {
      readonly main: string | null;
      readonly opus: string | null;
      readonly sonnet: string | null;
      readonly haiku: string | null;
      readonly subagent: string | null;
    }) {
      selections = value as typeof selections;
    },
  };
}

function parsed(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("Claude Code integration adapter", () => {
  it("overwrites only the seven managed env values using independently selected Favorite models", async () => {
    const fx = await fixture(JSON.stringify({
      theme: "dark",
      env: {
        KEEP_ME: "yes",
        ANTHROPIC_AUTH_TOKEN: "user-token",
        ANTHROPIC_BASE_URL: "https://old.example",
        ANTHROPIC_MODEL: "old",
      },
    }, null, 2));

    const effect = await fx.adapter.inject(snapshot(), "favorite");
    const root = parsed(await readFile(fx.settingsPath, "utf8"));
    const env = root.env as Record<string, unknown>;

    expect(effect).toMatchObject({ observedState: "managed", modelCount: 5 });
    expect(root.theme).toBe("dark");
    expect(env.KEEP_ME).toBe("yes");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("token-local");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3000");
    expect(env.ANTHROPIC_MODEL).toBe("main-model");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus-model[1m]");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("sonnet-model");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("haiku-model[1m]");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("subagent-model");
    expect(root.model).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
  });

  it("requires every configured alias to still be a Favorite model", async () => {
    const original = '{"theme":"dark"}\n';
    const fx = await fixture(original);
    fx.setSelections({
      main: "main-model",
      opus: "missing-model",
      sonnet: "sonnet-model",
      haiku: "haiku-model",
      subagent: "subagent-model",
    });

    const effect = await fx.adapter.inject(snapshot(), "favorite");

    expect(effect.observedState).toBe("unavailable");
    expect(effect.message).toContain("missing-model");
    expect(await readFile(fx.settingsPath, "utf8")).toBe(original);
  });

  it("rejects a sub-1M alias that already carries Claude Code's [1m] suffix", async () => {
    const original = "{}\n";
    const fx = await fixture(original);
    fx.setSelections({
      main: "misleading[1m]",
      opus: "opus-model",
      sonnet: "sonnet-model",
      haiku: "haiku-model",
      subagent: "subagent-model",
    });

    const effect = await fx.adapter.inject(snapshot(), "favorite");

    expect(effect.observedState).toBe("unavailable");
    expect(effect.message).toContain("context window is below 1M");
    expect(await readFile(fx.settingsPath, "utf8")).toBe(original);
  });

  it("requires all five Claude model slots to be selected", async () => {
    const original = "{}\n";
    const fx = await fixture(original);
    fx.setSelections({
      main: "main-model",
      opus: "opus-model",
      sonnet: null,
      haiku: "haiku-model",
      subagent: "subagent-model",
    });

    const effect = await fx.adapter.inject(snapshot(), "favorite");

    expect(effect.observedState).toBe("unavailable");
    expect(effect.message).toContain("Sonnet");
    expect(await readFile(fx.settingsPath, "utf8")).toBe(original);
  });

  it("restore returns model slots to their recorded non-alias values and removes only originally absent slots", async () => {
    const fx = await fixture(JSON.stringify({
      env: {
        KEEP_ME: "yes",
        ANTHROPIC_AUTH_TOKEN: "user-token",
        ANTHROPIC_BASE_URL: "https://user.example",
        ANTHROPIC_MODEL: "claude-user-main",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-user-opus",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-user-haiku",
      },
      permissions: { defaultMode: "acceptEdits" },
    }, null, 2));
    await fx.adapter.inject(snapshot(), "favorite");

    const restored = await fx.adapter.restore();
    const root = parsed(await readFile(fx.settingsPath, "utf8"));
    const env = root.env as Record<string, unknown>;

    expect(restored).toMatchObject({ observedState: "native", modelCount: 0 });
    expect(env).toEqual({
      KEEP_ME: "yes",
      ANTHROPIC_AUTH_TOKEN: "user-token",
      ANTHROPIC_BASE_URL: "https://user.example",
      ANTHROPIC_MODEL: "claude-user-main",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-user-opus",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-user-haiku",
    });
    expect(root.permissions).toEqual({ defaultMode: "acceptEdits" });
  });

  it("sync does not replace recorded preimages when the current values are Token-owned", async () => {
    const fx = await fixture(JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://user.example",
        ANTHROPIC_AUTH_TOKEN: "user-token",
        ANTHROPIC_MODEL: "user-main",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "user-opus",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "user-sonnet",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "user-haiku",
        CLAUDE_CODE_SUBAGENT_MODEL: "user-subagent",
      },
    }, null, 2));

    await fx.adapter.inject(snapshot(), "favorite");
    const firstInjected = parsed(await readFile(fx.settingsPath, "utf8"))
      .env as Record<string, unknown>;
    const firstAuthToken = firstInjected.ANTHROPIC_AUTH_TOKEN;

    fx.setSelections({
      main: "sonnet-model",
      opus: "haiku-model",
      sonnet: "main-model",
      haiku: "opus-model",
      subagent: "sonnet-model",
    });
    await fx.adapter.inject(
      snapshot("http://127.0.0.1:4317"),
      "favorite",
    );
    const secondInjected = parsed(await readFile(fx.settingsPath, "utf8"))
      .env as Record<string, unknown>;
    expect(secondInjected.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4317");
    expect(secondInjected.ANTHROPIC_AUTH_TOKEN).toBe(firstAuthToken);

    await fx.adapter.restore();

    const env = parsed(await readFile(fx.settingsPath, "utf8")).env as Record<string, unknown>;
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://user.example",
      ANTHROPIC_AUTH_TOKEN: "user-token",
      ANTHROPIC_MODEL: "user-main",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "user-opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "user-sonnet",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "user-haiku",
      CLAUDE_CODE_SUBAGENT_MODEL: "user-subagent",
    });
  });

  it("records newer external URL, auth-token, and model edits seen during a later injection", async () => {
    const fx = await fixture(JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://original.example",
        ANTHROPIC_AUTH_TOKEN: "original-user-token",
        ANTHROPIC_MODEL: "original-user-main",
      },
    }, null, 2));
    await fx.adapter.inject(snapshot(), "favorite");

    const current = parsed(await readFile(fx.settingsPath, "utf8"));
    const env = current.env as Record<string, unknown>;
    env.ANTHROPIC_BASE_URL = "https://later.example";
    env.ANTHROPIC_AUTH_TOKEN = "later-user-token";
    env.ANTHROPIC_MODEL = "later-user-main";
    await writeFile(fx.settingsPath, JSON.stringify(current, null, 2), "utf8");

    await fx.adapter.inject(snapshot(), "favorite");
    await fx.adapter.restore();

    const restored = parsed(await readFile(fx.settingsPath, "utf8")).env as Record<string, unknown>;
    expect(restored.ANTHROPIC_BASE_URL).toBe("https://later.example");
    expect(restored.ANTHROPIC_AUTH_TOKEN).toBe("later-user-token");
    expect(restored.ANTHROPIC_MODEL).toBe("later-user-main");
  });

  it.each([
    "main-model",
    "opus-model[1m]",
  ])("does not record an existing Public Model alias projection as a restore value: %s", async (currentModel) => {
    const fx = await fixture(JSON.stringify({
      env: {
        ANTHROPIC_MODEL: currentModel,
      },
    }, null, 2));

    await fx.adapter.inject(snapshot(), "favorite");
    await fx.adapter.restore();

    const env = parsed(await readFile(fx.settingsPath, "utf8")).env as Record<string, unknown>;
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("does not record recognizable Token URL/auth residue as user restore values", async () => {
    const fx = await fixture(JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3000",
        ANTHROPIC_AUTH_TOKEN: "token-local",
        ANTHROPIC_MODEL: "main-model",
      },
    }, null, 2));

    await fx.adapter.inject(snapshot(), "favorite");
    await fx.adapter.restore();

    const env = parsed(await readFile(fx.settingsPath, "utf8")).env as Record<string, unknown>;
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("disabled ownership is a no-op and never deletes a user's same-name values", async () => {
    const original = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://user.example",
        ANTHROPIC_MODEL: "user-model",
      },
    }, null, 2);
    const fx = await fixture(original);

    const restored = await fx.adapter.restore();

    expect(restored).toMatchObject({ observedState: "native", changed: false });
    expect(await readFile(fx.settingsPath, "utf8")).toBe(original);
  });
});
