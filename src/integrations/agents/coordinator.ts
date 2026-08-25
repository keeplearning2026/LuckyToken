import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentIntegrationId,
  AgentInjectionScope,
} from "./contract.js";
import type { AgentInjectionSnapshot } from "./snapshot.js";

const STATE_SCHEMA = "Token-agent-integrations-v1" as const;

interface StoredAgentState {
  readonly agentId: AgentIntegrationId;
  readonly enabled: boolean;
  readonly scope: AgentInjectionScope;
  readonly appliedFingerprint?: string;
  readonly modelCount: number;
}

interface StoredState {
  readonly schemaVersion: typeof STATE_SCHEMA;
  readonly agents: readonly StoredAgentState[];
}

export interface AgentIntegrationProjection {
  readonly agentId: AgentIntegrationId;
  readonly enabled: boolean;
  readonly scope: AgentInjectionScope;
  readonly modelCount: number;
  readonly needsSync: boolean;
}

export interface AgentIntegrationsState {
  readonly agents: readonly AgentIntegrationProjection[];
}

export interface AgentIntegrationOperationResult {
  readonly agentId: AgentIntegrationId;
  readonly outcome: "ok" | "failed";
  readonly effect?: AgentIntegrationEffect;
}

export interface AgentIntegrationsCommandResult {
  readonly outcome: "ok" | "partial" | "failed";
  readonly state: AgentIntegrationsState;
  readonly results: readonly AgentIntegrationOperationResult[];
}

export interface AgentIntegrationCoordinator {
  query(): Promise<AgentIntegrationsState>;
  setEnabled(
    agentId: AgentIntegrationId,
    enabled: boolean,
  ): Promise<AgentIntegrationsCommandResult>;
  setScope(
    agentId: AgentIntegrationId,
    scope: AgentInjectionScope,
  ): Promise<AgentIntegrationsCommandResult>;
  sync(): Promise<AgentIntegrationsCommandResult>;
  startup(): Promise<AgentIntegrationsCommandResult>;
  shutdown(): Promise<AgentIntegrationsCommandResult>;
}

