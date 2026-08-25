import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicEffortPlan,
  AnthropicSelectedPiEffort,
} from "../../reasoning/contract.js";
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
    projector: "anthropic-to-mistral-conversations",
    warning: "pi-native-mapping-repaired",
  });
}

function expectedMistralReasoningEffort(
  model: Model<string>,
  level: AnthropicSelectedPiEffort,
): string | undefined {
  if (!model.reasoning) return undefined;
  const mapped = model.thinkingLevelMap?.[level];
  return typeof mapped === "string" ? mapped : undefined;
}

function clearMistralReasoning(payload: Record<string, unknown>): boolean {
  let changed = false;
  for (const field of ["promptMode", "reasoningEffort"] as const) {
    if (Object.hasOwn(payload, field)) {
      delete payload[field];
      changed = true;
    }
  }
  return changed;
}

function mappedToolChoice(
  invocation: AnthropicSemanticInvocation,
): unknown | undefined {
  const choice = invocation.supplement.toolChoice;
  if (choice === undefined) return undefined;
  if (choice.kind === "none") return "none";
  if (choice.kind === "auto") return "auto";
  if (choice.kind === "any") return "required";
  if (choice.kind === "named") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

type ProjectionInput = {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly effortPlan: AnthropicEffortPlan;
  readonly payload: unknown;
};

function projectAnthropicToMistral(
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
    throw new Error("mistral-conversations payload must be an object");
  }
  const payload = structuredClone(input.payload) as Record<string, unknown>;
  if (
    typeof payload.model !== "string" ||
    !Array.isArray(payload.messages) ||
    payload.stream !== true ||
    typeof payload.maxTokens !== "number"
  ) {
    throw new Error("mistral-conversations payload shape mismatch");
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  if (phase === "supplement") {
  const finalMaxTokens = Math.min(payload.maxTokens, supplement.outputTokenCeiling);
  exact(outcomes, "maxTokens", payload.maxTokens, finalMaxTokens, () => {
    payload.maxTokens = finalMaxTokens;
  });
  for (const [control, field, value] of [
    ["sampling.temperature", "temperature", supplement.sampling.temperature],
    ["sampling.topP", "topP", supplement.sampling.topP],
  ] as const) {
    if (value === undefined) continue;
    if (control === "sampling.temperature") {
      if (same(payload[field], value)) {
        add(outcomes, control, { kind: "pi-native" });
      }
      continue;
    }
    exact(outcomes, control, payload[field], value, () => {
      payload[field] = value;
    });
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

  const format = supplement.outputFormat;
  if (format.kind === "specified") {
    const expected = {
      type: "json_schema",
      jsonSchema: {
        name: "anthropic_output",
        strict: true,
        schemaDefinition: format.value.schema,
      },
    };
    exact(outcomes, "outputFormat", payload.responseFormat, expected, () => {
      payload.responseFormat = expected;
    });
  } else if (format.kind === "explicit-null") {
    delete payload.responseFormat;
    add(outcomes, "outputFormat", { kind: "pi-native" });
  }

  const choice = mappedToolChoice(input.invocation);
  if (choice !== undefined) {
    exact(outcomes, "toolChoice", payload.toolChoice, choice, () => {
      payload.toolChoice = choice;
    });
  }
  const sourceChoice = supplement.toolChoice;
  if (
    sourceChoice !== undefined &&
    sourceChoice.kind !== "none" &&
    sourceChoice.disableParallelToolUse
  ) {
    exact(
      outcomes,
      "toolChoice.disableParallelToolUse",
      payload.parallelToolCalls,
      false,
      () => {
        payload.parallelToolCalls = false;
      },
    );
  }
  } else {
  const activation = input.invocation.reasoning.activation;
  const effort = input.invocation.reasoning.effort;
  if (activation.kind === "disabled") {
    const repaired = clearMistralReasoning(payload);
    add(
      outcomes,
      "reasoning.activation",
      repaired
        ? {
            kind: "payload-projected",
            projector: "anthropic-to-mistral-conversations",
            warning: "pi-native-mapping-repaired",
          }
        : { kind: "pi-native" },
    );
    if (effort.kind === "specified") {
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "reasoning effort cannot be applied while reasoning is explicitly disabled",
      });
    }
  } else if (input.effortPlan.kind === "specified") {
    if (input.effortPlan.selection.kind !== "selected") {
      clearMistralReasoning(payload);
      add(outcomes, "reasoning.effort", {
        kind: "degraded",
        warning:
          input.effortPlan.selection.kind === "non-reasoning"
            ? "Mistral target does not support reasoning; ordinary generation was retained"
            : "Mistral target exposes no selectable reasoning level; Provider default was retained",
      });
    } else {
    const expectedEffort = expectedMistralReasoningEffort(
      input.model,
      input.effortPlan.selection.level,
    );
    if (expectedEffort === undefined) {
      clearMistralReasoning(payload);
      add(outcomes, "reasoning.effort", {
        kind: "degraded",
        warning: "mistral-conversations has no certified equivalent for the selected reasoning effort; Provider default was retained",
      });
    } else if (same(payload.reasoningEffort, expectedEffort)) {
      delete payload.promptMode;
      add(
        outcomes,
        "reasoning.effort",
        input.effortPlan.requested === input.effortPlan.selection.level
          ? { kind: "pi-native" }
          : {
              kind: "degraded",
              warning: `requested reasoning level ${input.effortPlan.requested} mapped to supported Pi level ${input.effortPlan.selection.level}`,
            },
      );
    } else {
      clearMistralReasoning(payload);
      add(outcomes, "reasoning.effort", {
        kind: "degraded",
        warning: "Pi did not emit the selected Mistral reasoning effort; Provider default was retained",
      });
    }
    }
  }
  }

  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}

export function projectAnthropicToMistralReasoning(input: ProjectionInput) {
  return projectAnthropicToMistral(input, "reasoning");
}

export function projectAnthropicToMistralSupplement(input: ProjectionInput) {
  return projectAnthropicToMistral(input, "supplement");
}
