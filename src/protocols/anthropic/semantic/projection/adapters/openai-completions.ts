import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
} from "../contract.js";

export interface AnthropicOpenAICompletionsProjectionResult {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
  readonly failure?: string;
}

const TOP_K_CERTIFIED_PROVIDERS = new Set([
  "commandcode-private",
  "commandcode-goat",
  "opencode-go",
]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("openai-completions payload must be an object");
  }
  return structuredClone(value) as Record<string, unknown>;
}

function requirePayloadShape(payload: Record<string, unknown>): void {
  if (
    typeof payload.model !== "string" ||
    !Array.isArray(payload.messages) ||
    payload.stream !== true
  ) {
    throw new Error("openai-completions payload shape mismatch");
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function add(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  outcome: AnthropicProjectionDisposition,
): void {
  outcomes.push(Object.freeze({ control, outcome: Object.freeze(outcome) }));
}

function exact(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  current: unknown,
  expected: unknown,
  assign: () => void,
): void {
  if (same(current, expected)) {
    add(outcomes, control, { kind: "pi-native" });
    return;
  }
  assign();
  add(outcomes, control, {
    kind: "payload-projected",
    projector: "anthropic-to-openai-completions",
    warning: "pi-native-mapping-repaired",
  });
}

function forcedToolChoiceFailure(
  model: Model<string>,
  invocation: AnthropicSemanticInvocation,
): string | undefined {
  const choice = invocation.supplement.toolChoice;
  if (choice?.kind !== "any" && choice?.kind !== "named") return undefined;
  if (
    model.provider === "commandcode-goat" &&
    model.id === "deepseek/deepseek-v4-flash"
  ) {
    return "CommandCode Goat deepseek-v4-flash thinking mode does not support forced tool_choice";
  }
  return undefined;
}

export function initialOpenAICompletionsFailure(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  const forcedFailure = forcedToolChoiceFailure(input.model, input.invocation);
  if (forcedFailure !== undefined) return forcedFailure;
  if (input.invocation.supplement.inferenceGeo.kind === "specified") {
    return "openai-completions has no certified inference geography control";
  }
  const activation = input.invocation.reasoning.activation;
  if (activation.kind === "adaptive") {
    return "openai-completions has no certified adaptive-thinking control";
  }
  if (activation.kind === "enabled") {
    return "openai-completions has no certified exact Anthropic thinking budget control";
  }
  return undefined;
}

function projectReasoning(
  payload: Record<string, unknown>,
  model: Model<string>,
  invocation: AnthropicSemanticInvocation,
  outcomes: AnthropicProjectionOutcome[],
): string | undefined {
  const activation = invocation.reasoning.activation;
  const effort = invocation.reasoning.effort;
  if (activation.kind === "omitted") {
    if (Object.hasOwn(payload, "thinking")) {
      delete payload.thinking;
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-openai-completions",
        warning: "pi-native-mapping-repaired",
      });
    }
  } else if (activation.kind === "disabled") {
    if (model.thinkingLevelMap?.off === null) {
      return "openai-completions target cannot express explicit reasoning disable";
    }
    const disabled = model.thinkingLevelMap?.off ?? "none";
    exact(
      outcomes,
      "reasoning.activation",
      payload.reasoning_effort,
      disabled,
      () => {
        payload.reasoning_effort = disabled;
      },
    );
    if (typeof payload.thinking === "object" && payload.thinking !== null) {
      payload.thinking = { type: "disabled" };
    }
  }

  if (effort.kind === "specified") {
    if (model.reasoning !== true) {
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "target model does not support reasoning effort",
      });
    } else {
      const mapped = model.thinkingLevelMap?.[effort.level] ?? effort.level;
      if (mapped === null) {
        return "openai-completions target cannot express requested reasoning effort";
      }
      exact(
        outcomes,
        "reasoning.effort",
        payload.reasoning_effort,
        mapped,
        () => {
          payload.reasoning_effort = mapped;
        },
      );
    }
  } else if (effort.kind === "omitted" && activation.kind === "omitted") {
    delete payload.reasoning_effort;
  }
  return undefined;
}