export interface CreateAgentIntegrationCoordinatorOptions {
  readonly stateDirectory: string;
  readonly snapshot: () => Promise<AgentInjectionSnapshot>;
  readonly adapters: readonly AgentIntegrationAdapter[];
  readonly defaults?: Partial<
    Record<
      AgentIntegrationId,
      { readonly enabled: boolean; readonly scope: AgentInjectionScope }
    >
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function defaultAgent(agentId: AgentIntegrationId): StoredAgentState {
  return Object.freeze({
    agentId,
    enabled: false,
    scope: "favorite",
    modelCount: 0,
  });
}

function parseAgent(value: unknown): StoredAgentState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.agentId !== "codex" && value.agentId !== "pi") return undefined;
  if (typeof value.enabled !== "boolean") return undefined;
  if (value.scope !== "favorite" && value.scope !== "full") return undefined;
  if (!Number.isSafeInteger(value.modelCount) || (value.modelCount as number) < 0) {
    return undefined;
  }
  if (
    value.appliedFingerprint !== undefined &&
    typeof value.appliedFingerprint !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({
    agentId: value.agentId,
    enabled: value.enabled,
    scope: value.scope,
    modelCount: value.modelCount as number,
    ...(value.appliedFingerprint === undefined
      ? {}
      : { appliedFingerprint: value.appliedFingerprint }),
  });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function injectionSucceeded(effect: AgentIntegrationEffect): boolean {
  return effect.observedState === "managed" || effect.observedState === "native";
}

function failedEffect(error: unknown): AgentIntegrationEffect {
  return Object.freeze({
    observedState: "unavailable",
    modelCount: 0,
    warnings: Object.freeze([]),
    changed: false,
    message: error instanceof Error ? error.message : String(error),
  });
}

function aggregateOutcome(
  results: readonly AgentIntegrationOperationResult[],
): AgentIntegrationsCommandResult["outcome"] {
  const failures = results.filter((entry) => entry.outcome === "failed").length;
  if (failures === 0) return "ok";
  return failures === results.length ? "failed" : "partial";
}

export function createAgentIntegrationCoordinator(
  options: CreateAgentIntegrationCoordinatorOptions,
): AgentIntegrationCoordinator {
  const statePath = join(options.stateDirectory, "agent-integrations.json");
  const adapterById = new Map<AgentIntegrationId, AgentIntegrationAdapter>();
  for (const adapter of options.adapters) {
    if (adapterById.has(adapter.id)) {
      throw new Error(`Duplicate Agent integration adapter: ${adapter.id}`);
    }
    adapterById.set(adapter.id, adapter);
  }
  let operationQueue = Promise.resolve();

  const defaultFor = (agentId: AgentIntegrationId): StoredAgentState => {
    const configured = options.defaults?.[agentId];
    if (configured === undefined) return defaultAgent(agentId);
    return Object.freeze({
      agentId,
      enabled: configured.enabled,
      scope: configured.scope,
      modelCount: 0,
    });
  };

  const readState = async (): Promise<StoredState> => {
    let raw: string;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return Object.freeze({
          schemaVersion: STATE_SCHEMA,
          agents: Object.freeze(options.adapters.map((adapter) => defaultFor(adapter.id))),
        });
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== STATE_SCHEMA ||
      !Array.isArray(parsed.agents)
    ) {
      throw new Error("Token Agent integration state is invalid.");
    }
    const parsedById = new Map<AgentIntegrationId, StoredAgentState>();
    for (const value of parsed.agents) {
      const agent = parseAgent(value);
      if (agent === undefined || parsedById.has(agent.agentId)) {
        throw new Error("Token Agent integration state is invalid.");
      }
      parsedById.set(agent.agentId, agent);
    }
    return Object.freeze({
      schemaVersion: STATE_SCHEMA,
      agents: Object.freeze(
        options.adapters.map(
          (adapter) => parsedById.get(adapter.id) ?? defaultFor(adapter.id),
        ),
      ),
    });
  };

  const writeState = async (state: StoredState): Promise<void> => {
    await mkdir(options.stateDirectory, { recursive: true });
    await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };

  const project = async (
    state: StoredState,
    snapshot?: AgentInjectionSnapshot,
  ): Promise<AgentIntegrationsState> => {
    const currentSnapshot = snapshot ?? (await options.snapshot());
    const agents = await Promise.all(
      state.agents.map(async (agent) => {
        let needsSync = false;
        if (agent.enabled) {
          const adapter = adapterById.get(agent.agentId);
          if (adapter === undefined) throw new Error(`Missing adapter: ${agent.agentId}`);
          const desired = await adapter.projectionFingerprint(
            currentSnapshot,
            agent.scope,
          );
          needsSync = desired !== agent.appliedFingerprint;
        }
        return Object.freeze({
          agentId: agent.agentId,
          enabled: agent.enabled,
          scope: agent.scope,
          modelCount: agent.modelCount,
          needsSync,
        });
      }),
    );
    return Object.freeze({ agents: Object.freeze(agents) });
  };

  const performSetEnabled = async (
    agentId: AgentIntegrationId,
    enabled: boolean,
  ): Promise<AgentIntegrationsCommandResult> => {
    const adapter = adapterById.get(agentId);
    if (adapter === undefined) throw new Error(`Unknown Agent integration: ${agentId}`);
    const state = await readState();
    const current = state.agents.find((agent) => agent.agentId === agentId);
    if (current === undefined) throw new Error(`Missing Agent state: ${agentId}`);
    if (current.enabled === enabled) {
      return Object.freeze({
        outcome: "ok",
        state: await project(state),
        results: Object.freeze([]),
      });
    }

    const currentSnapshot = await options.snapshot();
    const fingerprint = enabled
      ? await adapter.projectionFingerprint(currentSnapshot, current.scope)
      : undefined;
    const effect = enabled
      ? await adapter.inject(currentSnapshot, current.scope)
      : await adapter.restore();
    const succeeded = enabled
      ? injectionSucceeded(effect)
      : effect.observedState === "native";
    if (!succeeded) {
      return Object.freeze({
        outcome: "failed",
        state: await project(state, currentSnapshot),
        results: Object.freeze([
          Object.freeze({ agentId, outcome: "failed" as const, effect }),
        ]),
      });
    }

    const nextAgent: StoredAgentState = Object.freeze({
      agentId,
      enabled,
      scope: current.scope,
      modelCount: effect.modelCount,
      ...(enabled && fingerprint !== undefined
        ? { appliedFingerprint: fingerprint }
        : {}),
    });
    const next: StoredState = Object.freeze({
      schemaVersion: STATE_SCHEMA,
      agents: Object.freeze(
        state.agents.map((agent) =>
          agent.agentId === agentId ? nextAgent : agent,
        ),
      ),
    });
    await writeState(next);
    return Object.freeze({
      outcome: "ok",
      state: await project(next, currentSnapshot),
      results: Object.freeze([
        Object.freeze({ agentId, outcome: "ok" as const, effect }),
      ]),
    });
  };

  const setEnabled = (
    agentId: AgentIntegrationId,
    enabled: boolean,
  ): Promise<AgentIntegrationsCommandResult> => {
    const operation = operationQueue.then(() => performSetEnabled(agentId, enabled));
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const performSetScope = async (
    agentId: AgentIntegrationId,
    scope: AgentInjectionScope,
  ): Promise<AgentIntegrationsCommandResult> => {
    if (!adapterById.has(agentId)) {
      throw new Error(`Unknown Agent integration: ${agentId}`);
    }
    const state = await readState();
    const current = state.agents.find((agent) => agent.agentId === agentId);
    if (current === undefined) throw new Error(`Missing Agent state: ${agentId}`);
    if (current.scope === scope) {
      return Object.freeze({
        outcome: "ok",
        state: await project(state),
        results: Object.freeze([]),
      });
    }
    const next: StoredState = Object.freeze({
      schemaVersion: STATE_SCHEMA,
      agents: Object.freeze(
        state.agents.map((agent) =>
          agent.agentId === agentId ? Object.freeze({ ...agent, scope }) : agent,
        ),
      ),
    });
    await writeState(next);
    return Object.freeze({
      outcome: "ok",
      state: await project(next),
      results: Object.freeze([]),
    });
  };

  const performApply = async (
    mode: "sync" | "startup",
  ): Promise<AgentIntegrationsCommandResult> => {
    const state = await readState();
    const currentSnapshot = await options.snapshot();
    const targets = mode === "sync"
      ? state.agents.filter((agent) => agent.enabled)
      : state.agents;
    const nextById = new Map<AgentIntegrationId, StoredAgentState>();
    const results = await Promise.all(
      targets.map(async (agent): Promise<AgentIntegrationOperationResult> => {
        const adapter = adapterById.get(agent.agentId);
        if (adapter === undefined) throw new Error(`Missing adapter: ${agent.agentId}`);
        try {
          if (agent.enabled) {
            const fingerprint = await adapter.projectionFingerprint(
              currentSnapshot,
              agent.scope,
            );
            const effect = await adapter.inject(currentSnapshot, agent.scope);
            if (!injectionSucceeded(effect)) {
              return Object.freeze({
                agentId: agent.agentId,
                outcome: "failed",
                effect,
              });
            }
            nextById.set(
              agent.agentId,
              Object.freeze({
                ...agent,
                modelCount: effect.modelCount,
                appliedFingerprint: fingerprint,
              }),
            );
            return Object.freeze({
              agentId: agent.agentId,
              outcome: "ok",
              effect,
            });
          }

          const effect = await adapter.restore();
          if (effect.observedState !== "native") {
            return Object.freeze({
              agentId: agent.agentId,
              outcome: "failed",
              effect,
            });
          }
          nextById.set(
            agent.agentId,
            Object.freeze({
              agentId: agent.agentId,
              enabled: false,
              scope: agent.scope,
              modelCount: 0,
            }),
          );
          return Object.freeze({
            agentId: agent.agentId,
            outcome: "ok",
            effect,
          });
        } catch (error) {
          return Object.freeze({
            agentId: agent.agentId,
            outcome: "failed",
            effect: failedEffect(error),
          });
        }
      }),
    );
    const next: StoredState = Object.freeze({
      schemaVersion: STATE_SCHEMA,
      agents: Object.freeze(
        state.agents.map((agent) => nextById.get(agent.agentId) ?? agent),
      ),
    });
    if (nextById.size > 0) await writeState(next);
    return Object.freeze({
      outcome: aggregateOutcome(results),
      state: await project(next, currentSnapshot),
      results: Object.freeze(results),
    });
  };

  const performShutdown = async (): Promise<AgentIntegrationsCommandResult> => {
    const state = await readState();
    const nextById = new Map<AgentIntegrationId, StoredAgentState>();
    const results = await Promise.all(
      state.agents.map(async (agent): Promise<AgentIntegrationOperationResult> => {
        const adapter = adapterById.get(agent.agentId);
        if (adapter === undefined) throw new Error(`Missing adapter: ${agent.agentId}`);
        try {
          const effect = await adapter.restore();
          if (effect.observedState !== "native") {
            return Object.freeze({
              agentId: agent.agentId,
              outcome: "failed",
              effect,
            });
          }
          nextById.set(
            agent.agentId,
            Object.freeze({
              agentId: agent.agentId,
              enabled: agent.enabled,
              scope: agent.scope,
              modelCount: 0,
            }),
          );
          return Object.freeze({
            agentId: agent.agentId,
            outcome: "ok",
            effect,
          });
        } catch (error) {
          return Object.freeze({
            agentId: agent.agentId,
            outcome: "failed",
            effect: failedEffect(error),
          });
        }
      }),
    );
    const next: StoredState = Object.freeze({
      schemaVersion: STATE_SCHEMA,
      agents: Object.freeze(
        state.agents.map((agent) => nextById.get(agent.agentId) ?? agent),
      ),
    });
    if (nextById.size > 0) await writeState(next);
    const commandResult: AgentIntegrationsCommandResult = Object.freeze({
      outcome: aggregateOutcome(results),
      state: await project(next),
      results: Object.freeze(results),
    });
    if (commandResult.outcome !== "ok") {
      throw new Error(
        "Agent integrations could not all be restored before Token shutdown",
      );
    }
    return commandResult;
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = operationQueue.then(operation);
    operationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  return Object.freeze({
    query: async () => {
      await operationQueue;
      return project(await readState());
    },
    setEnabled,
    setScope: (agentId: AgentIntegrationId, scope: AgentInjectionScope) =>
      enqueue(() => performSetScope(agentId, scope)),
    sync: () => enqueue(() => performApply("sync")),
    startup: () => enqueue(() => performApply("startup")),
    shutdown: () => enqueue(performShutdown),
  });
}
