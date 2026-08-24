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

export function initialAnthropicToPiMessagesFailure(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  const supplement = input.invocation.supplement;
  if (supplement.inferenceGeo.kind === "specified") {
    return "pi-messages has no certified inference geography control";
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

export function projectAnthropicToPiMessages(input: {
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

  const finalMaxTokens = Math.min(options.maxTokens, supplement.outputTokenCeiling);
  exact(outcomes, "maxTokens", options.maxTokens, finalMaxTokens, () => {
    options.maxTokens = finalMaxTokens;
  });
  const choice = mappedToolChoice(input.invocation);
  if (choice !== undefined) {
    exact(outcomes, "toolChoice", options.toolChoice, choice, () => {
      options.toolChoice = choice;
    });
  }
  const effort = input.invocation.reasoning.effort;
  if (effort.kind === "specified") {
    if (!input.model.reasoning) {
      delete options.reasoning;
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: `pi-messages model ${input.model.id} does not support reasoning effort`,
      });
    } else {
      exact(outcomes, "reasoning.effort", options.reasoning, effort.level, () => {
        options.reasoning = effort.level;
      });
    }
  } else if (effort.kind === "explicit-null") {
    delete options.reasoning;
  }
  payload.options = options;
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}