export function projectAnthropicToOpenAICompletions(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly payload: unknown;
}): AnthropicOpenAICompletionsProjectionResult {
  const payload = record(input.payload);
  requirePayloadShape(payload);
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  const maxField = Object.hasOwn(payload, "max_completion_tokens")
    ? "max_completion_tokens"
    : Object.hasOwn(payload, "max_tokens")
      ? "max_tokens"
      : undefined;
  if (maxField === undefined || typeof payload[maxField] !== "number") {
    return {
      payload,
      outcomes,
      failure: "openai-completions payload has no audited output-token field",
    };
  }
  exact(
    outcomes,
    "maxTokens",
    payload[maxField],
    supplement.maxTokens,
    () => {
      payload[maxField] = supplement.maxTokens;
    },
  );

  for (const [control, field, value] of [
    ["sampling.temperature", "temperature", supplement.sampling.temperature],
    ["sampling.topP", "top_p", supplement.sampling.topP],
  ] as const) {
    if (value === undefined) continue;
    exact(outcomes, control, payload[field], value, () => {
      payload[field] = value;
    });
  }
  if (supplement.sampling.topK !== undefined) {
    if (TOP_K_CERTIFIED_PROVIDERS.has(input.model.provider)) {
      exact(
        outcomes,
        "sampling.topK",
        payload.top_k,
        supplement.sampling.topK,
        () => {
          payload.top_k = supplement.sampling.topK;
        },
      );
    } else {
      delete payload.top_k;
      add(outcomes, "sampling.topK", {
        kind: "omitted",
        warning: "target Provider has no certified top_k mapping",
      });
    }
  }

  if (supplement.stopSequences !== undefined) {
    exact(
      outcomes,
      "stopSequences",
      payload.stop,
      supplement.stopSequences,
      () => {
        payload.stop = [...supplement.stopSequences!];
      },
    );
  }

  const choice = supplement.toolChoice;
  if (choice !== undefined) {
    const mapped =
      choice.kind === "named"
        ? { type: "function", function: { name: choice.name } }
        : choice.kind === "any"
          ? "required"
          : choice.kind;
    exact(outcomes, "toolChoice", payload.tool_choice, mapped, () => {
      payload.tool_choice = mapped;
    });
    if (choice.kind !== "none") {
      exact(
        outcomes,
        "toolChoice.disableParallelToolUse",
        payload.parallel_tool_calls,
        !choice.disableParallelToolUse,
        () => {
          payload.parallel_tool_calls = !choice.disableParallelToolUse;
        },
      );
    }
  }

  const format = supplement.outputFormat;
  if (format.kind === "specified") {
    const mapped = {
      type: "json_schema",
      json_schema: {
        name: "anthropic_output",
        strict: true,
        schema: format.value.schema,
      },
    };
    exact(outcomes, "outputFormat", payload.response_format, mapped, () => {
      payload.response_format = mapped;
    });
  } else if (format.kind === "explicit-null") {
    delete payload.response_format;
    add(outcomes, "outputFormat", { kind: "pi-native" });
  }

  const userId = supplement.metadataUserId;
  if (userId.kind === "specified") {
    exact(outcomes, "metadataUserId", payload.user, userId.value, () => {
      payload.user = userId.value;
    });
  } else if (userId.kind === "explicit-null") {
    delete payload.user;
    add(outcomes, "metadataUserId", { kind: "pi-native" });
  }

  const tier = supplement.serviceTier;
  if (tier.kind === "specified") {
    const mapped = tier.value === "standard_only" ? "default" : "auto";
    exact(outcomes, "serviceTier", payload.service_tier, mapped, () => {
      payload.service_tier = mapped;
    });
  }

  if (supplement.container.kind === "specified") {
    add(outcomes, "container", {
      kind: "omitted",
      warning: "container identity is not compatible with openai-completions",
    });
  }
  if (supplement.cacheControl.kind === "specified") {
    add(outcomes, "cacheControl", {
      kind: "omitted",
      warning: "Anthropic cache breakpoint has no exact Chat Completions mapping",
    });
  }

  const reasoningFailure = projectReasoning(
    payload,
    input.model,
    input.invocation,
    outcomes,
  );
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
    ...(reasoningFailure === undefined ? {} : { failure: reasoningFailure }),
  });
}
