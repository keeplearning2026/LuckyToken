import type {
  Model,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";

import type {
  ResponsesProjectionOutcome,
  ResponsesReasoningOutcome,
  ResponsesReasoningProjectionResult,
} from "../contract.js";
import type { ResponsesReasoningAdapter } from "./contract.js";

type ProjectInput = Parameters<ResponsesReasoningAdapter["projectPayload"]>[0];

export class InvalidResponsesReasoningProjection extends Error {
  readonly kind = "InvalidResponsesReasoningProjection";

  constructor(message: string) {
    super(message);
    this.name = "InvalidResponsesReasoningProjection";
  }
}

function record(value: unknown, api: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidResponsesReasoningProjection(`${api} payload must be an object`);
  }
  return structuredClone(value) as Record<string, unknown>;
}

function requireShape(
  payload: Record<string, unknown>,
  api: string,
  fields: readonly [string, "string" | "array" | "object" | "true"][],
): void {
  for (const [field, kind] of fields) {
    const value = payload[field];
    const valid =
      kind === "array"
        ? Array.isArray(value)
        : kind === "object"
          ? typeof value === "object" && value !== null && !Array.isArray(value)
          : kind === "true"
            ? value === true
            : typeof value === kind;
    if (!valid) {
      throw new InvalidResponsesReasoningProjection(
        `${api} payload shape mismatch at ${field}`,
      );
    }
  }
}

function outcome(
  subject: "effort" | "summary",
  value: ResponsesProjectionOutcome,
): ResponsesReasoningOutcome {
  return Object.freeze({ subject, outcome: Object.freeze(value) });
}

