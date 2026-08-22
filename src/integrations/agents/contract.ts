import type { AgentInjectionSnapshot } from "./snapshot.js";

export type AgentIntegrationId = "codex" | "pi";

export type AgentInjectionScope = "favorite" | "full";

export type AgentIntegrationObservedState =
  | "native"
  | "managed"
  | "conflict"
  | "unavailable";

export interface AgentIntegrationEffect {
  readonly observedState: AgentIntegrationObservedState;
  readonly modelCount: number;
  readonly warnings: readonly string[];
  readonly changed: boolean;
  readonly message?: string;
}

export interface AgentIntegrationAdapter {
  readonly id: AgentIntegrationId;
  projectionFingerprint(
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ): Promise<string>;
  inject(
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ): Promise<AgentIntegrationEffect>;
  restore(): Promise<AgentIntegrationEffect>;
}
