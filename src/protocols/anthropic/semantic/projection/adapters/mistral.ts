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

export function initialMistralFailure(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  if (input.invocation.supplement.inferenceGeo.kind === "specified") {
    return "mistral-conversations has no certified inference geography control";
  }
  const activation = input.invocation.reasoning.activation;
  if (activation.kind === "enabled") {
    return "mistral-conversations cannot preserve an exact Anthropic thinking budget";
  }
  if (activation.kind === "adaptive") {
    return "mistral-conversations has no certified Anthropic adaptive-thinking control";
  }
  return undefined;
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
    payload.stream !== true
  ) {
    throw new Error("mistral-conversations payload shape mismatch");
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  exact(outcomes, "maxTokens", payload.maxTokens, supplement.maxTokens, () => {
    payload.maxTokens = supplement.maxTokens;
  });
  for (const [control, field, value] of [
    ["sampling.temperature", "temperature", supplement.sampling.temperature],
    ["sampling.topP", "topP", supplement.sampling.topP],
  ] as const) {
    if (value === undefined) continue;
    exact(outcomes, control, payload[field], value, () => {
      payload[field] = value;
    });
  }
  if (supplement.sampling.topK !== undefined) {
    add(outcomes, "sampling.topK", {
      kind: "omitted",
      warning: "mistral-conversations has no certified top-k control",
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
      "parallelToolCalls",
      payload.parallelToolCalls,
      parallel,
      () => {
        payload.parallelToolCalls = parallel;
      },
    );
  }

  if (input.invocation.reasoning.activation.kind === "disabled") {
    delete payload.promptMode;
    delete payload.reasoningEffort;
    add(outcomes, "reasoning", { kind: "payload-projected", projector: "anthropic-to-mistral-conversations" });
  }

  for (const [control, intent] of [
    ["metadataUserId", supplement.metadataUserId],
    ["serviceTier", supplement.serviceTier],
    ["container", supplement.container],
    ["cacheControl", supplement.cacheControl],
  ] as const) {
    if (intent.kind === "specified") {
      add(outcomes, control, {
        kind: "omitted",
        warning: "mistral-conversations has no certified equivalent",
      });
    }
  }
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}
