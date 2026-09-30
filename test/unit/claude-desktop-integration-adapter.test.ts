import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import type { AgentInjectionSnapshot } from "../../src/integrations/agents/snapshot.js";
import { createClaudeDesktopIntegrationAdapter } from "../../src/integrations/claude-desktop/adapter.js";
import { resolveClaudeDesktopPaths, CLAUDE_DESKTOP_PROFILE_ID } from "../../src/integrations/claude-desktop/paths.js";
import { markAnthropicModelId } from "../../src/protocols/anthropic/marked-model-id.js";

const snapshot: AgentInjectionSnapshot = {
  endpoint: { origin: "http://127.0.0.1:4317", openaiBaseUrl: "http://127.0.0.1:4317/v1" },
  favorite: [{
    alias: "provider/favorite",
    target: { providerId: "provider", modelId: "favorite" },
    reasoning: false,
    thinkingLevels: [],
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  }],
  full: [{
    alias: "provider/favorite",
    target: { providerId: "provider", modelId: "favorite" },
    reasoning: false,
    thinkingLevels: [],
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  }, {
    alias: "other/full",
    target: { providerId: "other", modelId: "full" },
    reasoning: false,
    thinkingLevels: [],
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 32_000,
  }],
  warnings: [],
};

async function readJson(path: string): Promise<Record<string, unknown>> {
  return parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("Claude Desktop integration adapter", () => {
  it("injects a static Gateway profile on a fresh install and restores created files", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-"));
    try {
      const paths = resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root });
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory: join(root, "state") });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("managed");
      const profile = await readJson(paths.tokenProfile);
      expect(profile).toMatchObject({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: snapshot.endpoint.origin,
        inferenceGatewayAuthScheme: "bearer",
        modelDiscoveryEnabled: false,
        inferenceModels: [{
          name: markAnthropicModelId("provider/favorite"),
          labelOverride: "provider/favorite",
        }],
      });
      expect((await readJson(paths.standardConfig)).deploymentMode).toBe("3p");
      expect((await readJson(paths.threePartyConfig)).deploymentMode).toBe("3p");
      expect(await readJson(paths.metadata)).toMatchObject({
        appliedId: CLAUDE_DESKTOP_PROFILE_ID,
        entries: [{ id: CLAUDE_DESKTOP_PROFILE_ID, name: "Token" }],
      });
      expect((await adapter.inject(snapshot, "favorite")).changed).toBe(false);
      expect((await adapter.inject(snapshot, "full")).modelCount).toBe(2);
      expect((await readJson(paths.tokenProfile)).inferenceModels).toMatchObject([
        { name: markAnthropicModelId("provider/favorite") },
        { name: markAnthropicModelId("other/full") },
      ]);
      expect((await adapter.restore()).observedState).toBe("native");
      for (const path of [paths.standardConfig, paths.threePartyConfig, paths.metadata, paths.tokenProfile]) {
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves user fields during inject, sync, and restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-existing-"));
    try {
      const paths = resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root });
      await mkdir(paths.libraryDirectory, { recursive: true });
      await mkdir(join(root, "Claude"), { recursive: true });
      await writeFile(paths.standardConfig, '{\n  // User comment\n  "deploymentMode": "native",\n  "theme": "dark"\n}\n');
      await writeFile(paths.threePartyConfig, '{"deploymentMode":"other","keep":42}\n');
      await writeFile(paths.metadata, '{"entries":[{"id":"other","name":"Other"}],"appliedId":"other","keep":true}\n');
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory: join(root, "state") });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("managed");
      expect(await readFile(paths.standardConfig, "utf8")).toContain("// User comment");
      const metadataBeforeSync = await readFile(paths.metadata, "utf8");
      const standardBeforeSync = await readFile(paths.standardConfig, "utf8");
      expect((await adapter.inject(snapshot, "full")).observedState).toBe("managed");
      expect(await readFile(paths.metadata, "utf8")).toBe(metadataBeforeSync);
      expect(await readFile(paths.standardConfig, "utf8")).toBe(standardBeforeSync);
      expect((await adapter.restore()).observedState).toBe("native");
      expect(await readJson(paths.standardConfig)).toMatchObject({ deploymentMode: "native", theme: "dark" });
      expect(await readJson(paths.threePartyConfig)).toMatchObject({ deploymentMode: "other", keep: 42 });
      expect(await readJson(paths.metadata)).toMatchObject({ entries: [{ id: "other" }], appliedId: "other", keep: true });
      expect(await readFile(paths.standardConfig, "utf8")).toContain("// User comment");
      await expect(readFile(paths.tokenProfile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures the latest complete selection when a user switches profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-switch-"));
    try {
      const paths = resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root });
      await mkdir(paths.libraryDirectory, { recursive: true });
      await mkdir(join(root, "Claude"), { recursive: true });
      await writeFile(paths.metadata, '{"entries":[{"id":"A","name":"A"}],"appliedId":"A"}\n');
      await writeFile(paths.standardConfig, '{"deploymentMode":"native"}\n');
      await writeFile(paths.threePartyConfig, '{"deploymentMode":"native"}\n');
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory: join(root, "state") });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("managed");
      const metadata = await readJson(paths.metadata);
      await writeFile(paths.metadata, `${JSON.stringify({ ...metadata, appliedId: "B" })}\n`);
      expect((await adapter.inject(snapshot, "full")).observedState).toBe("managed");
      expect((await readJson(paths.metadata)).appliedId).toBe(CLAUDE_DESKTOP_PROFILE_ID);
      expect(await readJson(join(root, "state", "claude-desktop-integration.json"))).toMatchObject({
        appliedId: { present: true, value: "B" },
        standardMode: { present: true, value: "3p" },
        threePartyMode: { present: true, value: "3p" },
      });
      expect((await adapter.restore()).observedState).toBe("native");
      expect(await readJson(paths.metadata)).toMatchObject({ appliedId: "B" });
      expect(await readJson(paths.standardConfig)).toMatchObject({ deploymentMode: "3p" });
      expect(await readJson(paths.threePartyConfig)).toMatchObject({ deploymentMode: "3p" });
      await expect(readFile(paths.tokenProfile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a newer profile selection even when disabled before another sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-unsynced-"));
    try {
      const paths = resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root });
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory: join(root, "state") });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("managed");
      const metadata = await readJson(paths.metadata);
      await writeFile(paths.metadata, `${JSON.stringify({ ...metadata, appliedId: "B" })}\n`);
      expect((await adapter.restore()).observedState).toBe("native");
      expect((await readJson(paths.metadata)).appliedId).toBe("B");
      expect((await readJson(paths.standardConfig)).deploymentMode).toBe("3p");
      expect((await readJson(paths.threePartyConfig)).deploymentMode).toBe("3p");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates only a changed mode while Token remains selected and repairs owned resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-drift-"));
    try {
      const paths = resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root });
      await mkdir(paths.libraryDirectory, { recursive: true });
      await mkdir(join(root, "Claude"), { recursive: true });
      await writeFile(paths.metadata, '{"entries":[{"id":"A","name":"A"}],"appliedId":"A"}\n');
      await writeFile(paths.standardConfig, '{"deploymentMode":"native"}\n');
      await writeFile(paths.threePartyConfig, '{"deploymentMode":"3p"}\n');
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory: join(root, "state") });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("managed");
      await writeFile(paths.standardConfig, '{"deploymentMode":"custom"}\n');
      await writeFile(paths.tokenProfile, '{"corrupted":true}\n');
      const metadata = await readJson(paths.metadata);
      await writeFile(paths.metadata, `${JSON.stringify({ ...metadata, entries: [{ id: "A", name: "A" }] })}\n`);
      expect((await adapter.inject(snapshot, "full")).observedState).toBe("managed");
      expect((await readJson(paths.standardConfig)).deploymentMode).toBe("3p");
      expect((await readJson(paths.tokenProfile)).inferenceModels).toHaveLength(2);
      expect((await readJson(paths.metadata)).entries).toMatchObject([
        { id: "A" }, { id: CLAUDE_DESKTOP_PROFILE_ID, name: "Token" },
      ]);
      expect(await readJson(join(root, "state", "claude-desktop-integration.json"))).toMatchObject({
        appliedId: { present: true, value: "A" },
        standardMode: { present: true, value: "custom" },
        threePartyMode: { present: true, value: "3p" },
      });
      expect((await adapter.restore()).observedState).toBe("native");
      expect((await readJson(paths.metadata)).appliedId).toBe("A");
      expect((await readJson(paths.standardConfig)).deploymentMode).toBe("custom");
      expect((await readJson(paths.threePartyConfig)).deploymentMode).toBe("3p");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an orphaned selected Token profile without inventing a restore snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-orphan-"));
    try {
      const paths = resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root });
      await mkdir(paths.libraryDirectory, { recursive: true });
      await writeFile(paths.metadata, `${JSON.stringify({ appliedId: CLAUDE_DESKTOP_PROFILE_ID })}\n`);
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory: join(root, "state") });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("conflict");
      expect((await readJson(paths.metadata)).appliedId).toBe(CLAUDE_DESKTOP_PROFILE_ID);
      await expect(readFile(join(root, "state", "claude-desktop-integration.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back its restore snapshot when a later Desktop file write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-rollback-"));
    try {
      const stateDirectory = join(root, "state");
      const statePath = join(stateDirectory, "claude-desktop-integration.json");
      const paths = {
        ...resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root }),
        standardConfig: statePath,
      };
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("unavailable");
      for (const path of [statePath, paths.metadata, paths.threePartyConfig, paths.tokenProfile]) {
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the previous snapshot after a failed recapture and complete file rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-recapture-rollback-"));
    try {
      const stateDirectory = join(root, "state");
      const statePath = join(stateDirectory, "claude-desktop-integration.json");
      const paths = resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root });
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("managed");
      const oldState = await readFile(statePath, "utf8");
      const oldProfile = await readFile(paths.tokenProfile, "utf8");
      const metadata = await readJson(paths.metadata);
      await writeFile(paths.metadata, `${JSON.stringify({ ...metadata, appliedId: "B" })}\n`);
      const faulty = createClaudeDesktopIntegrationAdapter({
        paths: { ...paths, standardConfig: statePath }, stateDirectory,
      });
      expect((await faulty.inject(snapshot, "full")).observedState).toBe("unavailable");
      expect(await readFile(statePath, "utf8")).toBe(oldState);
      expect(await readFile(paths.tokenProfile, "utf8")).toBe(oldProfile);
      expect((await readJson(paths.metadata)).appliedId).toBe("B");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses malformed config and overwrites its exclusively owned profile ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-claude-desktop-conflict-"));
    try {
      const paths = resolveClaudeDesktopPaths({ platform: "win32", home: root, localAppData: root });
      await mkdir(join(root, "Claude"), { recursive: true });
      await writeFile(paths.standardConfig, "[invalid", "utf8");
      const adapter = createClaudeDesktopIntegrationAdapter({ paths, stateDirectory: join(root, "state") });
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("conflict");
      expect(await readFile(paths.standardConfig, "utf8")).toBe("[invalid");
      await expect(readFile(paths.tokenProfile)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(paths.standardConfig, "{}\n");
      await mkdir(paths.libraryDirectory, { recursive: true });
      await writeFile(paths.tokenProfile, '{"owner":"user"}\n');
      await writeFile(paths.metadata, `${JSON.stringify({ entries: [
        { id: CLAUDE_DESKTOP_PROFILE_ID, name: "Old Token" },
        { id: "other", name: "Other" },
      ], appliedId: "other" })}\n`);
      expect((await adapter.inject(snapshot, "favorite")).observedState).toBe("managed");
      expect(await readJson(paths.tokenProfile)).toMatchObject({ inferenceProvider: "gateway" });
      expect((await readJson(paths.metadata)).entries).toMatchObject([
        { id: "other" }, { id: CLAUDE_DESKTOP_PROFILE_ID, name: "Token" },
      ]);
      expect((await adapter.restore()).observedState).toBe("native");
      await expect(readFile(paths.tokenProfile)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readJson(paths.metadata)).entries).toMatchObject([{ id: "other" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
it("resolves canonical Desktop roots for each supported platform", () => {
  expect(resolveClaudeDesktopPaths({ platform: "win32", home: "C:\\User", localAppData: "C:\\Local" }).libraryDirectory)
    .toContain("Claude-3p");
  expect(resolveClaudeDesktopPaths({ platform: "darwin", home: "/home/user" }).libraryDirectory)
    .toContain(join("Library", "Application Support", "Claude-3p", "configLibrary"));
  expect(resolveClaudeDesktopPaths({ platform: "linux", home: "/home/user", xdgConfigHome: "/custom/config" }).libraryDirectory)
    .toBe(join("/custom/config", "Claude-3p", "configLibrary"));
});
