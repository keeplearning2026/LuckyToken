import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type { AnthropicEffortPlan } from "../../reasoning/contract.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
  AnthropicProjectionOutcomeId,
} from "../contract.js";

function add(
  outcomes: AnthropicProjectionOutcome[],
  candidateId: AnthropicProjectionOutcomeId,
  outcome: AnthropicProjectionDisposition,
): void {
  outcomes.push(Object.freeze({ candidateId, outcome: Object.freeze(outcome) }));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exact(
  outcomes: AnthropicProjectionOutcome[],
  family: "claude" | "non-claude",
  candidateId: AnthropicProjectionOutcomeId,
  current: unknown,
  expected: unknown,
  assign: () => void,
): void {
  if (same(current, expected)) {
    add(outcomes, candidateId, { kind: "pi-native" });
    return;
  }
  assign();
  add(outcomes, candidateId, {
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
  const choice = invocation.supplement.controls.toolChoice?.value;
  if (choice === undefined || choice.kind === "none") return undefined;
  if (choice.kind === "auto") return { auto: {} };
  if (choice.kind === "any") return { any: {} };
  if (choice.kind === "named") return { tool: { name: choice.name } };
  return undefined;
}

interface ProjectionInput {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly effortPlan: AnthropicEffortPlan;
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
    const finalMaxTokens = Math.min(inference.maxTokens, supplement.controls.outputTokenCeiling.value);
    exact(outcomes, family, "maxTokens", inference.maxTokens, finalMaxTokens, () => {
      inference.maxTokens = finalMaxTokens;
    });
    for (const [control, field, value] of [
      ["sampling.temperature", "temperature", supplement.controls.temperature?.value],
      ["sampling.topP", "topP", supplement.controls.topP?.value],
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
    if (supplement.controls.stopSequences !== undefined) {
      exact(
        outcomes,
        family,
        "stopSequences",
        inference.stopSequences,
        supplement.controls.stopSequences.value,
        () => {
          inference.stopSequences = [...supplement.controls.stopSequences!.value];
        },
      );
    }
  }
  payload.inferenceConfig = inference;

  const choice = supplement.controls.toolChoice?.value;
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
  if (phase === "supplement" && claude && supplement.controls.topK !== undefined) {
    exact(outcomes, family, "sampling.topK", additional.top_k, supplement.controls.topK.value, () => {
      additional.top_k = supplement.controls.topK!.value;
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
    const format = supplement.controls.outputFormat?.value;
    if (format?.kind === "json-schema") {
      outputConfig.format = {
        type: "json_schema",
        schema: format.schema,
      };
      add(outcomes, "outputFormat", {
        kind: "payload-projected",
        projector: "anthropic-to-bedrock-claude",
      });
    } else if (format === null) {
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
              "Bedrock Claude used its reasoning default after Token removed known enabling controls",
          }
        : { kind: "pi-native" });
    } else {
      delete additional.thinking;
      delete additional.anthropic_beta;
    }
    if (input.effortPlan.kind === "specified") {
      const selected = input.effortPlan.selection;
      const expectedEffort =
        selected.kind === "selected"
          ? input.model.thinkingLevelMap?.[selected.level]
          : undefined;
      if (
        activation.kind === "adaptive" &&
        typeof expectedEffort === "string" &&
        same(outputConfig.effort, expectedEffort)
      ) {
        add(
          outcomes,
          "reasoning.effort",
          selected.kind === "selected" &&
            input.effortPlan.requested !== selected.level
            ? {
                kind: "degraded",
                warning: `requested reasoning level ${input.effortPlan.requested} mapped to supported Pi level ${selected.level}`,
              }
            : { kind: "pi-native" },
        );
      } else {
        delete outputConfig.effort;
        add(outcomes, "reasoning.effort", {
          kind: "degraded",
          warning:
            selected.kind === "non-reasoning"
              ? "Bedrock Claude target does not support reasoning; ordinary generation was retained"
              : selected.kind === "no-selectable-level"
                ? "Bedrock Claude target exposes no selectable reasoning level; Provider default was retained"
                : activation.kind === "adaptive" && typeof expectedEffort === "string"
                  ? "Pi did not emit the selected Bedrock Claude reasoning effort; Provider default was retained"
                  : activation.kind === "adaptive"
              ? `Bedrock Claude model ${input.model.id} has no certified ${selected.level} effort mapping; Provider default was retained`
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
              "Bedrock non-Claude used its reasoning default after Token removed known enabling controls",
          }
        : { kind: "pi-native" });
    }
    if (input.effortPlan.kind === "specified") {
      add(outcomes, "reasoning.effort", {
        kind: "degraded",
        warning: "Bedrock non-Claude target has no certified Anthropic effort control; Provider default was retained",
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
