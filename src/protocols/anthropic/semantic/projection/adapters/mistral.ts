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

export function initialAnthropicToMistralFailure(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  if (input.invocation.supplement.inferenceGeo.kind === "specified") {
    return "mistral-conversations has no certified inference geography control";
  }
  return undefined;
}

const MISTRAL_REASONING_EFFORT_MODELS = new Set([
  "mistral-small-2603",
  "mistral-small-latest",
  "mistral-medium-3.5",
]);

function expectedMistralReasoningEffort(
  model: Model<string>,
  level: "low" | "medium" | "high" | "xhigh" | "max",
): string | undefined {
  if (!model.reasoning || !MISTRAL_REASONING_EFFORT_MODELS.has(model.id)) {
    return undefined;
  }
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return undefined;
  if (typeof mapped === "string") return mapped;
  return level === "high" ? "high" : undefined;
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

export function projectAnthropicToMistral(input: {
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

  const finalMaxTokens = Math.min(payload.maxTokens, supplement.outputTokenCeiling);
  exact(outcomes, "maxTokens", payload.maxTokens, finalMaxTokens, () => {
    payload.maxTokens = finalMaxTokens;
  });
  for (const [control, field, value] of [
    ["sampling.topP", "topP", supplement.sampling.topP],
  ] as const) {
    if (value === undefined) continue;
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
  if (sourceChoice !== undefined && sourceChoice.kind !== "none") {
    const parallel = !sourceChoice.disableParallelToolUse;
    exact(
      outcomes,
      "toolChoice.disableParallelToolUse",
      payload.parallelToolCalls,
      parallel,
      () => {
        payload.parallelToolCalls = parallel;
      },
    );
  }

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
  } else if (effort.kind === "specified") {
    const expectedEffort = expectedMistralReasoningEffort(
      input.model,
      effort.level,
    );
    if (expectedEffort === undefined) {
      clearMistralReasoning(payload);
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "mistral-conversations has no certified equivalent for the requested reasoning effort",
      });
    } else {
      delete payload.promptMode;
      exact(
        outcomes,
        "reasoning.effort",
        payload.reasoningEffort,
        expectedEffort,
        () => {
          payload.reasoningEffort = expectedEffort;
        },
      );
    }
  }

  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}
