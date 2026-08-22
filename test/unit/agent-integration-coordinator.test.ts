import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentIntegrationId,
  AgentInjectionScope,
} from "../../src/integrations/agents/contract.js";
import { createAgentIntegrationCoordinator } from "../../src/integrations/agents/coordinator.js";
import type { AgentInjectionSnapshot } from "../../src/integrations/agents/snapshot.js";

function snapshot(): AgentInjectionSnapshot {
  return Object.freeze({
    endpoint: Object.freeze({
      origin: "http://127.0.0.1:3000",
      openaiBaseUrl: "http://127.0.0.1:3000/v1",
    }),
    full: Object.freeze([]),
    favorite: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function success(
  observedState: "native" | "managed",
  changed: boolean,
): AgentIntegrationEffect {
  return Object.freeze({
    observedState,
    modelCount: observedState === "managed" ? 1 : 0,
    warnings: Object.freeze([]),
    changed,
  });
}

function recordingAdapter(id: AgentIntegrationId) {
  const injectCalls: Array<{ scope: AgentInjectionScope }> = [];
  let restoreCalls = 0;
  let injectEffect = success("managed", true);
  let restoreEffect = success("native", true);
  const adapter: AgentIntegrationAdapter = Object.freeze({
    id,
    projectionFingerprint: async (
      _snapshot: AgentInjectionSnapshot,
      scope: AgentInjectionScope,
    ) => `${id}:${scope}`,
    inject: async (
      _snapshot: AgentInjectionSnapshot,
      scope: AgentInjectionScope,
    ) => {
      injectCalls.push({ scope });
      return injectEffect;
    },
    restore: async () => {
      restoreCalls += 1;
      return restoreEffect;
    },
  });
  return {
    adapter,
    injectCalls,
    restoreCalls: () => restoreCalls,
    failInject: () => {
      injectEffect = Object.freeze({
        ...success("native", false),
        observedState: "conflict",
        message: "fixture injection conflict",
      });
    },
    failRestore: () => {
      restoreEffect = Object.freeze({
        ...success("native", false),
        observedState: "conflict",
        message: "fixture restore conflict",
      });
    },
  };
}

describe("Agent integration coordinator", () => {
  it("uses one enable/disable rule for each adapter and persists only successful intent", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "luckytoken-agents-"));
    const codex = recordingAdapter("codex");
    const pi = recordingAdapter("pi");
    const coordinator = createAgentIntegrationCoordinator({
      stateDirectory,
      snapshot: async () => snapshot(),
      adapters: [codex.adapter, pi.adapter],
    });

    await expect(coordinator.query()).resolves.toMatchObject({
      agents: [
        { agentId: "codex", enabled: false, scope: "favorite", needsSync: false },
        { agentId: "pi", enabled: false, scope: "favorite", needsSync: false },
      ],
    });

    const enabled = await coordinator.setEnabled("codex", true);

    expect(enabled.outcome).toBe("ok");
    expect(codex.injectCalls).toEqual([{ scope: "favorite" }]);
    expect(pi.injectCalls).toEqual([]);
    expect(enabled.state.agents).toContainEqual(
      expect.objectContaining({
        agentId: "codex",
        enabled: true,
        scope: "favorite",
        needsSync: false,
      }),
    );

    const disabled = await coordinator.setEnabled("codex", false);

    expect(disabled.outcome).toBe("ok");
    expect(codex.restoreCalls()).toBe(1);
    expect(disabled.state.agents).toContainEqual(
      expect.objectContaining({ agentId: "codex", enabled: false }),
    );
  });

  it("keeps the previous icon state when inject or restore fails", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "luckytoken-agent-failure-"));
    const codex = recordingAdapter("codex");
    const pi = recordingAdapter("pi");
    const coordinator = createAgentIntegrationCoordinator({
      stateDirectory,
      snapshot: async () => snapshot(),
      adapters: [codex.adapter, pi.adapter],
    });

    codex.failInject();
    const failedEnable = await coordinator.setEnabled("codex", true);

    expect(failedEnable).toMatchObject({ outcome: "failed" });
    expect(failedEnable.state.agents).toContainEqual(
      expect.objectContaining({ agentId: "codex", enabled: false }),
    );

    await coordinator.setEnabled("pi", true);
    pi.failRestore();
    const failedDisable = await coordinator.setEnabled("pi", false);

    expect(failedDisable).toMatchObject({ outcome: "failed" });
    expect(failedDisable.state.agents).toContainEqual(
      expect.objectContaining({ agentId: "pi", enabled: true }),
    );
  });

  it("persists scope changes without injecting and marks enabled output dirty", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "luckytoken-agent-scope-"));
    const codex = recordingAdapter("codex");
    const pi = recordingAdapter("pi");
    const coordinator = createAgentIntegrationCoordinator({
      stateDirectory,
      snapshot: async () => snapshot(),
      adapters: [codex.adapter, pi.adapter],
    });
    await coordinator.setEnabled("codex", true);
    const injectionCount = codex.injectCalls.length;

    const changed = await coordinator.setScope("codex", "full");

    expect(codex.injectCalls).toHaveLength(injectionCount);
    expect(changed.state.agents).toContainEqual(
      expect.objectContaining({
        agentId: "codex",
        enabled: true,
        scope: "full",
        needsSync: true,
      }),
    );
    const reconstructed = createAgentIntegrationCoordinator({
      stateDirectory,
      snapshot: async () => snapshot(),
      adapters: [codex.adapter, pi.adapter],
    });
    await expect(reconstructed.query()).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ agentId: "codex", scope: "full", needsSync: true }),
      ]),
    });
  });

  it("syncs all enabled agents independently without rolling back successes", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "luckytoken-agent-sync-"));
    const codex = recordingAdapter("codex");
    const pi = recordingAdapter("pi");
    const coordinator = createAgentIntegrationCoordinator({
      stateDirectory,
      snapshot: async () => snapshot(),
      adapters: [codex.adapter, pi.adapter],
    });
    await coordinator.setEnabled("codex", true);
    await coordinator.setEnabled("pi", true);
    await coordinator.setScope("codex", "full");
    await coordinator.setScope("pi", "full");
    pi.failInject();

    const synced = await coordinator.sync();

    expect(synced.outcome).toBe("partial");
    expect(synced.results).toEqual([
      expect.objectContaining({ agentId: "codex", outcome: "ok" }),
      expect.objectContaining({ agentId: "pi", outcome: "failed" }),
    ]);
    expect(synced.state.agents).toEqual([
      expect.objectContaining({ agentId: "codex", enabled: true, needsSync: false }),
      expect.objectContaining({ agentId: "pi", enabled: true, needsSync: true }),
    ]);
  });

  it("applies startup rules and attempts every restore before blocking shutdown", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "luckytoken-agent-lifecycle-"));
    const codex = recordingAdapter("codex");
    const pi = recordingAdapter("pi");
    const coordinator = createAgentIntegrationCoordinator({
      stateDirectory,
      snapshot: async () => snapshot(),
      adapters: [codex.adapter, pi.adapter],
    });
    await coordinator.setEnabled("codex", true);
    const codexInjectsBeforeStartup = codex.injectCalls.length;
    const piRestoresBeforeStartup = pi.restoreCalls();

    const started = await coordinator.startup();

    expect(started.outcome).toBe("ok");
    expect(codex.injectCalls).toHaveLength(codexInjectsBeforeStartup + 1);
    expect(pi.restoreCalls()).toBe(piRestoresBeforeStartup + 1);
    pi.failRestore();
    const codexRestoresBeforeShutdown = codex.restoreCalls();
    const piRestoresBeforeShutdown = pi.restoreCalls();

    await expect(coordinator.shutdown()).rejects.toThrow(
      "Agent integrations could not all be restored before LuckyToken shutdown",
    );
    expect(codex.restoreCalls()).toBe(codexRestoresBeforeShutdown + 1);
    expect(pi.restoreCalls()).toBe(piRestoresBeforeShutdown + 1);
    await expect(coordinator.query()).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ agentId: "codex", enabled: true, needsSync: true }),
      ]),
    });
  });
});
