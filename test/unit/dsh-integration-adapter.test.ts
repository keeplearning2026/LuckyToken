import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  it("owns only its provider and credential ref while preserving other config and comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-"));
    try {
      const profileDir = join(root, "dsh", "profiles", "web");
      const patchPath = join(profileDir, "cordis.patch.yml");
      const credentialsPath = join(root, "dsh", ".credentials.yaml");
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
      await writeFile(credentialsPath, `version: 1
refs:
  OTHER_KEY: user-value
records:
  llm-pi-ai/openai-codex:
    kind: api-key
    env:
      AWS_PROFILE: prod
`, "utf8");
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
      let credentials = await readFile(credentialsPath, "utf8");
      expect(credentials).toContain("TOKEN_API_KEY: token-local");
      expect(credentials).toContain("OTHER_KEY: user-value");
      expect(credentials).toContain("llm-pi-ai/openai-codex");
      expect((await adapter.inject(selected, "full")).modelCount).toBe(2);
      patch = await readFile(patchPath, "utf8");
      expect((provider(patch) as { models: unknown[] }).models).toHaveLength(2);
      expect((await adapter.restore()).observedState).toBe("native");
      patch = await readFile(patchPath, "utf8");
      expect(provider(patch)).toBeUndefined();
      expect(patch).toContain("other:");
      expect(patch).toContain("agent-default-model");
      credentials = await readFile(credentialsPath, "utf8");
      expect(credentials).not.toContain("TOKEN_API_KEY");
      expect(credentials).toContain("OTHER_KEY: user-value");
      expect(credentials).toContain("llm-pi-ai/openai-codex");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("overwrites an existing Token provider and credential ref, then deletes those owned keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-conflict-"));
    try {
      const profileDir = join(root, "dsh", "profiles", "web");
      await mkdir(profileDir, { recursive: true });
      const patchPath = join(profileDir, "cordis.patch.yml");
      const credentialsPath = join(root, "dsh", ".credentials.yaml");
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "web", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      const userPatch = "- id: llm-pi-ai\n  config:\n    providers:\n      other: {api: anthropic-messages}\n      Token: {api: anthropic-messages}\n";
      await writeFile(patchPath, userPatch, "utf8");
      await writeFile(credentialsPath, "version: 1\nrefs:\n  TOKEN_API_KEY: user-secret\n", "utf8");
      expect((await adapter.inject(selected, "favorite")).observedState).toBe("managed");
      expect(provider(await readFile(patchPath, "utf8"))).toMatchObject({ api: "openai-responses" });
      expect(await readFile(credentialsPath, "utf8")).toContain("TOKEN_API_KEY: token-local");
      expect((await adapter.restore()).observedState).toBe("native");
      const restored = await readFile(patchPath, "utf8");
      expect(provider(restored)).toBeUndefined();
      expect(restored).toContain("other:");
      expect(await readFile(credentialsPath, "utf8")).not.toContain("TOKEN_API_KEY");
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
      expect(await readFile(join(root, "dsh", ".credentials.yaml"), "utf8"))
        .toContain("TOKEN_API_KEY: token-local");
      expect((await adapter.restore()).observedState).toBe("native");
      expect(parseDocument(await readFile(patchPath, "utf8")).toJS()).toEqual([]);
      expect(await readFile(join(root, "dsh", ".credentials.yaml"), "utf8"))
        .not.toContain("TOKEN_API_KEY");
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

  it("adds its ref to a records-only credentials file and restores it byte-for-byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-records-only-"));
    try {
      const profileDir = join(root, "dsh", "profiles", "desktop");
      const patchPath = join(profileDir, "cordis.patch.yml");
      const credentialsPath = join(root, "dsh", ".credentials.yaml");
      await mkdir(profileDir, { recursive: true });
      await writeFile(patchPath, "[]\n", "utf8");
      const original = `version: 1

records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: test-secret
`;
      await writeFile(credentialsPath, original, "utf8");
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "desktop", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      expect((await adapter.inject(selected, "favorite")).observedState).toBe("managed");
      const injected = await readFile(credentialsPath, "utf8");
      expect(injected).toContain("TOKEN_API_KEY: token-local");
      expect(injected).toContain("client-connection/browser-session");
      expect((await adapter.restore()).observedState).toBe("native");
      expect(await readFile(credentialsPath, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("asks the user to launch DeepSeek Harness Desktop when the desktop profile is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-desktop-missing-"));
    try {
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "desktop", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      const effect = await adapter.inject(selected, "favorite");
      expect(effect.observedState).toBe("unavailable");
      expect(effect.message).toBe(
        "Launch DeepSeek Harness Desktop once before enabling the integration.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fingerprints the target profile so switching profiles requires a sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-fingerprint-"));
    try {
      const web = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "web", stateDirectory: join(root, "state-web"),
      });
      const desktop = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "desktop", stateDirectory: join(root, "state-desktop"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      await expect(web.projectionFingerprint(selected, "favorite")).resolves.not.toBe(
        await desktop.projectionFingerprint(selected, "favorite"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("takes over a stale credentials lock left by an exited DSH process", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-stale-lock-"));
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (deadPid === undefined) throw new Error("Child process did not report a pid.");
    try {
      const profileDir = join(root, "dsh", "profiles", "desktop");
      const patchPath = join(profileDir, "cordis.patch.yml");
      const credentialsPath = join(root, "dsh", ".credentials.yaml");
      const lockPath = `${credentialsPath}.lock`;
      await mkdir(profileDir, { recursive: true });
      await writeFile(patchPath, "[]\n", "utf8");
      await writeFile(credentialsPath, "version: 1\n", "utf8");
      await writeFile(lockPath, `${deadPid}\n`, "utf8");
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "desktop", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      expect((await adapter.inject(selected, "favorite")).observedState).toBe("managed");
      expect(await readFile(credentialsPath, "utf8")).toContain("TOKEN_API_KEY: token-local");
      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a DSH home when restoring without DSH state", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-no-home-"));
    try {
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "desktop", stateDirectory: join(root, "state"),
      });
      expect((await adapter.restore()).observedState).toBe("native");
      await expect(stat(join(root, "dsh"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("takes over a stale profile lock left by an exited DSH process", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-dsh-stale-profile-lock-"));
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (deadPid === undefined) throw new Error("Child process did not report a pid.");
    try {
      const profileDir = join(root, "dsh", "profiles", "desktop");
      const patchPath = join(profileDir, "cordis.patch.yml");
      const profileLockPath = join(profileDir, "package.json.lock");
      await mkdir(profileDir, { recursive: true });
      await writeFile(patchPath, "[]\n", "utf8");
      await writeFile(profileLockPath, `${deadPid}\n`, "utf8");
      const adapter = createDshIntegrationAdapter({
        dshHome: join(root, "dsh"), profile: "desktop", stateDirectory: join(root, "state"),
      });
      const selected = { ...snapshot, full: snapshot.favorite };
      expect((await adapter.inject(selected, "favorite")).observedState).toBe("managed");
      expect(provider(await readFile(patchPath, "utf8"))).toMatchObject({ displayName: "Token" });
      await expect(readFile(profileLockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
