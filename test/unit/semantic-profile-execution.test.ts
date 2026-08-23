import { describe, expect, it } from "vitest";
import { createUpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";

import { ExecutionFailure, type ExecutionOperation } from "../../src/execution.js";
import { createSemanticProfileExecution } from "../../src/semantic-conversion/profile-execution.js";
import {
  bindCredentialActivityToExecutionFacts,
  credentialActivityForExecutionFacts,
} from "../../src/credentials/activity.js";
import type {
  ManagedProviderAuthBindingCapture,
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";

function capture(
  credentialId: string,
  displayName: string,
  selectionGeneration: string,
): ManagedProviderAuthBindingCapture {
  return Object.freeze({
    facts: Object.freeze({
      kind: "managed" as const,
      providerId: "fixture-provider",
      credentialId,
      authType: "api_key" as const,
      authMethodLabel: "Fixture credentials",
      displayName,
      credentialGeneration: `generation-${credentialId}`,
      selectionGeneration,
    }),
  });
}

describe("Semantic Conversion Profile execution", () => {
  it("records the managed capture and exact 429 failover attempt trail", async () => {
    const primary = capture("credential-primary", "Production", "selection-1");
    const backup = capture("credential-backup", "Backup", "selection-2");
    let transitionInput: unknown;
    const bindings: Pick<
      ProviderAuthBindingAuthority,
      "capture" | "runBound" | "advanceAfterFinal429"
    > = {
      capture: async () => primary,
      runBound: async (_binding, operation) => operation(),
      advanceAfterFinal429: async (input) => {
        transitionInput = input;
        return { outcome: "switched", capture: backup };
      },
    };
    let executions = 0;
    const underlying: ExecutionOperation = async () => {
      executions += 1;
      if (executions === 1) {
        throw new ExecutionFailure(
          "rate limited",
          undefined,
          createUpstreamFailureFact({
            kind: "http",
            message: "rate limited",
            status: 429,
            headers: { "retry-after": "2" },
          }),
        );
      }
      return { role: "assistant", content: [], stopReason: "stop" } as never;
    };
    const captures: unknown[] = [];
    const attempts: unknown[] = [];
    const execute = createSemanticProfileExecution({
      bindings,
      execute: underlying,
      resolveCredentialActivity: credentialActivityForExecutionFacts,
    });

    const executionFacts = {
      notice: () => undefined,
      attempt: () => undefined,
    };
    bindCredentialActivityToExecutionFacts(executionFacts, {
      credentialCaptured: (value: unknown) => captures.push(value),
      credentialAttempt: (value: unknown) => attempts.push(value),
    });
    await execute(
      {} as never,
      { provider: "fixture-provider" } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
      executionFacts,
    );

    expect(captures).toEqual([
      expect.objectContaining({
        credentialId: "credential-primary",
        lane: "semantic_conversion",
        selectionReason: "active",
      }),
    ]);
    expect(attempts).toEqual([
      expect.objectContaining({
        credentialId: "credential-primary",
        outcome: "http_429",
        attempt: 1,
      }),
      expect.objectContaining({
        credentialId: "credential-backup",
        selectionReason: "http_429_switch",
        outcome: "success",
        attempt: 2,
      }),
    ]);
    expect(transitionInput).toMatchObject({
      retryAfterMs: 2_000,
      attemptedCredentialIds: ["credential-primary"],
    });
  });

  it("never enters the managed Profile transition for ambient auth", async () => {
    let transitions = 0;
    const execute = createSemanticProfileExecution({
      bindings: {
        capture: async () => ({
          facts: { kind: "ambient" as const, providerId: "fixture-provider" },
        }),
        runBound: async (_binding, operation) => operation(),
        advanceAfterFinal429: async () => {
          transitions += 1;
          return { outcome: "disabled" };
        },
      },
      execute: async () => {
        throw new ExecutionFailure(
          "rate limited",
          undefined,
          createUpstreamFailureFact({
            kind: "http",
            message: "rate limited",
            status: 429,
          }),
        );
      },
      resolveCredentialActivity: credentialActivityForExecutionFacts,
    });

    await expect(execute(
      {} as never,
      { provider: "fixture-provider" } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    )).rejects.toBeInstanceOf(ExecutionFailure);
    expect(transitions).toBe(0);
  });

  it("stops after three outer Profile attempts even if a binding Adapter keeps switching", async () => {
    const candidates = [1, 2, 3, 4].map((index) =>
      capture(`credential-${index}`, `Profile ${index}`, `selection-${index}`),
    );
    let transitions = 0;
    const bindings = {
      capture: async () => candidates[0]!,
      runBound: async <T>(_binding: ProviderAuthBindingCapture, operation: () => Promise<T>) =>
        operation(),
      advanceAfterFinal429: async () => ({
        outcome: "switched" as const,
        capture: candidates[++transitions]!,
      }),
    };
    let executions = 0;
    const execute = createSemanticProfileExecution({
      bindings,
      execute: async () => {
        executions += 1;
        throw new ExecutionFailure(
          "rate limited",
          undefined,
          createUpstreamFailureFact({
            kind: "http",
            message: "rate limited",
            status: 429,
          }),
        );
      },
      resolveCredentialActivity: credentialActivityForExecutionFacts,
    });

    await expect(execute(
      {} as never,
      { provider: "fixture-provider" } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    )).rejects.toBeInstanceOf(ExecutionFailure);
    expect(executions).toBe(3);
    expect(transitions).toBe(2);
  });
});
