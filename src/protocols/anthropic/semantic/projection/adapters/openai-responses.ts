import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type { AnthropicEffortPlan } from "../../reasoning/contract.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
  AnthropicProjectionOutcomeId,
} from "../contract.js";

export type AnthropicResponsesTargetApi =
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses";

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
  api: AnthropicResponsesTargetApi,
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
    projector: `anthropic-to-${api}`,
    warning: "pi-native-mapping-repaired",
  });
}

function mappedToolChoice(
  invocation: AnthropicSemanticInvocation,
): unknown | undefined {
  const choice = invocation.supplement.controls.toolChoice?.value;
  if (choice === undefined) return undefined;
  if (choice.kind === "none") return "none";
  if (choice.kind === "auto") return "auto";
  if (choice.kind === "any") return "required";
  if (choice.kind === "named") return { type: "function", name: choice.name };
  return undefined;
}

function clearResponsesReasoning(payload: Record<string, unknown>): void {
  delete payload.reasoning;
  if (Array.isArray(payload.include)) {
    const include = payload.include.filter(
      (value) => value !== "reasoning.encrypted_content",
    );
    if (include.length === 0) delete payload.include;
    else payload.include = include;
  }
}

function projectReasoning(
  input: {
    readonly api: AnthropicResponsesTargetApi;
    readonly model: Model<string>;
    readonly invocation: AnthropicSemanticInvocation;
    readonly effortPlan: AnthropicEffortPlan;
  },
  payload: Record<string, unknown>,
  outcomes: AnthropicProjectionOutcome[],
): void {
  const activation = input.invocation.reasoning.activation;
  const effort = input.invocation.reasoning.effort;
  const effortPlan = input.effortPlan;
  if (
    effortPlan.kind === "specified" &&
    effortPlan.selection.kind !== "selected"
  ) {
    clearResponsesReasoning(payload);
    add(outcomes, "reasoning.effort", {
      kind: "degraded",
      warning:
        effortPlan.selection.kind === "non-reasoning"
          ? `${input.api} target model does not support reasoning; ordinary generation was retained`
          : `${input.api} target model exposes no selectable reasoning level; Provider default was retained`,
    });
    return;
  }
  if (activation.kind === "disabled" && !input.model.reasoning) {
    clearResponsesReasoning(payload);
    add(outcomes, "reasoning.activation", { kind: "pi-native" });
    return;
  }
  if (activation.kind === "disabled" && input.model.thinkingLevelMap?.off === null) {
    clearResponsesReasoning(payload);
    add(outcomes, "reasoning.activation", {
      kind: "degraded",
      warning: `${input.api} model ${input.model.id} used its target reasoning default because it has no exact disable value`,
    });
    return;
  }
  if (activation.kind === "enabled" || activation.kind === "adaptive") {
    if (!input.model.reasoning) clearResponsesReasoning(payload);
    add(outcomes, "reasoning.activation", {
      kind: "degraded",
      warning: input.model.reasoning
        ? `${input.api} used Pi's nearest reasoning mode instead of the exact Anthropic ${activation.kind} mode`
        : `${input.api} target does not support reasoning; ordinary generation was used`,
    });
    if (effort.kind === "specified") {
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "reasoning effort cannot be applied together with an explicit Anthropic thinking activation",
      });
    }
    return;
  }
  let expected: Record<string, unknown> | undefined;
  if (activation.kind === "disabled") {
    expected = { effort: input.model.thinkingLevelMap?.off ?? "none" };
  } else if (
    activation.kind === "omitted" &&
    effortPlan.kind === "specified" &&
    effortPlan.selection.kind === "selected"
  ) {
    expected = {
      effort:
        input.model.thinkingLevelMap?.[effortPlan.selection.level] ??
        effortPlan.selection.level,
      summary: "auto",
    };
  } else if (activation.kind === "omitted" && effort.kind === "explicit-null") {
    expected = undefined;
  } else if (activation.kind === "omitted" && effort.kind === "omitted") {
    // Source omission means Provider default, not Pi's synthesized `none`.
    expected = undefined;
  }
  if (expected === undefined) {
    if (payload.reasoning !== undefined) {
      delete payload.reasoning;
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: `anthropic-to-${input.api}`,
        warning: "pi-native-mapping-repaired",
      });
    }
    return;
  }
  const control = activation.kind === "disabled"
    ? "reasoning.activation"
    : "reasoning.effort";
  if (same(payload.reasoning, expected)) {
    add(
      outcomes,
      control,
      control === "reasoning.effort" &&
        effortPlan.kind === "specified" &&
        effortPlan.selection.kind === "selected" &&
        effortPlan.requested !== effortPlan.selection.level
        ? {
            kind: "degraded",
            warning: `requested reasoning level ${effortPlan.requested} mapped to supported Pi level ${effortPlan.selection.level}`,
          }
        : { kind: "pi-native" },
    );
  } else {
    clearResponsesReasoning(payload);
    add(outcomes, control, {
      kind: "omitted",
      warning: `${input.api} Pi payload did not contain the certified reasoning control`,
    });
    return;
  }
  if (input.model.reasoning) {
    const include = Array.isArray(payload.include) ? [...payload.include] : [];
    if (!include.includes("reasoning.encrypted_content")) {
      include.push("reasoning.encrypted_content");
      payload.include = include;
    }
  }
}

