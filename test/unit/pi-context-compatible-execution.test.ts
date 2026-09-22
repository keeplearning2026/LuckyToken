import type {
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createUpstreamFailureFact } from "@token/provider-contract/diagnostics";
import { describe, expect, it } from "vitest";

import { createProfileBoundPiExecution } from "../../src/credentials/profile-bound-pi-execution.js";
import type { ManagedProviderAuthBindingCapture } from "../../src/credentials/profile-contract.js";
import {
  ExecutionFailure,
  type ExecutionOperation,
} from "../../src/execution.js";
import { PiContextCompatibilityError } from "../../src/pi-context-compatibility.js";
import { createPiContextCompatibleExecution } from "../../src/pi-context-compatibility-execution.js";

function model(supportsMidConvoSystemMessages?: boolean): Model<"openai-responses"> {
  return {
    id: "model",
    name: "model",
    api: "openai-responses",
    provider: "fixture-provider",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...(supportsMidConvoSystemMessages === undefined
      ? {}
      : { compat: { supportsMidConvoSystemMessages } }),
  };
}

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-responses",
    provider: "fixture-provider",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

const models = {} as Models;
const options = {} as ModelsSimpleStreamOptions;

describe("Pi Context compatible execution", () => {
  it("passes the exact Context to the next execution when the model supports mid-system", async () => {
    const context: Context = {
      messages: [
        { role: "user", content: "before", timestamp: 1 },
        {
          role: "system",
          content: "later",
          sections: { policy: "updated" },
          timestamp: 2,
        },
      ],
    };
    let captured: Context | undefined;
    const next: ExecutionOperation = async (_models, _model, nextContext) => {
      captured = nextContext;
      return assistant();
    };

    await createPiContextCompatibleExecution(next)(
      models,
      model(true),
      context,
      options,
    );

    expect(captured).toBe(context);
  });

  it("degrades unsupported mid-system once and publishes a neutral compatibility warning", async () => {
    const context: Context = {
      messages: [
        { role: "user", content: "before", timestamp: 1 },
        { role: "system", content: "later", timestamp: 2 },
        { role: "user", content: "after", timestamp: 3 },
      ],
    };
    let captured: Context | undefined;
    const notices: unknown[] = [];
    const next: ExecutionOperation = async (_models, _model, nextContext) => {
      captured = nextContext;
      return assistant();
    };

    await createPiContextCompatibleExecution(next)(
      models,
      model(false),
      context,
      options,
      {
        notice: (notice) => notices.push(notice),
        attempt: () => undefined,
      },
    );

    expect(captured?.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
    ]);
    expect(notices).toEqual([
      {
        adapter: "pi-context-compatibility",
        direction: "request",
        code: "pi_mid_system_degraded_to_user",
        action: "degrade",
      },
    ]);
  });

  it("relocates a tool-span mid-system before invoking the next execution", async () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          api: "openai-responses",
          provider: "fixture-provider",
          model: "model",
          content: [{ type: "toolCall", id: "call", name: "lookup", arguments: {} }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        { role: "system", content: "later", timestamp: 2 },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "lookup",
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    let captured: Context | undefined;

    await createPiContextCompatibleExecution(async (_models, _model, nextContext) => {
      captured = nextContext;
      return assistant();
    })(models, model(false), context, options);

    expect(captured?.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
    ]);
  });

  it("fails before invoking the next execution when relocation cannot be proven", async () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          api: "openai-responses",
          provider: "fixture-provider",
          model: "model",
          content: [{ type: "toolCall", id: "call", name: "lookup", arguments: {} }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        { role: "system", content: "later", timestamp: 2 },
      ],
    };
    let executed = false;

    await expect(
      createPiContextCompatibleExecution(async () => {
        executed = true;
        return assistant();
      })(models, model(false), context, options),
    ).rejects.toBeInstanceOf(PiContextCompatibilityError);
    expect(executed).toBe(false);
  });

  it("runs compatibility once outside a two-attempt Profile 429 retry", async () => {
    const primary: ManagedProviderAuthBindingCapture = Object.freeze({
      facts: Object.freeze({
        kind: "managed" as const,
        providerId: "fixture-provider",
        credentialId: "primary",
        authType: "api_key" as const,
        authMethodLabel: "Fixture",
        displayName: "Primary",
        credentialGeneration: "generation-primary",
        selectionGeneration: "selection-primary",
      }),
    });
    const backup: ManagedProviderAuthBindingCapture = Object.freeze({
      facts: Object.freeze({
        ...primary.facts,
        credentialId: "backup",
        displayName: "Backup",
        credentialGeneration: "generation-backup",
        selectionGeneration: "selection-backup",
      }),
    });
    let attempts = 0;
    const raw: ExecutionOperation = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ExecutionFailure(
          "rate limited",
          undefined,
          createUpstreamFailureFact({
            kind: "http",
            message: "rate limited",
            status: 429,
          }),
        );
      }
      return assistant();
    };
    const profileBound = createProfileBoundPiExecution({
      bindings: {
        capture: async () => primary,
        runBound: async (_capture, operation) => operation(),
        advanceAfterFinal429: async () => ({ outcome: "switched", capture: backup }),
      },
      execute: raw,
      resolveCredentialActivity: () => undefined,
    });
    const compatible = createPiContextCompatibleExecution(profileBound);
    const notices: unknown[] = [];
    const context: Context = {
      messages: [
        { role: "user", content: "before", timestamp: 1 },
        { role: "system", content: "later", timestamp: 2 },
        { role: "user", content: "after", timestamp: 3 },
      ],
    };

    await compatible(models, model(false), context, options, {
      notice: (notice) => notices.push(notice),
      attempt: () => undefined,
    });

    expect(attempts).toBe(2);
    expect(notices.filter((notice) =>
      (notice as { code?: string }).code === "pi_mid_system_degraded_to_user",
    )).toHaveLength(1);
  });
});