function repairedEffort(input: ProjectInput): ResponsesReasoningOutcome {
  return outcome("effort", {
    kind: "payload-projected",
    projector: input.model.api,
    warning: "pi-native-mapping-repaired",
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function finish(
  payload: Record<string, unknown>,
  input: ProjectInput,
  controls: readonly ResponsesReasoningOutcome[],
): ResponsesReasoningProjectionResult {
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze([...input.prepared.outcomes, ...controls]),
  });
}

function unsupportedSummary(input: ProjectInput): ResponsesReasoningOutcome | undefined {
  return input.prepared.request.summary.kind === "requested"
    ? outcome("summary", {
        kind: "omitted",
        warning: `${input.model.api} has no certified reasoning summary preference mapping`,
      })
    : undefined;
}

function selectedEnabledLevel(input: ProjectInput) {
  const plan = input.prepared.effortPlan;
  if (plan.kind !== "enabled" || plan.selection.kind !== "selected") {
    throw new InvalidResponsesReasoningProjection(
      "selected reasoning level required by target projection",
    );
  }
  return plan.selection.level;
}

function finalizedEffort(
  input: ProjectInput,
  repaired: boolean,
): ResponsesReasoningOutcome {
  const plan = input.prepared.effortPlan;
  if (
    plan.kind === "enabled" &&
    plan.selection.kind === "selected" &&
    plan.requested !== plan.selection.level
  ) {
    return outcome("effort", {
      kind: "degraded",
      projector: input.model.api,
      fallback: "reasoning-effort-nearest-level",
      warning: `requested reasoning level ${plan.requested} mapped to supported level ${plan.selection.level}`,
    });
  }
  return repaired
    ? repairedEffort(input)
    : outcome("effort", { kind: "pi-native" });
}

function unavailableEnabledSelection(
  input: ProjectInput,
): "no-selectable-level" | "non-reasoning" | undefined {
  const plan = input.prepared.effortPlan;
  return plan.kind === "enabled" && plan.selection.kind !== "selected"
    ? plan.selection.kind
    : undefined;
}

function unavailableEffortOutcome(
  input: ProjectInput,
  selection: "no-selectable-level" | "non-reasoning",
): ResponsesReasoningOutcome {
  return selection === "non-reasoning"
    ? outcome("effort", {
        kind: "degraded",
        projector: input.model.api,
        fallback: "reasoning-to-ordinary-generation",
        warning:
          "target model does not support reasoning; ordinary generation retained",
      })
    : outcome("effort", {
        kind: "degraded",
        projector: input.model.api,
        fallback: "reasoning-to-provider-default",
        warning:
          "target model exposes no selectable reasoning level; provider default retained",
      });
}

function unavailableDisabledOutcome(input: ProjectInput): ResponsesReasoningOutcome {
  return outcome("effort", {
    kind: "degraded",
    projector: input.model.api,
    fallback: "reasoning-disable-to-provider-default",
    warning:
      "target cannot express explicit reasoning disable; provider default retained",
  });
}

function uncertifiedEnabledOutcome(
  input: ProjectInput,
  fallback: "reasoning-to-binary-enable" | "reasoning-to-provider-default",
): ResponsesReasoningOutcome {
  return outcome("effort", {
    kind: "degraded",
    projector: input.model.api,
    fallback,
    warning:
      fallback === "reasoning-to-binary-enable"
        ? "target accepts reasoning enablement but has no certified graded effort representation"
        : "target has no certified graded effort representation; Provider default retained",
  });
}

function mappedEffort(input: ProjectInput): string | null | undefined {
  const effort = input.prepared.request.effort;
  if (effort.kind === "provider-default") return undefined;
  if (effort.kind === "disabled") {
    return input.model.thinkingLevelMap?.off ?? "none";
  }
  const level = selectedEnabledLevel(input);
  return input.model.thinkingLevelMap?.[level] ?? level;
}

export function projectOpenAIResponsesPayload(
  input: ProjectInput,
): ResponsesReasoningProjectionResult {
  const payload = record(input.payload, input.model.api);
  requireShape(payload, input.model.api, [
    ["model", "string"],
    ["input", "array"],
    ["stream", "true"],
  ]);
  const controls: ResponsesReasoningOutcome[] = [];
  const effort = input.prepared.request.effort;
  const summary = input.prepared.request.summary;
  let reasoning =
    typeof payload.reasoning === "object" &&
    payload.reasoning !== null &&
    !Array.isArray(payload.reasoning)
      ? { ...(payload.reasoning as Record<string, unknown>) }
      : undefined;
  const unavailable = unavailableEnabledSelection(input);
  if (unavailable !== undefined) {
    if (reasoning !== undefined) delete reasoning.effort;
    controls.push(unavailableEffortOutcome(input, unavailable));
  } else if (effort.kind === "provider-default") {
    const repaired =
      reasoning !== undefined && Object.hasOwn(reasoning, "effort");
    if (reasoning !== undefined) delete reasoning.effort;
    controls.push(
      repaired
        ? repairedEffort(input)
        : outcome("effort", { kind: "pi-native" }),
    );
  } else if (effort.kind === "disabled") {
    if (!input.model.reasoning) {
      const repaired =
        reasoning !== undefined && Object.hasOwn(reasoning, "effort");
      if (reasoning !== undefined) delete reasoning.effort;
      controls.push(
        repaired
          ? repairedEffort(input)
          : outcome("effort", { kind: "pi-native" }),
      );
    } else if (input.model.thinkingLevelMap?.off === null) {
      if (reasoning !== undefined) delete reasoning.effort;
      controls.push(unavailableDisabledOutcome(input));
    } else {
      const mapped = mappedEffort(input);
      if (reasoning?.effort === mapped) {
        controls.push(outcome("effort", { kind: "pi-native" }));
      } else {
        reasoning = { ...(reasoning ?? {}), effort: mapped };
        controls.push(repairedEffort(input));
      }
    }
  } else {
    const mapped = mappedEffort(input);
    if (mapped === null) {
      throw new InvalidResponsesReasoningProjection(
        `${input.model.api} target cannot express the requested reasoning effort`,
      );
    }
    const repaired = reasoning?.effort !== mapped;
    if (repaired) {
      reasoning = { ...(reasoning ?? {}), effort: mapped };
    }
    controls.push(finalizedEffort(input, repaired));
  }
  if (summary.kind === "requested" && unavailable !== "non-reasoning") {
    reasoning = { ...(reasoning ?? {}), summary: summary.value };
    controls.push(
      outcome("summary", {
        kind: "payload-projected",
        projector: input.model.api,
      }),
    );
  } else if (reasoning !== undefined) {
    delete reasoning.summary;
    if (summary.kind === "requested") {
      controls.push(
        outcome("summary", {
          kind: "omitted",
          warning: "target model does not support reasoning summaries",
        }),
      );
    }
  }
  if (reasoning === undefined || Object.keys(reasoning).length === 0) {
    delete payload.reasoning;
  } else {
    payload.reasoning = reasoning;
  }
  return finish(payload, input, controls);
}

export function projectAnthropicPayload(
  input: ProjectInput,
): ResponsesReasoningProjectionResult {
  const payload = record(input.payload, input.model.api);
  requireShape(payload, input.model.api, [
    ["model", "string"],
    ["messages", "array"],
    ["stream", "true"],
  ]);
  const controls: ResponsesReasoningOutcome[] = [];
  const effort = input.prepared.request.effort;
  const unavailable = unavailableEnabledSelection(input);
  if (unavailable !== undefined) {
    delete payload.thinking;
    const outputConfig = payload.output_config;
    if (
      typeof outputConfig === "object" &&
      outputConfig !== null &&
      !Array.isArray(outputConfig)
    ) {
      const copy = { ...(outputConfig as Record<string, unknown>) };
      delete copy.effort;
      if (Object.keys(copy).length === 0) delete payload.output_config;
      else payload.output_config = copy;
    }
    controls.push(unavailableEffortOutcome(input, unavailable));
  } else if (effort.kind === "provider-default") {
    const repaired = Object.hasOwn(payload, "thinking");
    delete payload.thinking;
    controls.push(finalizedEffort(input, repaired));
  } else if (effort.kind === "disabled") {
    if (!input.model.reasoning) {
      let repaired = Object.hasOwn(payload, "thinking");
      delete payload.thinking;
      const outputConfig = payload.output_config;
      if (
        typeof outputConfig === "object" &&
        outputConfig !== null &&
        !Array.isArray(outputConfig)
      ) {
        const copy = { ...(outputConfig as Record<string, unknown>) };
        repaired ||= Object.hasOwn(copy, "effort");
        delete copy.effort;
        if (Object.keys(copy).length === 0) delete payload.output_config;
        else payload.output_config = copy;
      }
      controls.push(finalizedEffort(input, repaired));
    } else if (input.model.thinkingLevelMap?.off === null) {
      delete payload.thinking;
      controls.push(unavailableDisabledOutcome(input));
    } else {
      const expected = { type: "disabled" };
      if (sameJson(payload.thinking, expected)) {
        controls.push(outcome("effort", { kind: "pi-native" }));
      } else {
        payload.thinking = expected;
        controls.push(repairedEffort(input));
      }
    }
  } else {
    const level = selectedEnabledLevel(input);
    let repaired = false;
    if (
      (input.model as Model<"anthropic-messages">).compat
        ?.forceAdaptiveThinking === true
    ) {
      const expectedThinking = { type: "adaptive", display: "summarized" };
      if (!sameJson(payload.thinking, expectedThinking)) {
        payload.thinking = expectedThinking;
        repaired = true;
      }
      const mapped = input.model.thinkingLevelMap?.[level];
      const expectedEffort =
        typeof mapped === "string"
          ? mapped
          : level === "minimal" || level === "low"
            ? "low"
            : level === "medium"
              ? "medium"
              : "high";
      const outputConfig =
        typeof payload.output_config === "object" &&
        payload.output_config !== null &&
        !Array.isArray(payload.output_config)
          ? { ...(payload.output_config as Record<string, unknown>) }
          : {};
      if (outputConfig.effort !== expectedEffort) {
        outputConfig.effort = expectedEffort;
        payload.output_config = outputConfig;
        repaired = true;
      }
    } else {
      const maxTokens = payload.max_tokens;
      if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) {
        throw new InvalidResponsesReasoningProjection(
          "Anthropic reasoning payload has no certified max_tokens value",
        );
      }
      const budgetLevel =
        level === "xhigh" || level === "max" ? "high" : level;
      const defaults = {
        minimal: 1_024,
        low: 2_048,
        medium: 8_192,
        high: 16_384,
      } as const;
      const requestedBudget =
        input.prepared.options.thinkingBudgets?.[budgetLevel] ??
        defaults[budgetLevel];
      const boundedBudget = Math.min(
        requestedBudget,
        Math.max(0, maxTokens - 1_024),
      );
      const expectedThinking = {
        type: "enabled",
        budget_tokens: boundedBudget || 1_024,
        display: "summarized",
      };
      if (!sameJson(payload.thinking, expectedThinking)) {
        payload.thinking = expectedThinking;
        repaired = true;
      }
    }
    controls.push(
      repaired
        ? repairedEffort(input)
        : outcome("effort", { kind: "pi-native" }),
    );
  }
  const summaryOutcome = unsupportedSummary(input);
  if (summaryOutcome !== undefined) controls.push(summaryOutcome);
  return finish(payload, input, controls);
}

