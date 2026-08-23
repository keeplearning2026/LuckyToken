import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
} from "../contract.js";

function add(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  outcome: AnthropicProjectionDisposition,
): void {
  outcomes.push(Object.freeze({ control, outcome: Object.freeze(outcome) }));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exact(
  outcomes: AnthropicProjectionOutcome[],
  family: "claude" | "non-claude",
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
    projector: `anthropic-to-bedrock-${family}`,
    warning: "pi-native-mapping-repaired",
  });
}

export function isBedrockClaudeModel(model: Model<string>): boolean {
  return [model.id, model.name].some((value) => {
    const lower = value.toLowerCase();
    return (
      lower.includes("anthropic.claude") ||
      lower.includes("anthropic/claude") ||
      lower.includes("claude")
    );
  });
}

function supportsAdaptive(model: Model<string>): boolean {
  const candidates = [model.id, model.name].flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/gu, "-")];
  });
  return candidates.some(
    (value) =>
      value.includes("opus-4-6") ||
      value.includes("opus-4-7") ||
      value.includes("opus-4-8") ||
      value.includes("opus-5") ||
      value.includes("sonnet-4-6") ||
      value.includes("sonnet-5") ||
      value.includes("fable-5"),
  );
}

export function initialBedrockFailure(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  const family = isBedrockClaudeModel(input.model) ? "Claude" : "non-Claude";
  if (input.invocation.supplement.inferenceGeo.kind === "specified") {
    return `Bedrock ${family} payload cannot select inference geography`;
  }
  const choice = input.invocation.supplement.toolChoice;
  if (
    choice !== undefined &&
    choice.kind !== "none" &&
    choice.disableParallelToolUse
  ) {
    return `Bedrock ${family} cannot guarantee serial tool calls`;
  }
  const activation = input.invocation.reasoning.activation;
  if (!isBedrockClaudeModel(input.model)) {
    if (activation.kind === "enabled" || activation.kind === "adaptive") {
      return "Bedrock non-Claude target cannot preserve Anthropic thinking";
    }
    if (input.invocation.reasoning.effort.kind === "specified") {
      return "Bedrock non-Claude target has no certified Anthropic effort control";
    }
    if (input.invocation.supplement.outputFormat.kind === "specified") {
      return "Bedrock non-Claude target has no certified structured-output control";
    }
  } else if (activation.kind === "adaptive" && !supportsAdaptive(input.model)) {
    return `Bedrock Claude model ${input.model.id} does not support adaptive thinking`;
  }
  return undefined;
}

function mappedToolChoice(
  invocation: AnthropicSemanticInvocation,
): Record<string, unknown> | undefined {
  const choice = invocation.supplement.toolChoice;
  if (choice === undefined || choice.kind === "none") return undefined;
  if (choice.kind === "auto") return { auto: {} };
  if (choice.kind === "any") return { any: {} };
  if (choice.kind === "named") return { tool: { name: choice.name } };
  return undefined;
}

function displayValue(
  intent:
    | { readonly kind: "omitted" }
    | { readonly kind: "explicit-null" }
    | { readonly kind: "specified"; readonly value: "summarized" | "omitted" },
): "summarized" | "omitted" | undefined {
  return intent.kind === "specified" ? intent.value : undefined;
}

