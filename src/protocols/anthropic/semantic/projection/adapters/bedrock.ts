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

interface CertifiedBedrockCapabilities {
  readonly family: "claude" | "non-claude";
  readonly adaptiveThinking: boolean;
  readonly explicitThinkingDisable: boolean;
}

const CERTIFIED_BEDROCK_MODELS = new Map<string, CertifiedBedrockCapabilities>([
  [
    "amazon-bedrock/us.anthropic.claude-sonnet-4-6",
    Object.freeze({
      family: "claude",
      adaptiveThinking: true,
      explicitThinkingDisable: false,
    }),
  ],
  [
    "amazon-bedrock/amazon.nova-pro-v1:0",
    Object.freeze({
      family: "non-claude",
      adaptiveThinking: false,
      explicitThinkingDisable: false,
    }),
  ],
]);

function certifiedBedrockCapabilities(
  model: Model<string>,
): CertifiedBedrockCapabilities | undefined {
  return CERTIFIED_BEDROCK_MODELS.get(`${model.provider}/${model.id}`);
}

export function supportsAnthropicBedrockProjection(
  model: Model<string>,
): boolean {
  return certifiedBedrockCapabilities(model) !== undefined;
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

interface ProjectionInput {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly payload: unknown;
}

function projectAnthropicToBedrock(
  input: ProjectionInput,
  phase: "reasoning" | "supplement",
): {
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
  const capabilities = certifiedBedrockCapabilities(input.model);
  if (capabilities === undefined) {
    throw new Error(
      `Bedrock model ${input.model.provider}/${input.model.id} is not certified for Anthropic semantic projection`,
    );
  }
  const claude = capabilities.family === "claude";
  const family = capabilities.family;
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;
  const inference = { ...(payload.inferenceConfig as Record<string, unknown>) };
  if (typeof inference.maxTokens !== "number") {
    throw new Error("bedrock-converse-stream payload shape mismatch at inferenceConfig.maxTokens");
  }

  if (phase === "supplement") {
    const finalMaxTokens = Math.min(inference.maxTokens, supplement.outputTokenCeiling);
    exact(outcomes, family, "maxTokens", inference.maxTokens, finalMaxTokens, () => {
      inference.maxTokens = finalMaxTokens;
    });
    for (const [control, field, value] of [
      ["sampling.temperature", "temperature", supplement.sampling.temperature],
      ["sampling.topP", "topP", supplement.sampling.topP],
    ] as const) {
      if (value === undefined) continue;
      if (control === "sampling.temperature") {
        if (same(inference[field], value)) {
          add(outcomes, control, { kind: "pi-native" });
        }
        continue;
      }
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
  }
  payload.inferenceConfig = inference;

  const choice = supplement.toolChoice;
  if (phase === "supplement" && choice?.kind === "none") {
    delete payload.toolConfig;
    add(outcomes, "toolChoice", {
      kind: "payload-projected",
      projector: `anthropic-to-bedrock-${family}`,
    });
  } else if (phase === "supplement") {
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
  if (phase === "supplement" && claude && supplement.sampling.topK !== undefined) {
    exact(outcomes, family, "sampling.topK", additional.top_k, supplement.sampling.topK, () => {
      additional.top_k = supplement.sampling.topK;
    });
  }

  const activation = input.invocation.reasoning.activation;
  const effort = input.invocation.reasoning.effort;
  const outputConfig =
    typeof additional.output_config === "object" &&
    additional.output_config !== null &&
    !Array.isArray(additional.output_config)
      ? { ...(additional.output_config as Record<string, unknown>) }
      : {};
  if (phase === "supplement" && claude) {
    const format = supplement.outputFormat;
    if (format.kind === "specified") {
      outputConfig.format = {
        type: "json_schema",
        schema: format.value.schema,
      };
      add(outcomes, "outputFormat", {
        kind: "payload-projected",
        projector: "anthropic-to-bedrock-claude",
      });
    } else if (format.kind === "explicit-null") {
      delete outputConfig.format;
      add(outcomes, "outputFormat", {
        kind: "payload-projected",
        projector: "anthropic-to-bedrock-claude",
      });
    }
  }
  if (phase === "reasoning" && claude) {
    const finalMaxTokens = inference.maxTokens;
    const thinkingBudgetDoesNotFit =
      activation.kind === "enabled" &&
      activation.budgetTokens >= finalMaxTokens;
    if (thinkingBudgetDoesNotFit) {
      delete additional.thinking;
      delete additional.anthropic_beta;
      add(outcomes, "reasoning.activation", {
        kind: "degraded",
        warning:
          "Bedrock Claude thinking budget no longer fits below the context-safe final maxTokens ceiling; reasoning was disabled for this request",
      });
    } else if (activation.kind === "enabled") {
      additional.thinking = {
        type: "enabled",
        budget_tokens: activation.budgetTokens,
      };
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-bedrock-claude",
      });
    } else if (activation.kind === "adaptive") {
      additional.thinking = {
        type: "adaptive",
      };
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-bedrock-claude",
      });
    } else if (activation.kind === "disabled") {
      delete additional.thinking;
      delete additional.anthropic_beta;
      add(outcomes, "reasoning.activation", input.model.reasoning
        ? {
            kind: "degraded",
            warning:
              "Bedrock Claude used its reasoning default after LuckyToken removed known enabling controls",
          }
        : { kind: "pi-native" });
    } else {
      delete additional.thinking;
      delete additional.anthropic_beta;
    }
    if (effort.kind === "specified") {
      const explicit = input.model.thinkingLevelMap?.[effort.level];
      const expectedEffort =
        explicit === null
          ? undefined
          : typeof explicit === "string"
            ? explicit
            : effort.level === "low" || effort.level === "medium" || effort.level === "high"
              ? effort.level
              : undefined;
      if (
        activation.kind === "adaptive" &&
        expectedEffort !== undefined &&
        same(outputConfig.effort, expectedEffort)
      ) {
        add(outcomes, "reasoning.effort", { kind: "pi-native" });
      } else {
        delete outputConfig.effort;
        add(outcomes, "reasoning.effort", {
          kind: "omitted",
          warning:
            activation.kind === "adaptive" && expectedEffort !== undefined
              ? "Pi did not emit the certified Bedrock Claude reasoning effort"
              : activation.kind === "adaptive"
              ? `Bedrock Claude model ${input.model.id} has no certified ${effort.level} effort mapping`
              : "Bedrock Claude effort requires an explicit adaptive-thinking source activation",
        });
      }
    } else if (effort.kind === "explicit-null") {
      delete outputConfig.effort;
    }
  } else if (phase === "reasoning") {
    if (activation.kind === "disabled") {
      add(outcomes, "reasoning.activation", input.model.reasoning
        ? {
            kind: "degraded",
            warning:
              "Bedrock non-Claude used its reasoning default after LuckyToken removed known enabling controls",
          }
        : { kind: "pi-native" });
    }
    if (effort.kind === "specified") {
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "Bedrock non-Claude target has no certified Anthropic effort control",
      });
    }
  }
  if (Object.keys(outputConfig).length === 0) delete additional.output_config;
  else additional.output_config = outputConfig;
  payload.additionalModelRequestFields =
    Object.keys(additional).length === 0 ? undefined : additional;

  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}

export function projectAnthropicToBedrockReasoning(input: ProjectionInput) {
  return projectAnthropicToBedrock(input, "reasoning");
}

export function projectAnthropicToBedrockSupplement(input: ProjectionInput) {
  return projectAnthropicToBedrock(input, "supplement");
}