export function projectGooglePayload(
  input: ProjectInput,
): ResponsesReasoningProjectionResult {
  const payload = record(input.payload, input.model.api);
  requireShape(payload, input.model.api, [
    ["model", "string"],
    ["contents", "array"],
    ["config", "object"],
  ]);
  const config = { ...(payload.config as Record<string, unknown>) };
  const effort = input.prepared.request.effort;
  const controls: ResponsesReasoningOutcome[] = [];
  const unavailable = unavailableEnabledSelection(input);
  if (unavailable !== undefined) {
    delete config.thinkingConfig;
    controls.push(unavailableEffortOutcome(input, unavailable));
  } else if (effort.kind === "provider-default") {
    const repaired = Object.hasOwn(config, "thinkingConfig");
    delete config.thinkingConfig;
    controls.push(
      repaired
        ? repairedEffort(input)
        : outcome("effort", { kind: "pi-native" }),
    );
  } else if (effort.kind === "disabled") {
    const id = input.model.id.toLowerCase();
    const cannotDisable =
      /gemini-3(?:\.\d+)?-(?:pro|flash)/u.test(id) ||
      id === "gemini-flash-latest" ||
      id === "gemini-flash-lite-latest" ||
      (input.model.api === "google-generative-ai" && id.includes("gemma-4"));
    if (!input.model.reasoning) {
      const repaired = Object.hasOwn(config, "thinkingConfig");
      delete config.thinkingConfig;
      controls.push(finalizedEffort(input, repaired));
    } else if (cannotDisable) {
      delete config.thinkingConfig;
      controls.push(unavailableDisabledOutcome(input));
    } else {
      const current = config.thinkingConfig;
      if (
        typeof current === "object" &&
        current !== null &&
        !Array.isArray(current) &&
        (current as Record<string, unknown>).thinkingBudget === 0 &&
        Object.keys(current).length === 1
      ) {
        controls.push(outcome("effort", { kind: "pi-native" }));
      } else {
        config.thinkingConfig = { thinkingBudget: 0 };
        controls.push(repairedEffort(input));
      }
    }
  } else {
    const level = selectedEnabledLevel(input);
    const id = input.model.id.toLowerCase();
    let expected: Record<string, unknown>;
    const isGemini3Pro = /gemini-3(?:\.\d+)?-pro/u.test(id);
    const isGemini3Flash =
      /gemini-3(?:\.\d+)?-flash/u.test(id) ||
      id === "gemini-flash-latest" ||
      id === "gemini-flash-lite-latest";
    const isGemma4 =
      input.model.api === "google-generative-ai" && id.includes("gemma-4");
    if (isGemini3Pro || isGemini3Flash || isGemma4) {
      const thinkingLevel = isGemini3Pro
        ? level === "minimal" || level === "low"
          ? "LOW"
          : "HIGH"
        : level.toUpperCase();
      expected = { includeThoughts: true, thinkingLevel };
    } else {
      const budgetLevel =
        level === "xhigh" || level === "max" ? "high" : level;
      const custom = input.prepared.options.thinkingBudgets?.[budgetLevel];
      let thinkingBudget = custom;
      if (thinkingBudget === undefined) {
        const budgets = id.includes("2.5-pro")
          ? { minimal: 128, low: 2_048, medium: 8_192, high: 32_768 }
          : id.includes("2.5-flash-lite") &&
              input.model.api === "google-generative-ai"
            ? { minimal: 512, low: 2_048, medium: 8_192, high: 24_576 }
            : id.includes("2.5-flash")
              ? { minimal: 128, low: 2_048, medium: 8_192, high: 24_576 }
              : { minimal: -1, low: -1, medium: -1, high: -1 };
        thinkingBudget = budgets[budgetLevel];
      }
      expected = { includeThoughts: true, thinkingBudget };
    }
    const repaired = !sameJson(config.thinkingConfig, expected);
    if (repaired) {
      config.thinkingConfig = expected;
    }
    controls.push(finalizedEffort(input, repaired));
  }
  payload.config = config;
  const summaryOutcome = unsupportedSummary(input);
  if (summaryOutcome !== undefined) controls.push(summaryOutcome);
  return finish(payload, input, controls);
}

