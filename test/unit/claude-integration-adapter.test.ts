import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeIntegrationAdapter } from "../../src/integrations/claude/adapter.js";
import type { AgentInjectionModel, AgentInjectionSnapshot } from "../../src/integrations/agents/snapshot.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});

const actualFs = await vi.importActual<typeof FsPromises>("node:fs/promises");
const roots: string[] = [];

afterEach(async () => {
  vi.mocked(readFile).mockReset();
  vi.mocked(rename).mockReset();
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
  const createAdapter = () => createClaudeIntegrationAdapter({
    settingsPath,
    stateDirectory,
    selectedModels: () => selections,
    isPublicModelAlias: (alias) => aliases.has(alias),
  });
  return {
    adapter: createAdapter(),
    createAdapter,
    settingsPath,
    statePath: join(stateDirectory, "claude-integration.json"),
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
  it("does not change Claude settings when ownership persistence fails", async () => {
    const original = '{"env":{"ANTHROPIC_AUTH_TOKEN":"user-token"}}\n';
    const fx = await fixture(original);
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === fx.statePath) throw Object.assign(new Error("state storage full"), { code: "ENOSPC" });
      await actualFs.rename(from, to);
    });

    await expect(fx.adapter.inject(snapshot(), "favorite")).rejects.toThrow("state storage full");
    expect(await readFile(fx.settingsPath, "utf8")).toBe(original);
    await expect(readFile(fx.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains restore ownership across recreation after post-write verification fails", async () => {
    const original = {
      env: { KEEP_ME: "yes", ANTHROPIC_AUTH_TOKEN: "user-token", ANTHROPIC_BASE_URL: "https://user.example" },
    };
    const fx = await fixture(JSON.stringify(original));
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await actualFs.rename(from, to);
      if (to === fx.settingsPath) vi.mocked(readFile).mockRejectedValueOnce(new Error("verification read failed"));
    });

    await expect(fx.adapter.inject(snapshot(), "favorite")).rejects.toThrow("verification read failed");
    expect(parsed(await readFile(fx.settingsPath, "utf8")).env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "token-local" });
    vi.mocked(rename).mockReset();

    expect(await fx.createAdapter().restore()).toMatchObject({ observedState: "native", changed: true });
    expect(parsed(await readFile(fx.settingsPath, "utf8"))).toEqual(original);
  });

  it("releases new ownership when the settings replacement fails before committing", async () => {
    const original = '{"env":{"ANTHROPIC_AUTH_TOKEN":"user-token"}}\n';
    const fx = await fixture(original);
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === fx.settingsPath) throw Object.assign(new Error("settings file occupied"), { code: "EPERM" });
      await actualFs.rename(from, to);
    });

    await expect(fx.adapter.inject(snapshot(), "favorite")).rejects.toThrow("settings file occupied");
    vi.mocked(rename).mockReset();
    const external = '{"env":{"ANTHROPIC_AUTH_TOKEN":"later-user-token"}}\n';
    await writeFile(fx.settingsPath, external, "utf8");

    expect(await fx.createAdapter().restore()).toMatchObject({ observedState: "native", changed: false });
    expect(await readFile(fx.settingsPath, "utf8")).toBe(external);
  });

  it("does not retain new ownership after refusing a concurrent settings edit", async () => {
    const fx = await fixture('{"env":{"ANTHROPIC_AUTH_TOKEN":"user-token"}}\n');
    const external = '{"env":{"ANTHROPIC_AUTH_TOKEN":"later-user-token"}}\n';
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await actualFs.rename(from, to);
      if (to === fx.statePath) await writeFile(fx.settingsPath, external, "utf8");
    });

    expect(await fx.adapter.inject(snapshot(), "favorite")).toMatchObject({ observedState: "conflict", changed: false });
    vi.mocked(rename).mockReset();
    expect(await fx.createAdapter().restore()).toMatchObject({ observedState: "native", changed: false });
    expect(await readFile(fx.settingsPath, "utf8")).toBe(external);
  });

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
