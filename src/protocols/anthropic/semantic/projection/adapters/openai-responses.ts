import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
} from "../contract.js";

export type AnthropicResponsesTargetApi =
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses";

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
  api: AnthropicResponsesTargetApi,
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
    projector: `anthropic-to-${api}`,
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
  if (choice.kind === "named") return { type: "function", name: choice.name };
  return undefined;
}

export function initialOpenAIResponsesFailure(input: {
  readonly api: AnthropicResponsesTargetApi;
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  if (input.invocation.supplement.inferenceGeo.kind === "specified") {
    return `${input.api} has no certified inference geography control`;
  }
  if (input.api === "openai-codex-responses") {
    return "openai-codex-responses has no certified max_output_tokens control for Anthropic max_tokens";
  }
  const activation = input.invocation.reasoning.activation;
  if (activation.kind === "enabled") {
    return `${input.api} cannot preserve an exact Anthropic thinking budget`;
  }
  if (activation.kind === "adaptive") {
    return `${input.api} has no certified Anthropic adaptive-thinking control`;
  }
  if (
    activation.kind === "disabled" &&
    input.model.reasoning &&
    input.model.thinkingLevelMap?.off === null
  ) {
    return `${input.api} model ${input.model.id} cannot disable reasoning`;
  }
  return undefined;
}

function projectReasoning(
  input: {
    readonly api: AnthropicResponsesTargetApi;
    readonly model: Model<string>;
    readonly invocation: AnthropicSemanticInvocation;
  },
  payload: Record<string, unknown>,
  outcomes: AnthropicProjectionOutcome[],
): void {
  const activation = input.invocation.reasoning.activation;
  const effort = input.invocation.reasoning.effort;
  let expected: Record<string, unknown> | undefined;
  if (activation.kind === "disabled") {
    expected = { effort: input.model.thinkingLevelMap?.off ?? "none" };
  } else if (activation.kind === "omitted" && effort.kind === "specified") {
    expected = {
      effort: input.model.thinkingLevelMap?.[effort.level] ?? effort.level,
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
      add(outcomes, "reasoning", {
        kind: "payload-projected",
        projector: `anthropic-to-${input.api}`,
        warning: "pi-native-mapping-repaired",
      });
    }
    return;
  }
  exact(outcomes, input.api, "reasoning", payload.reasoning, expected, () => {
    payload.reasoning = expected;
  });
  if (input.model.reasoning) {
    const include = Array.isArray(payload.include) ? [...payload.include] : [];
    if (!include.includes("reasoning.encrypted_content")) {
      include.push("reasoning.encrypted_content");
      payload.include = include;
    }
  }
}

export function projectAnthropicToOpenAIResponses(input: {
  readonly api: AnthropicResponsesTargetApi;
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

  if (input.api !== "openai-codex-responses") {
    exact(
      outcomes,
      input.api,
      "maxTokens",
      payload.max_output_tokens,
      supplement.maxTokens,
      () => {
        payload.max_output_tokens = supplement.maxTokens;
      },
    );
  }
  for (const [control, field, value] of [
    ["sampling.temperature", "temperature", supplement.sampling.temperature],
    ["sampling.topP", "top_p", supplement.sampling.topP],
  ] as const) {
    if (value === undefined) continue;
    exact(outcomes, input.api, control, payload[field], value, () => {
      payload[field] = value;
    });
  }
  if (supplement.sampling.topK !== undefined) {
    add(outcomes, "sampling.topK", {
      kind: "omitted",
      warning: `${input.api} has no certified top-k control`,
    });
  }
  if (supplement.stopSequences !== undefined) {
    add(outcomes, "stopSequences", {
      kind: "omitted",
      warning: `${input.api} has no stop-sequence field`,
    });
  }

  const format = supplement.outputFormat;
  if (format.kind === "specified") {
    const text =
      typeof payload.text === "object" && payload.text !== null && !Array.isArray(payload.text)
        ? { ...(payload.text as Record<string, unknown>) }
        : {};
    text.format = {
      type: "json_schema",
      name: "anthropic_output",
      strict: true,
      schema: format.value.schema,
    };
    payload.text = text;
    add(outcomes, "outputFormat", {
      kind: "payload-projected",
      projector: `anthropic-to-${input.api}`,
    });
  } else if (format.kind === "explicit-null") {
    if (typeof payload.text === "object" && payload.text !== null && !Array.isArray(payload.text)) {
      const text = { ...(payload.text as Record<string, unknown>) };
      delete text.format;
      payload.text = text;
    }
    add(outcomes, "outputFormat", { kind: "pi-native" });
  }

  const choice = mappedToolChoice(input.invocation);
  if (choice !== undefined) {
    exact(outcomes, input.api, "toolChoice", payload.tool_choice, choice, () => {
      payload.tool_choice = choice;
    });
  }
  const sourceChoice = supplement.toolChoice;
  if (sourceChoice !== undefined && sourceChoice.kind !== "none") {
    const parallel = !sourceChoice.disableParallelToolUse;
    if (input.api === "openai-codex-responses" && !parallel) {
      add(outcomes, "parallelToolCalls", {
        kind: "omitted",
        warning: "openai-codex-responses cannot guarantee serial tool calls",
      });
    } else {
      exact(
        outcomes,
        input.api,
        "parallelToolCalls",
        payload.parallel_tool_calls,
        parallel,
        () => {
          payload.parallel_tool_calls = parallel;
        },
      );
    }
  }

  if (supplement.metadataUserId.kind === "specified") {
    const userId = supplement.metadataUserId.value;
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
  } else if (supplement.metadataUserId.kind === "explicit-null") {
    delete payload.user;
  }
  if (supplement.serviceTier.kind === "specified") {
    const tier = supplement.serviceTier.value === "standard_only" ? "default" : "auto";
    exact(outcomes, input.api, "serviceTier", payload.service_tier, tier, () => {
      payload.service_tier = tier;
    });
  }
  for (const [control, intent] of [
    ["container", supplement.container],
    ["cacheControl", supplement.cacheControl],
  ] as const) {
    if (intent.kind === "specified") {
      add(outcomes, control, {
        kind: "omitted",
        warning: `${input.api} has no certified equivalent`,
      });
    }
  }

  projectReasoning(input, payload, outcomes);
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}