export function projectMistralPayload(
  input: ProjectInput,
): ResponsesReasoningProjectionResult {
  const payload = record(input.payload, input.model.api);
  requireShape(payload, input.model.api, [
    ["model", "string"],
    ["messages", "array"],
    ["stream", "true"],
  ]);
  const effort = input.prepared.request.effort;
  const controls: ResponsesReasoningOutcome[] = [];
  const unavailable = unavailableEnabledSelection(input);
  if (unavailable !== undefined) {
    delete payload.promptMode;
    delete payload.reasoningEffort;
    controls.push(unavailableEffortOutcome(input, unavailable));
  } else if (effort.kind !== "enabled") {
    const hadNativeReasoning =
      payload.promptMode !== undefined || payload.reasoningEffort !== undefined;
    delete payload.promptMode;
    delete payload.reasoningEffort;
    controls.push(
      hadNativeReasoning
        ? repairedEffort(input)
        : outcome("effort", { kind: "pi-native" }),
    );
  } else {
    const level = selectedEnabledLevel(input);
    const usesEffort =
      input.model.id === "mistral-small-2603" ||
      input.model.id === "mistral-small-latest" ||
      input.model.id === "mistral-medium-3.5";
    const expectedEffort =
      input.model.thinkingLevelMap?.[level] ?? "high";
    const correct = usesEffort
      ? payload.reasoningEffort === expectedEffort &&
        payload.promptMode === undefined
      : payload.promptMode === "reasoning" &&
        payload.reasoningEffort === undefined;
    if (!correct) {
      if (usesEffort) {
        payload.reasoningEffort = expectedEffort;
        delete payload.promptMode;
      } else {
        payload.promptMode = "reasoning";
        delete payload.reasoningEffort;
      }
    }
    controls.push(finalizedEffort(input, !correct));
  }
  const summaryOutcome = unsupportedSummary(input);
  if (summaryOutcome !== undefined) controls.push(summaryOutcome);
  return finish(payload, input, controls);
}

