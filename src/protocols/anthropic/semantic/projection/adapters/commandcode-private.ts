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
    projector: "anthropic-to-commandcode-private",
    warning: "pi-native-mapping-repaired",
  });
}

function omitted(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  warning: string,
): void {
  add(outcomes, control, { kind: "omitted", warning });
}

export function initialCommandCodePrivateFailure(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  const { reasoning, supplement } = input.invocation;
  if (supplement.inferenceGeo.kind === "specified") {
    return "CommandCode Private has no certified inference geography control";
  }
  if (supplement.stopSequences !== undefined) {
    return "CommandCode Private has no stop sequence wire control";
  }
  if (supplement.outputFormat.kind === "specified") {
    return "CommandCode Private has no structured output wire control";
  }
  const choice = supplement.toolChoice;
  if (
    choice !== undefined &&
    (choice.kind === "any" ||
      choice.kind === "named" ||
      (choice.kind === "auto" && choice.disableParallelToolUse))
  ) {
    return "CommandCode Private has no exact requested tool choice or serial-tool control";
  }
  if (reasoning.activation.kind === "enabled") {
    return "CommandCode Private has no exact Anthropic thinking budget control";
  }
  if (reasoning.activation.kind === "adaptive") {
    return "CommandCode Private has no Anthropic adaptive-thinking control";
  }
  if (reasoning.activation.kind === "disabled" && input.model.reasoning) {
    return "CommandCode Private has no explicit reasoning-disable wire control";
  }
  return undefined;
}

function expectedReasoningEffort(
  model: Model<string>,
  level: "low" | "medium" | "high" | "xhigh" | "max",
): string | undefined {
  const explicit = model.thinkingLevelMap?.[level];
  if (explicit === null) return undefined;
  if (typeof explicit === "string") return explicit;
  return level === "low" || level === "medium" || level === "high"
    ? level
    : undefined;
}

export function projectAnthropicToCommandCodePrivate(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly payload: unknown;
}): {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
  readonly failure?: string;
} {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw new Error("commandcode-private payload must be an object");
  }
  const payload = structuredClone(input.payload) as Record<string, unknown>;
  if (
    typeof payload.params !== "object" ||
    payload.params === null ||
    Array.isArray(payload.params)
  ) {
    throw new Error("commandcode-private payload shape mismatch at params");
  }
  const params = { ...(payload.params as Record<string, unknown>) };
  if (
    typeof params.model !== "string" ||
    !Array.isArray(params.messages) ||
    !Array.isArray(params.tools) ||
    params.stream !== true ||
    typeof params.max_tokens !== "number"
  ) {
    throw new Error("commandcode-private params shape mismatch");
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const { reasoning, supplement } = input.invocation;

  exact(outcomes, "maxTokens", params.max_tokens, supplement.maxTokens, () => {
    params.max_tokens = supplement.maxTokens;
  });
  if (supplement.sampling.temperature !== undefined) {
    exact(
      outcomes,
      "sampling.temperature",
      params.temperature,
      supplement.sampling.temperature,
      () => {
        params.temperature = supplement.sampling.temperature;
      },
    );
  }
  if (supplement.sampling.topP !== undefined) {
    omitted(outcomes, "sampling.topP", "CommandCode Private has no top-p wire control");
  }
  if (supplement.sampling.topK !== undefined) {
    omitted(outcomes, "sampling.topK", "CommandCode Private has no top-k wire control");
  }

  if (supplement.toolChoice?.kind === "none") {
    exact(outcomes, "toolChoice", params.tools, [], () => {
      params.tools = [];
    });
  } else if (supplement.toolChoice?.kind === "auto") {
    add(outcomes, "toolChoice", { kind: "pi-native" });
  }

  if (reasoning.effort.kind === "specified") {
    if (!input.model.reasoning) {
      omitted(
        outcomes,
        "reasoning.effort",
        "CommandCode Private target model does not support reasoning effort",
      );
    } else {
      const expected = expectedReasoningEffort(input.model, reasoning.effort.level);
      if (expected === undefined) {
        return Object.freeze({
          payload: Object.freeze(payload),
          outcomes: Object.freeze(outcomes),
          failure: `CommandCode Private has no certified ${reasoning.effort.level} effort mapping`,
        });
      }
      exact(outcomes, "reasoning.effort", params.reasoning_effort, expected, () => {
        params.reasoning_effort = expected;
      });
    }
  } else if (reasoning.effort.kind === "explicit-null" || reasoning.effort.kind === "omitted") {
    const repaired = Object.hasOwn(params, "reasoning_effort");
    delete params.reasoning_effort;
    add(outcomes, "reasoning.effort", repaired
      ? {
          kind: "payload-projected",
          projector: "anthropic-to-commandcode-private",
          warning: "pi-native-mapping-repaired",
        }
      : { kind: "pi-native" });
  }

  for (const [control, intent, warning] of [
    ["metadataUserId", supplement.metadataUserId, "CommandCode Private has no end-user identity field"],
    ["serviceTier", supplement.serviceTier, "CommandCode Private has no service-tier field"],
    ["container", supplement.container, "CommandCode Private cannot reuse an Anthropic container"],
    ["cacheControl", supplement.cacheControl, "CommandCode Private has no Anthropic cache breakpoint"],
  ] as const) {
    if (intent.kind === "specified") omitted(outcomes, control, warning);
  }

  payload.params = params;
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}
