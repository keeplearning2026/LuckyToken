import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
} from "../contract.js";

type GoogleApi = "google-generative-ai" | "google-vertex";

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
  api: GoogleApi,
  control: string,
  current: unknown,
  expected: unknown,
  assign: () => void,
): void {
  if (same(current, expected)) {
    add(outcomes, control, { kind: "pi-native" });
  } else {
    assign();
    add(outcomes, control, {
      kind: "payload-projected",
      projector: `anthropic-to-${api}`,
      warning: "pi-native-mapping-repaired",
    });
  }
}

function isGemini3(model: Model<string>): boolean {
  return /gemini-3(?:\.\d+)?-(?:pro|flash)/u.test(model.id.toLowerCase());
}

export function initialGoogleFailure(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  if (input.invocation.supplement.inferenceGeo.kind === "specified") {
    return `${input.model.api} has no certified inference geography control`;
  }
  const choice = input.invocation.supplement.toolChoice;
  if (
    choice !== undefined &&
    choice.kind !== "none" &&
    choice.disableParallelToolUse
  ) {
    return `${input.model.api} cannot guarantee serial tool calls`;
  }
  const activation = input.invocation.reasoning.activation;
  if (activation.kind === "adaptive") {
    return `${input.model.api} has no certified Anthropic adaptive-thinking control`;
  }
  if (activation.kind === "disabled" && isGemini3(input.model)) {
    return `${input.model.api} model ${input.model.id} cannot disable reasoning`;
  }
  return undefined;
}

function googleThinking(
  model: Model<string>,
  invocation: AnthropicSemanticInvocation,
): Record<string, unknown> | undefined {
  const activation = invocation.reasoning.activation;
  const effort = invocation.reasoning.effort;
  if (activation.kind === "disabled") return { thinkingBudget: 0 };
  if (activation.kind === "enabled") {
    const display = activation.display;
    return {
      includeThoughts:
        !(display.kind === "specified" && display.value === "omitted"),
      thinkingBudget: activation.budgetTokens,
    };
  }
  if (activation.kind === "adaptive") return undefined;
  if (effort.kind !== "specified") return undefined;
  const level =
    effort.level === "xhigh" || effort.level === "max"
      ? "HIGH"
      : effort.level.toUpperCase();
  return {
    thinkingLevel: level,
  };
}

function mappedToolChoice(
  invocation: AnthropicSemanticInvocation,
): Record<string, unknown> | undefined {
  const choice = invocation.supplement.toolChoice;
  if (choice === undefined) return undefined;
  if (choice.kind === "none") return { mode: "NONE" };
  if (choice.kind === "auto") return { mode: "AUTO" };
  if (choice.kind === "any") return { mode: "ANY" };
  if (choice.kind === "named") {
    return { mode: "ANY", allowedFunctionNames: [choice.name] };
  }
  return undefined;
}

export function projectAnthropicToGoogle(input: {
  readonly api: GoogleApi;
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
    throw new Error(`${input.api} payload must be an object`);
  }
  const payload = structuredClone(input.payload) as Record<string, unknown>;
  if (
    typeof payload.model !== "string" ||
    !Array.isArray(payload.contents) ||
    typeof payload.config !== "object" ||
    payload.config === null ||
    Array.isArray(payload.config)
  ) {
    throw new Error(`${input.api} payload shape mismatch`);
  }
  const config = { ...(payload.config as Record<string, unknown>) };
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  exact(
    outcomes,
    input.api,
    "maxTokens",
    config.maxOutputTokens,
    supplement.maxTokens,
    () => {
      config.maxOutputTokens = supplement.maxTokens;
    },
  );
  for (const [control, field, value] of [
    ["sampling.temperature", "temperature", supplement.sampling.temperature],
    ["sampling.topP", "topP", supplement.sampling.topP],
    ["sampling.topK", "topK", supplement.sampling.topK],
  ] as const) {
    if (value === undefined) continue;
    exact(outcomes, input.api, control, config[field], value, () => {
      config[field] = value;
    });
  }
  if (supplement.stopSequences !== undefined) {
    exact(
      outcomes,
      input.api,
      "stopSequences",
      config.stopSequences,
      supplement.stopSequences,
      () => {
        config.stopSequences = [...supplement.stopSequences!];
      },
    );
  }

  const choice = mappedToolChoice(input.invocation);
  if (choice !== undefined) {
    const toolConfig = { functionCallingConfig: choice };
    exact(
      outcomes,
      input.api,
      "toolChoice",
      config.toolConfig,
      toolConfig,
      () => {
        config.toolConfig = toolConfig;
      },
    );
  }

  const format = supplement.outputFormat;
  if (format.kind === "specified") {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = format.value.schema;
    add(outcomes, "outputFormat", {
      kind: "payload-projected",
      projector: `anthropic-to-${input.api}`,
    });
  } else if (format.kind === "explicit-null") {
    delete config.responseMimeType;
    delete config.responseJsonSchema;
    add(outcomes, "outputFormat", { kind: "pi-native" });
  }

  const thinking = googleThinking(input.model, input.invocation);
  if (thinking === undefined) {
    delete config.thinkingConfig;
  } else {
    exact(
      outcomes,
      input.api,
      "reasoning",
      config.thinkingConfig,
      thinking,
      () => {
        config.thinkingConfig = thinking;
      },
    );
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
        warning: `${input.api} has no certified equivalent`,
      });
    }
  }

  payload.config = config;
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}