function isBedrockClaude(model: Model<string>): boolean {
  return [model.id, model.name].some((value) =>
    value.toLowerCase().includes("claude"),
  );
}

export function projectBedrockPayload(
  input: ProjectInput,
): ResponsesReasoningProjectionResult {
  const payload = record(input.payload, input.model.api);
  requireShape(payload, input.model.api, [
    ["modelId", "string"],
    ["messages", "array"],
    ["inferenceConfig", "object"],
  ]);
  const effort = input.prepared.request.effort;
  const controls: ResponsesReasoningOutcome[] = [];
  const unavailable = unavailableEnabledSelection(input);
  if (unavailable !== undefined) {
    delete payload.additionalModelRequestFields;
    controls.push(unavailableEffortOutcome(input, unavailable));
  } else if (effort.kind === "provider-default") {
    const hadNativeReasoning =
      payload.additionalModelRequestFields !== undefined;
    delete payload.additionalModelRequestFields;
    controls.push(
      hadNativeReasoning
        ? repairedEffort(input)
        : outcome("effort", { kind: "pi-native" }),
    );
  } else if (effort.kind === "disabled") {
    const hadNativeReasoning =
      payload.additionalModelRequestFields !== undefined;
    delete payload.additionalModelRequestFields;
    controls.push(
      hadNativeReasoning
        ? repairedEffort(input)
        : outcome("effort", { kind: "pi-native" }),
    );
  } else {
    if (!isBedrockClaude(input.model)) {
      delete payload.additionalModelRequestFields;
      controls.push(
        uncertifiedEnabledOutcome(input, "reasoning-to-provider-default"),
      );
      const summaryOutcome = unsupportedSummary(input);
      if (summaryOutcome !== undefined) controls.push(summaryOutcome);
      return finish(payload, input, controls);
    }
    const additional = payload.additionalModelRequestFields;
    if (
      typeof additional !== "object" ||
      additional === null ||
      Array.isArray(additional)
    ) {
      throw new InvalidResponsesReasoningProjection(
        "Pi did not emit Bedrock reasoning generation fields",
      );
    }
    const thinking = (additional as Record<string, unknown>).thinking;
    if (
      typeof thinking !== "object" ||
      thinking === null ||
      Array.isArray(thinking) ||
      ((thinking as Record<string, unknown>).type !== "adaptive" &&
        (thinking as Record<string, unknown>).type !== "enabled")
    ) {
      throw new InvalidResponsesReasoningProjection(
        "Pi emitted an uncertified Bedrock reasoning shape",
      );
    }
    controls.push(finalizedEffort(input, false));
  }
  const summaryOutcome = unsupportedSummary(input);
  if (summaryOutcome !== undefined) controls.push(summaryOutcome);
  return finish(payload, input, controls);
}