type ProjectionInput = {
  readonly api: AnthropicResponsesTargetApi;
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly effortPlan: AnthropicEffortPlan;
  readonly payload: unknown;
};

function projectAnthropicToOpenAIResponses(
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
    throw new Error(`${input.api} payload must be an object`);
  }
  const payload = structuredClone(input.payload) as Record<string, unknown>;
  if (
    typeof payload.model !== "string" ||
    !Array.isArray(payload.input) ||
    payload.stream !== true
  ) {
    throw new Error(`${input.api} payload shape mismatch`);
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  if (phase === "supplement") {
  if (input.api !== "openai-codex-responses") {
    const piMaxTokens = payload.max_output_tokens;
    if (typeof piMaxTokens !== "number") {
      throw new Error(`${input.api} payload shape mismatch at max_output_tokens`);
    }
    const finalMaxTokens = Math.min(
      piMaxTokens,
      supplement.controls.outputTokenCeiling.value,
    );
    exact(
      outcomes,
      input.api,
      "maxTokens",
      piMaxTokens,
      finalMaxTokens,
      () => {
        payload.max_output_tokens = finalMaxTokens;
      },
    );
  }
  for (const [control, field, value] of [
    ["sampling.temperature", "temperature", supplement.controls.temperature?.value],
    ["sampling.topP", "top_p", supplement.controls.topP?.value],
  ] as const) {
    if (value === undefined) continue;
    if (control === "sampling.temperature") {
      if (same(payload[field], value)) {
        add(outcomes, control, { kind: "pi-native" });
      }
      continue;
    }
    exact(outcomes, input.api, control, payload[field], value, () => {
      payload[field] = value;
    });
  }
  const format = supplement.controls.outputFormat?.value;
  if (format?.kind === "json-schema") {
    const text =
      typeof payload.text === "object" && payload.text !== null && !Array.isArray(payload.text)
        ? { ...(payload.text as Record<string, unknown>) }
        : {};
    text.format = {
      type: "json_schema",
      name: "anthropic_output",
      strict: true,
      schema: format.schema,
    };
    payload.text = text;
    add(outcomes, "outputFormat", {
      kind: "payload-projected",
      projector: `anthropic-to-${input.api}`,
    });
  } else if (format === null) {
    if (typeof payload.text === "object" && payload.text !== null && !Array.isArray(payload.text)) {
      const text = { ...(payload.text as Record<string, unknown>) };
      delete text.format;
      payload.text = text;
    }
    add(outcomes, "outputFormat", { kind: "pi-native" });
  }

  const choice = mappedToolChoice(input.invocation);
  if (choice !== undefined) {
    const sourceChoice = supplement.controls.toolChoice!.value;
    const needsSerial =
      sourceChoice.kind !== "none" && sourceChoice.disableParallelToolUse;
    const choiceExact = same(payload.tool_choice, choice);
    const serialExact = !needsSerial || same(payload.parallel_tool_calls, false);
    if (!choiceExact) payload.tool_choice = choice;
    if (needsSerial && !serialExact) payload.parallel_tool_calls = false;
    add(
      outcomes,
      "toolChoice",
      choiceExact && serialExact
        ? { kind: "pi-native" }
        : {
            kind: "payload-projected",
            projector: `anthropic-to-${input.api}`,
            warning: "pi-native-mapping-repaired",
          },
    );
  }

  if (supplement.controls.metadataUserId?.value !== null && supplement.controls.metadataUserId !== undefined) {
    const userId = supplement.controls.metadataUserId.value;
    exact(
      outcomes,
      input.api,
      "metadataUserId",
      payload.user,
      userId,
      () => {
        payload.user = userId;
      },
    );
  } else if (supplement.controls.metadataUserId?.value === null) {
    delete payload.user;
  }
  if (supplement.controls.serviceTier?.value !== null && supplement.controls.serviceTier !== undefined) {
    const tier = supplement.controls.serviceTier.value === "standard_only" ? "default" : "auto";
    exact(outcomes, input.api, "serviceTier", payload.service_tier, tier, () => {
      payload.service_tier = tier;
    });
  }
  } else {
    projectReasoning(input, payload, outcomes);
  }
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}

export function projectAnthropicToOpenAIResponsesReasoning(
  input: ProjectionInput,
) {
  return projectAnthropicToOpenAIResponses(input, "reasoning");
}

export function projectAnthropicToOpenAIResponsesSupplement(
  input: ProjectionInput,
) {
  return projectAnthropicToOpenAIResponses(input, "supplement");
}
