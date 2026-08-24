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
    projector: "anthropic-to-pi-messages",
    warning: "pi-native-mapping-repaired",
  });
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
  readonly payload: unknown;
};

function projectAnthropicToPiMessages(
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
    throw new Error("pi-messages payload must be an object");
  }
  const payload = structuredClone(input.payload) as Record<string, unknown>;
  if (
    typeof payload.model !== "string" ||
    typeof payload.context !== "object" ||
    payload.context === null ||
    Array.isArray(payload.context) ||
    typeof payload.options !== "object" ||
    payload.options === null ||
    Array.isArray(payload.options)
  ) {
    throw new Error("pi-messages payload shape mismatch");
  }
  const options = { ...(payload.options as Record<string, unknown>) };
  if (typeof options.maxTokens !== "number") {
    throw new Error("pi-messages payload shape mismatch at options.maxTokens");
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  if (phase === "supplement") {
  const finalMaxTokens = Math.min(options.maxTokens, supplement.outputTokenCeiling);
  exact(outcomes, "maxTokens", options.maxTokens, finalMaxTokens, () => {
    options.maxTokens = finalMaxTokens;
  });
  if (supplement.sampling.temperature !== undefined) {
    if (same(options.temperature, supplement.sampling.temperature)) {
      add(outcomes, "sampling.temperature", { kind: "pi-native" });
    }
  }
  const samplingParams =
    typeof options.samplingParams === "object" &&
    options.samplingParams !== null &&
    !Array.isArray(options.samplingParams)
      ? { ...(options.samplingParams as Record<string, unknown>) }
      : {};
  for (const [control, field, value] of [
    ["sampling.topP", "top_p", supplement.sampling.topP],
    ["sampling.topK", "top_k", supplement.sampling.topK],
  ] as const) {
    if (value === undefined) continue;
    exact(outcomes, control, samplingParams[field], value, () => {
      samplingParams[field] = value;
    });
  }
  if (Object.keys(samplingParams).length > 0) {
    options.samplingParams = samplingParams;
  }
  const choice = mappedToolChoice(input.invocation);
  if (choice !== undefined) {
    exact(outcomes, "toolChoice", options.toolChoice, choice, () => {
      options.toolChoice = choice;
    });
  }
  } else {
  const effort = input.invocation.reasoning.effort;
  if (effort.kind === "specified") {
    if (!input.model.reasoning) {
      delete options.reasoning;
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: `pi-messages model ${input.model.id} does not support reasoning effort`,
      });
    } else if (same(options.reasoning, effort.level)) {
      add(outcomes, "reasoning.effort", { kind: "pi-native" });
    } else {
      delete options.reasoning;
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "Pi did not retain the certified Pi Messages reasoning effort",
      });
    }
  } else if (effort.kind === "explicit-null") {
    delete options.reasoning;
  }
  }
  payload.options = options;
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}

export function projectAnthropicToPiMessagesReasoning(input: ProjectionInput) {
  return projectAnthropicToPiMessages(input, "reasoning");
}

export function projectAnthropicToPiMessagesSupplement(input: ProjectionInput) {
  return projectAnthropicToPiMessages(input, "supplement");
}
