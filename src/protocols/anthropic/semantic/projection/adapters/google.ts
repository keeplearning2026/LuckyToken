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

function containsExpectedFields(
  current: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    return false;
  }
  const record = current as Readonly<Record<string, unknown>>;
  return Object.entries(expected).every(([key, value]) => same(record[key], value));
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

function isGemini3Pro(model: Model<string>): boolean {
  return /gemini-3(?:\.\d+)?-pro/u.test(model.id.toLowerCase());
}

function isGemini3Flash(model: Model<string>): boolean {
  const id = model.id.toLowerCase();
  return /gemini-3(?:\.\d+)?-flash/u.test(id) ||
    id === "gemini-flash-latest" ||
    id === "gemini-flash-lite-latest";
}

function isGemma4(model: Model<string>): boolean {
  return /gemma-?4/u.test(model.id.toLowerCase());
}

function usesThinkingLevel(api: GoogleApi, model: Model<string>): boolean {
  return isGemini3Pro(model) ||
    isGemini3Flash(model) ||
    (api === "google-generative-ai" && isGemma4(model));
}

function googleThinkingLevel(
  api: GoogleApi,
  model: Model<string>,
  effort: "low" | "medium" | "high",
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
  if (isGemini3Pro(model)) {
    return effort === "low" ? "LOW" : "HIGH";
  }
  if (api === "google-generative-ai" && isGemma4(model)) {
    return effort === "low" ? "MINIMAL" : "HIGH";
  }
  return effort.toUpperCase() as "LOW" | "MEDIUM" | "HIGH";
}

function googleThinkingBudget(
  api: GoogleApi,
  model: Model<string>,
  effort: "low" | "medium" | "high",
): number | undefined {
  const id = model.id.toLowerCase();
  if (id.includes("2.5-pro")) {
    return { low: 2_048, medium: 8_192, high: 32_768 }[effort];
  }
  if (api === "google-generative-ai" && id.includes("2.5-flash-lite")) {
    return { low: 2_048, medium: 8_192, high: 24_576 }[effort];
  }
  if (id.includes("2.5-flash")) {
    return { low: 2_048, medium: 8_192, high: 24_576 }[effort];
  }
  return undefined;
}