function deleteKnownOpenAICompletionsOffFields(
  payload: Record<string, unknown>,
  input: ProjectInput,
): boolean {
  const compat = (input.model as Model<"openai-completions">).compat as
    | OpenAICompletionsCompat
    | undefined;
  let repaired =
    Object.hasOwn(payload, "reasoning_effort") ||
    Object.hasOwn(payload, "thinking_token_budget");
  delete payload.reasoning_effort;
  delete payload.thinking_token_budget;
  const remove = (field: string): void => {
    repaired ||= Object.hasOwn(payload, field);
    delete payload[field];
  };
  switch (compat?.thinkingFormat) {
    case "zai":
    case "deepseek":
    case "string-thinking":
      remove("thinking");
      break;
    case "qwen":
      remove("enable_thinking");
      break;
    case "openrouter":
    case "ant-ling":
    case "together":
      remove("reasoning");
      break;
    case "qwen-chat-template":
    case "chat-template":
      remove("chat_template_kwargs");
      break;
    case "baseten":
      remove("chat_template_args");
      break;
  }
  return repaired;
}

function detectedOpenAICompletionsThinkingFormat(
  input: ProjectInput,
): NonNullable<OpenAICompletionsCompat["thinkingFormat"]> {
  const explicit = (input.model as Model<"openai-completions">).compat
    ?.thinkingFormat;
  if (explicit !== undefined) return explicit;
  const provider = input.model.provider;
  const baseUrl = input.model.baseUrl.toLowerCase();
  if (
    provider === "deepseek" ||
    baseUrl.includes("deepseek.com")
  ) return "deepseek";
  if (
    provider === "zai" ||
    provider === "zai-coding-cn" ||
    baseUrl.includes("api.z.ai") ||
    baseUrl.includes("open.bigmodel.cn")
  ) return "zai";
  if (provider === "together" || baseUrl.includes("api.together.")) {
    return "together";
  }
  if (provider === "ant-ling" || baseUrl.includes("api.ant-ling.com")) {
    return "ant-ling";
  }
  if (provider === "openrouter" || baseUrl.includes("openrouter.ai")) {
    return "openrouter";
  }
  return "openai";
}

function detectedOpenAICompletionsReasoningEffortSupport(
  input: ProjectInput,
): boolean {
  const explicit = (input.model as Model<"openai-completions">).compat
    ?.supportsReasoningEffort;
  if (explicit !== undefined) return explicit;
  const provider = input.model.provider;
  const baseUrl = input.model.baseUrl.toLowerCase();
  return !(
    provider === "xai" ||
    baseUrl.includes("api.x.ai") ||
    provider === "zai" ||
    provider === "zai-coding-cn" ||
    baseUrl.includes("api.z.ai") ||
    baseUrl.includes("open.bigmodel.cn") ||
    provider === "moonshotai" ||
    provider === "moonshotai-cn" ||
    baseUrl.includes("api.moonshot.") ||
    provider === "together" ||
    baseUrl.includes("api.together.") ||
    provider === "cloudflare-ai-gateway" ||
    baseUrl.includes("gateway.ai.cloudflare.com") ||
    provider === "nvidia" ||
    baseUrl.includes("integrate.api.nvidia.com") ||
    provider === "ant-ling" ||
    baseUrl.includes("api.ant-ling.com")
  );
}

interface OpenAICompletionsEffortVerification {
  readonly changed: boolean;
  readonly representation: "exact" | "binary" | "provider-default";
}