export function projectAnthropicToBedrock(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly payload: unknown;
}): {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
} {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw new Error("bedrock-converse-stream payload must be an object");
  }
  const payload = structuredClone(input.payload) as Record<string, unknown>;
  if (
    typeof payload.modelId !== "string" ||
    !Array.isArray(payload.messages) ||
    typeof payload.inferenceConfig !== "object" ||
    payload.inferenceConfig === null ||
    Array.isArray(payload.inferenceConfig)
  ) {
    throw new Error("bedrock-converse-stream payload shape mismatch");
  }
  const claude = isBedrockClaudeModel(input.model);
  const family = claude ? "claude" : "non-claude";
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;
  const inference = { ...(payload.inferenceConfig as Record<string, unknown>) };

  exact(outcomes, family, "maxTokens", inference.maxTokens, supplement.maxTokens, () => {
    inference.maxTokens = supplement.maxTokens;
  });
  for (const [control, field, value] of [
    ["sampling.temperature", "temperature", supplement.sampling.temperature],
    ["sampling.topP", "topP", supplement.sampling.topP],
  ] as const) {
    if (value === undefined) continue;
    exact(outcomes, family, control, inference[field], value, () => {
      inference[field] = value;
    });
  }
  if (supplement.stopSequences !== undefined) {
    exact(
      outcomes,
      family,
      "stopSequences",
      inference.stopSequences,
      supplement.stopSequences,
      () => {
        inference.stopSequences = [...supplement.stopSequences!];
      },
    );
  }
  payload.inferenceConfig = inference;

  const choice = supplement.toolChoice;
  if (choice?.kind === "none") {
    delete payload.toolConfig;
    add(outcomes, "toolChoice", {
      kind: "payload-projected",
      projector: `anthropic-to-bedrock-${family}`,
    });
  } else {
    const mapped = mappedToolChoice(input.invocation);
    if (mapped !== undefined) {
      if (
        typeof payload.toolConfig !== "object" ||
        payload.toolConfig === null ||
        Array.isArray(payload.toolConfig)
      ) {
        throw new Error("bedrock tool choice requires a projected toolConfig");
      }
      const toolConfig = { ...(payload.toolConfig as Record<string, unknown>) };
      exact(outcomes, family, "toolChoice", toolConfig.toolChoice, mapped, () => {
        toolConfig.toolChoice = mapped;
      });
      payload.toolConfig = toolConfig;
    }
  }

  const additional =
    typeof payload.additionalModelRequestFields === "object" &&
    payload.additionalModelRequestFields !== null &&
    !Array.isArray(payload.additionalModelRequestFields)
      ? { ...(payload.additionalModelRequestFields as Record<string, unknown>) }
      : {};
  if (claude && supplement.sampling.topK !== undefined) {
    exact(outcomes, family, "sampling.topK", additional.top_k, supplement.sampling.topK, () => {
      additional.top_k = supplement.sampling.topK;
    });
  } else if (supplement.sampling.topK !== undefined) {
    add(outcomes, "sampling.topK", {
      kind: "omitted",
      warning: "Bedrock non-Claude has no certified top-k control",
    });
  }

  if (claude) {
    const activation = input.invocation.reasoning.activation;
    if (activation.kind === "enabled") {
      const display = displayValue(activation.display);
      additional.thinking = {
        type: "enabled",
        budget_tokens: activation.budgetTokens,
        ...(display === undefined ? {} : { display }),
      };
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-bedrock-claude",
      });
    } else if (activation.kind === "adaptive") {
      const display = displayValue(activation.display);
      additional.thinking = {
        type: "adaptive",
        ...(display === undefined ? {} : { display }),
      };
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-bedrock-claude",
      });
    } else {
      delete additional.thinking;
      delete additional.anthropic_beta;
    }

    const format = supplement.outputFormat;
    const effort = input.invocation.reasoning.effort;
    if (format.kind === "specified" || effort.kind === "specified") {
      const outputConfig =
        typeof additional.output_config === "object" &&
        additional.output_config !== null &&
        !Array.isArray(additional.output_config)
          ? { ...(additional.output_config as Record<string, unknown>) }
          : {};
      if (format.kind === "specified") {
        outputConfig.format = {
          type: "json_schema",
          schema: format.value.schema,
        };
        add(outcomes, "outputFormat", {
          kind: "payload-projected",
          projector: "anthropic-to-bedrock-claude",
        });
      }
      if (effort.kind === "specified") {
        outputConfig.effort = effort.level;
        add(outcomes, "reasoning.effort", {
          kind: "payload-projected",
          projector: "anthropic-to-bedrock-claude",
        });
      }
      additional.output_config = outputConfig;
    } else if (format.kind === "explicit-null" || effort.kind === "explicit-null") {
      delete additional.output_config;
    }
  }
  payload.additionalModelRequestFields =
    Object.keys(additional).length === 0 ? undefined : additional;

  for (const [control, intent] of [
    ["metadataUserId", supplement.metadataUserId],
    ["serviceTier", supplement.serviceTier],
    ["container", supplement.container],
    ["cacheControl", supplement.cacheControl],
  ] as const) {
    if (intent.kind === "specified") {
      add(outcomes, control, {
        kind: "omitted",
        warning: `bedrock-converse-stream ${family} has no certified equivalent`,
      });
    }
  }
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}