function googleThinking(
  api: GoogleApi,
  model: Model<string>,
  invocation: AnthropicSemanticInvocation,
): Record<string, unknown> | undefined {
  const activation = invocation.reasoning.activation;
  const effort = invocation.reasoning.effort;
  if (activation.kind === "disabled") {
    return model.reasoning ? { thinkingBudget: 0 } : undefined;
  }
  if (activation.kind === "enabled") {
    return {
      includeThoughts: true,
      thinkingBudget: activation.budgetTokens,
    };
  }
  if (activation.kind === "adaptive") return undefined;
  if (effort.kind !== "specified" || !model.reasoning) return undefined;
  if (effort.level === "xhigh" || effort.level === "max") return undefined;
  if (usesThinkingLevel(api, model)) {
    return { thinkingLevel: googleThinkingLevel(api, model, effort.level) };
  }
  const budget = googleThinkingBudget(api, model, effort.level);
  return budget === undefined ? undefined : { thinkingBudget: budget };
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

type ProjectionInput = {
  readonly api: GoogleApi;
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly payload: unknown;
};

function projectAnthropicToGoogle(
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
    !Array.isArray(payload.contents) ||
    typeof payload.config !== "object" ||
    payload.config === null ||
    Array.isArray(payload.config)
  ) {
    throw new Error(`${input.api} payload shape mismatch`);
  }
  const config = { ...(payload.config as Record<string, unknown>) };
  if (typeof config.maxOutputTokens !== "number") {
    throw new Error(`${input.api} payload shape mismatch at maxOutputTokens`);
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  if (phase === "supplement") {
  const finalMaxTokens = Math.min(config.maxOutputTokens, supplement.outputTokenCeiling);
  exact(
    outcomes,
    input.api,
    "maxTokens",
    config.maxOutputTokens,
    finalMaxTokens,
    () => {
      config.maxOutputTokens = finalMaxTokens;
    },
  );
  for (const [control, field, value] of [
    ["sampling.temperature", "temperature", supplement.sampling.temperature],
    ["sampling.topP", "topP", supplement.sampling.topP],
    ["sampling.topK", "topK", supplement.sampling.topK],
  ] as const) {
    if (value === undefined) continue;
    if (control === "sampling.temperature") {
      if (same(config[field], value)) {
        add(outcomes, control, { kind: "pi-native" });
      }
      continue;
    }
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
  } else {
  const activation = input.invocation.reasoning.activation;
  const effort = input.invocation.reasoning.effort;
  if (activation.kind === "disabled") {
    if (!input.model.reasoning) {
      delete config.thinkingConfig;
      add(outcomes, "reasoning.activation", { kind: "pi-native" });
    } else if (usesThinkingLevel(input.api, input.model)) {
      delete config.thinkingConfig;
      add(outcomes, "reasoning.activation", {
        kind: "degraded",
        warning: `${input.api} model ${input.model.id} used its target reasoning default because it has no exact disable field`,
      });
    } else {
      const thinking = { thinkingBudget: 0 };
      exact(
        outcomes,
        input.api,
        "reasoning.activation",
        config.thinkingConfig,
        thinking,
        () => {
          config.thinkingConfig = thinking;
        },
      );
    }
    if (effort.kind === "specified") {
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "Google reasoning effort cannot be combined with an explicit Anthropic thinking activation",
      });
    }
  } else if (activation.kind === "enabled") {
    if (!input.model.reasoning) {
      delete config.thinkingConfig;
      add(outcomes, "reasoning.activation", {
        kind: "degraded",
        warning: `${input.api} model ${input.model.id} does not support reasoning; ordinary generation was used`,
      });
    } else if (usesThinkingLevel(input.api, input.model)) {
      add(outcomes, "reasoning.activation", {
        kind: "degraded",
        warning: `${input.api} model ${input.model.id} used Pi's nearest thinking level instead of the exact Anthropic budget`,
      });
    } else {
      const thinking = {
        includeThoughts: true,
        thinkingBudget: activation.budgetTokens,
      };
      exact(
        outcomes,
        input.api,
        "reasoning.activation",
        config.thinkingConfig,
        thinking,
        () => {
          config.thinkingConfig = thinking;
        },
      );
    }
    if (effort.kind === "specified") {
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "Google reasoning effort cannot be combined with an explicit Anthropic thinking activation",
      });
    }
  } else if (activation.kind === "adaptive") {
    if (!input.model.reasoning) delete config.thinkingConfig;
    add(outcomes, "reasoning.activation", {
      kind: "degraded",
      warning: input.model.reasoning
        ? `${input.api} used its nearest target reasoning mode for Anthropic adaptive thinking`
        : `${input.api} target does not support reasoning; ordinary generation was used`,
    });
  } else if (effort.kind === "specified") {
    const thinking = googleThinking(input.api, input.model, input.invocation);
    if (thinking === undefined) {
      delete config.thinkingConfig;
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: `${input.api} has no certified ${effort.level} effort mapping for model ${input.model.id}`,
      });
    } else if (containsExpectedFields(config.thinkingConfig, thinking)) {
      add(outcomes, "reasoning.effort", { kind: "pi-native" });
    } else {
      delete config.thinkingConfig;
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: `${input.api} Pi payload did not contain the certified reasoning effort`,
      });
    }
  } else if (config.thinkingConfig !== undefined) {
    delete config.thinkingConfig;
    add(outcomes, "reasoning.activation", {
      kind: "payload-projected",
      projector: `anthropic-to-${input.api}`,
      warning: "pi-native-mapping-repaired",
    });
  }
  }

  payload.config = config;
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}

export function projectAnthropicToGoogleReasoning(input: ProjectionInput) {
  return projectAnthropicToGoogle(input, "reasoning");
}

export function projectAnthropicToGoogleSupplement(input: ProjectionInput) {
  return projectAnthropicToGoogle(input, "supplement");
}