function verifyOpenAICompletionsEffort(
  payload: Record<string, unknown>,
  input: ProjectInput,
): OpenAICompletionsEffortVerification {
  const effort = input.prepared.request.effort;
  if (effort.kind === "provider-default") {
    return { changed: false, representation: "exact" };
  }
  const providerDefault = (): OpenAICompletionsEffortVerification => ({
    changed: deleteKnownOpenAICompletionsOffFields(payload, input),
    representation: "provider-default",
  });
  if (!input.model.reasoning) {
    return providerDefault();
  }
  const format = detectedOpenAICompletionsThinkingFormat(input);
  const enabled = effort.kind === "enabled";
  const enabledLevel = enabled ? selectedEnabledLevel(input) : undefined;
  const mapped =
    effort.kind === "disabled"
      ? input.model.thinkingLevelMap?.off
      : input.model.thinkingLevelMap?.[enabledLevel!] ?? enabledLevel;
  let changed = false;
  const assign = (field: string, value: unknown): void => {
    if (JSON.stringify(payload[field]) !== JSON.stringify(value)) {
      payload[field] = value;
      changed = true;
    }
  };
  const remove = (field: string): void => {
    if (payload[field] !== undefined) {
      delete payload[field];
      changed = true;
    }
  };

  if (format === "deepseek") {
    if (!enabled && mapped === null) {
      return providerDefault();
    }
    assign("thinking", { type: enabled ? "enabled" : "disabled" });
    if (enabled && detectedOpenAICompletionsReasoningEffortSupport(input)) {
      if (typeof mapped !== "string") {
        return providerDefault();
      }
      assign("reasoning_effort", mapped);
    } else {
      remove("reasoning_effort");
    }
    return {
      changed,
      representation:
        enabled && !detectedOpenAICompletionsReasoningEffortSupport(input)
          ? "binary"
          : "exact",
    };
  }

  if (format === "zai") {
    assign(
      "thinking",
      enabled
        ? { type: "enabled", clear_thinking: false }
        : { type: "disabled" },
    );
    if (enabled && detectedOpenAICompletionsReasoningEffortSupport(input)) {
      if (typeof mapped !== "string") {
        return providerDefault();
      }
      assign("reasoning_effort", mapped);
    } else {
      remove("reasoning_effort");
    }
    return {
      changed,
      representation:
        enabled && !detectedOpenAICompletionsReasoningEffortSupport(input)
          ? "binary"
          : "exact",
    };
  }

  if (format === "qwen") {
    assign("enable_thinking", enabled);
    if (enabled && detectedOpenAICompletionsReasoningEffortSupport(input)) {
      if (typeof mapped !== "string") {
        return providerDefault();
      }
      assign("reasoning_effort", mapped);
    } else {
      remove("reasoning_effort");
    }
    return {
      changed,
      representation:
        enabled && !detectedOpenAICompletionsReasoningEffortSupport(input)
          ? "binary"
          : "exact",
    };
  }

  if (format === "qwen-chat-template") {
    assign("chat_template_kwargs", {
      enable_thinking: enabled,
      preserve_thinking: true,
    });
    return { changed, representation: enabled ? "binary" : "exact" };
  }

  if (format === "openrouter") {
    const value = enabled ? mapped : input.model.thinkingLevelMap?.off ?? "none";
    if (value === null || typeof value !== "string") {
      return providerDefault();
    }
    assign("reasoning", { effort: value });
    return { changed, representation: "exact" };
  }

  if (format === "together") {
    assign("reasoning", { enabled });
    if (enabled && detectedOpenAICompletionsReasoningEffortSupport(input)) {
      if (typeof mapped !== "string") {
        return providerDefault();
      }
      assign("reasoning_effort", mapped);
    } else {
      remove("reasoning_effort");
    }
    return {
      changed,
      representation:
        enabled && !detectedOpenAICompletionsReasoningEffortSupport(input)
          ? "binary"
          : "exact",
    };
  }

  if (format === "string-thinking") {
    const value = enabled ? mapped : input.model.thinkingLevelMap?.off ?? "none";
    if (value === null || typeof value !== "string") {
      return providerDefault();
    }
    assign("thinking", value);
    return { changed, representation: "exact" };
  }

  if (format === "ant-ling") {
    if (!enabled || typeof mapped !== "string") {
      return providerDefault();
    }
    assign("reasoning", { effort: mapped });
    return { changed, representation: "exact" };
  }

  if (format === "chat-template" || format === "baseten") {
    const compat = (input.model as Model<"openai-completions">).compat;
    const configured =
      format === "chat-template"
        ? compat?.chatTemplateKwargs
        : compat?.chatTemplateArgs;
    if (configured === undefined || Object.keys(configured).length === 0) {
      return providerDefault();
    }
    const values: Record<string, unknown> = {};
    let hasEnablement = false;
    let hasGradedEffort = false;
    for (const [key, raw] of Object.entries(configured)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        values[key] = raw;
        continue;
      }
      const variable = raw as Readonly<Record<string, unknown>>;
      if (!enabled && variable.omitWhenOff === true) continue;
      if (variable.$var === "thinking.enabled") {
        values[key] = enabled;
        hasEnablement = true;
      } else if (typeof mapped === "string") {
        values[key] = mapped;
        hasGradedEffort = true;
      }
    }
    assign(
      format === "chat-template"
        ? "chat_template_kwargs"
        : "chat_template_args",
      values,
    );
    if (
      format === "baseten" &&
      detectedOpenAICompletionsReasoningEffortSupport(input) &&
      typeof mapped === "string"
    ) {
      assign("reasoning_effort", mapped);
      hasGradedEffort = true;
    }
    if (enabled && !hasGradedEffort && !hasEnablement) return providerDefault();
    if (!enabled && !hasEnablement && !hasGradedEffort) return providerDefault();
    return {
      changed,
      representation: enabled && !hasGradedEffort ? "binary" : "exact",
    };
  }

  if (format === "openai") {
    if (!detectedOpenAICompletionsReasoningEffortSupport(input)) {
      return providerDefault();
    }
    if (typeof mapped !== "string") {
      return providerDefault();
    }
    assign("reasoning_effort", mapped);
    return { changed, representation: "exact" };
  }

  return providerDefault();
}

export function projectOpenAICompletionsPayload(
  input: ProjectInput,
): ResponsesReasoningProjectionResult {
  const payload = record(input.payload, input.model.api);
  requireShape(payload, input.model.api, [
    ["model", "string"],
    ["messages", "array"],
    ["stream", "true"],
  ]);
  const effort = input.prepared.request.effort;
  const controls: ResponsesReasoningOutcome[] = [];
  const unavailable = unavailableEnabledSelection(input);
  if (unavailable !== undefined) {
    deleteKnownOpenAICompletionsOffFields(payload, input);
    controls.push(unavailableEffortOutcome(input, unavailable));
  } else if (effort.kind === "disabled" && !input.model.reasoning) {
    const repaired = deleteKnownOpenAICompletionsOffFields(payload, input);
    controls.push(finalizedEffort(input, repaired));
  } else if (
    effort.kind === "disabled" &&
    input.model.thinkingLevelMap?.off === null
  ) {
    deleteKnownOpenAICompletionsOffFields(payload, input);
    controls.push(unavailableDisabledOutcome(input));
  } else if (effort.kind === "provider-default") {
    const repaired = deleteKnownOpenAICompletionsOffFields(payload, input);
    controls.push(
      repaired
        ? repairedEffort(input)
        : outcome("effort", { kind: "pi-native" }),
    );
  } else {
    const verification = verifyOpenAICompletionsEffort(payload, input);
    controls.push(
      verification.representation === "provider-default"
        ? effort.kind === "disabled"
          ? unavailableDisabledOutcome(input)
          : uncertifiedEnabledOutcome(input, "reasoning-to-provider-default")
        : verification.representation === "binary"
          ? uncertifiedEnabledOutcome(input, "reasoning-to-binary-enable")
          : finalizedEffort(input, verification.changed),
    );
  }
  const summaryOutcome = unsupportedSummary(input);
  if (summaryOutcome !== undefined) controls.push(summaryOutcome);
  return finish(payload, input, controls);
}

export function projectPiMessagesPayload(
  input: ProjectInput,
): ResponsesReasoningProjectionResult {
  const payload = record(input.payload, input.model.api);
  requireShape(payload, input.model.api, [
    ["model", "string"],
    ["context", "object"],
    ["options", "object"],
  ]);
  const options = { ...(payload.options as Record<string, unknown>) };
  const effort = input.prepared.request.effort;
  const unavailable = unavailableEnabledSelection(input);
  let disabledUnavailable = false;
  let repaired = false;
  if (unavailable !== undefined) {
    delete options.reasoning;
  } else if (effort.kind === "disabled") {
    repaired = Object.hasOwn(options, "reasoning");
    delete options.reasoning;
    disabledUnavailable = input.model.reasoning;
  } else if (effort.kind === "provider-default") {
    repaired = Object.hasOwn(options, "reasoning");
    delete options.reasoning;
  } else if (
    effort.kind === "enabled" &&
    options.reasoning !== selectedEnabledLevel(input)
  ) {
    options.reasoning = selectedEnabledLevel(input);
    repaired = true;
  }
  payload.options = options;
  const controls = [
    unavailable !== undefined
      ? unavailableEffortOutcome(input, unavailable)
      : disabledUnavailable
        ? unavailableDisabledOutcome(input)
      : finalizedEffort(input, repaired),
  ];
  const summaryOutcome = unsupportedSummary(input);
  if (summaryOutcome !== undefined) controls.push(summaryOutcome);
  return finish(payload, input, controls);
}
