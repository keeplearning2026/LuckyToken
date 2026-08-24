import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
} from "../contract.js";

export interface AnthropicOpenAICompletionsProjectionResult {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
  readonly failure?: string;
}

const TOP_K_CERTIFIED_PROVIDERS = new Set([
  "commandcode-private",
  "commandcode-goat",
  "opencode-go",
]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("openai-completions payload must be an object");
  }
  return structuredClone(value) as Record<string, unknown>;
}

function requirePayloadShape(payload: Record<string, unknown>): void {
  if (
    typeof payload.model !== "string" ||
    !Array.isArray(payload.messages) ||
    payload.stream !== true
  ) {
    throw new Error("openai-completions payload shape mismatch");
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function add(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  outcome: AnthropicProjectionDisposition,
): void {
  outcomes.push(Object.freeze({ control, outcome: Object.freeze(outcome) }));
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
    projector: "anthropic-to-openai-completions",
    warning: "pi-native-mapping-repaired",
  });
}

function degraded(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  warning: string,
): void {
  add(outcomes, control, { kind: "degraded", warning });
}

function filterNamedOpenAITool(
  tools: unknown,
  name: string,
): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const tool = candidate as Readonly<Record<string, unknown>>;
    const fn = tool.function;
    return typeof fn === "object" && fn !== null && !Array.isArray(fn) &&
      (fn as Readonly<Record<string, unknown>>).name === name;
  });
}

/**
 * CommandCode GOAT direct wire-probe evidence. Keep this comment beside the
 * compatibility rule and do not remove or weaken it without rerunning the
 * independent GOAT online certification and updating the Anthropic audit.
 *
 * Direct upstream probes on 2026-08-23 against
 * commandcode-goat/deepseek/deepseek-v4-flash showed that named and required
 * tool_choice requests returned HTTP 400 with "Thinking mode does not support
 * this tool_choice". The result was unchanged with serial-tool requests, high
 * or max reasoning effort, `thinking.type=disabled`, or
 * `enable_thinking=false`; `reasoning_effort=none` was itself rejected. The
 * bounded best-effort alternative (`tool_choice=auto`, only the named tool
 * exposed, `parallel_tool_calls=false`) selected that tool in 9/9 probes, but
 * this observation is not an exact forced-tool guarantee.
 */
function forcedToolChoiceFailure(
  model: Model<string>,
  invocation: AnthropicSemanticInvocation,
): string | undefined {
  const choice = invocation.supplement.toolChoice;
  if (choice?.kind !== "any" && choice?.kind !== "named") return undefined;
  if (
    model.provider === "commandcode-goat" &&
    model.id === "deepseek/deepseek-v4-flash"
  ) {
    return "CommandCode Goat deepseek-v4-flash thinking mode does not support forced tool_choice";
  }
  return undefined;
}

/**
 * Online evidence captured on 2026-08-24 showed that both targets below
 * returned reasoning even when Pi emitted `thinking.type=disabled`. Treat that
 * wire spelling as an unavailable exact control until replacement online
 * certification proves otherwise.
 */
function cannotGuaranteeExplicitReasoningDisable(model: Model<string>): boolean {
  return (
    model.provider === "opencode-go" && model.id === "deepseek-v4-flash"
  ) || (
    model.provider === "commandcode-goat" &&
    model.id === "deepseek/deepseek-v4-flash"
  );
}

function explicitReasoningDisableWarning(model: Model<string>): string {
  const target = model.provider === "commandcode-goat"
    ? "CommandCode GOAT deepseek-v4-flash"
    : "OpenCode Go deepseek-v4-flash";
  return `${target} does not guarantee reasoning disable; LuckyToken removed known reasoning controls and accepted the target default`;
}

export function initialAnthropicToOpenAICompletionsFailure(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): string | undefined {
  if (input.invocation.supplement.inferenceGeo.kind === "specified") {
    return "openai-completions has no certified inference geography control";
  }
  return undefined;
}

type OpenAIThinkingFormat =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "together"
  | "baseten"
  | "zai"
  | "qwen"
  | "chat-template"
  | "qwen-chat-template"
  | "string-thinking"
  | "ant-ling";

type ChatTemplateValue =
  | string
  | number
  | boolean
  | null
  | {
      readonly $var: "thinking.enabled" | "thinking.effort";
      readonly omitWhenOff?: boolean;
    };

interface ExplicitOpenAIReasoningCompat {
  readonly thinkingFormat?: OpenAIThinkingFormat;
  readonly supportsReasoningEffort?: boolean;
  readonly chatTemplateKwargs?: Readonly<Record<string, ChatTemplateValue>>;
  readonly chatTemplateArgs?: Readonly<Record<string, ChatTemplateValue>>;
}

interface ResolvedOpenAIReasoningCompat extends ExplicitOpenAIReasoningCompat {
  readonly thinkingFormat: OpenAIThinkingFormat;
  readonly supportsReasoningEffort: boolean;
}

function resolvePiOpenAIReasoningCompat(
  model: Model<string>,
): ResolvedOpenAIReasoningCompat {
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  const isZai =
    provider === "zai" ||
    provider === "zai-coding-cn" ||
    baseUrl.includes("api.z.ai") ||
    baseUrl.includes("open.bigmodel.cn");
  const isTogether =
    provider === "together" ||
    baseUrl.includes("api.together.ai") ||
    baseUrl.includes("api.together.xyz");
  const isMoonshot =
    provider === "moonshotai" ||
    provider === "moonshotai-cn" ||
    baseUrl.includes("api.moonshot.");
  const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
  const isCloudflareAiGateway =
    provider === "cloudflare-ai-gateway" ||
    baseUrl.includes("gateway.ai.cloudflare.com");
  const isNvidia =
    provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
  const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
  const isDeepSeek =
    provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");
  const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
  const detectedThinkingFormat: OpenAIThinkingFormat = isDeepSeek
    ? "deepseek"
    : isZai
      ? "zai"
      : isTogether
        ? "together"
        : isAntLing
          ? "ant-ling"
          : isOpenRouter
            ? "openrouter"
            : "openai";
  const detectedSupportsReasoningEffort =
    !isGrok &&
    !isZai &&
    !isMoonshot &&
    !isTogether &&
    !isCloudflareAiGateway &&
    !isNvidia &&
    !isAntLing;
  const explicit = (model.compat ?? {}) as ExplicitOpenAIReasoningCompat;
  return Object.freeze({
    ...explicit,
    thinkingFormat: explicit.thinkingFormat ?? detectedThinkingFormat,
    supportsReasoningEffort:
      explicit.supportsReasoningEffort ?? detectedSupportsReasoningEffort,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deleteField(payload: Record<string, unknown>, field: string): boolean {
  if (!Object.hasOwn(payload, field)) return false;
  delete payload[field];
  return true;
}

function stripDynamicTemplateValues(
  payload: Record<string, unknown>,
  field: "chat_template_kwargs" | "chat_template_args",
  configured: Readonly<Record<string, ChatTemplateValue>> | undefined,
): boolean {
  if (!isRecord(payload[field])) return false;
  if (configured === undefined) return deleteField(payload, field);
  const next = { ...payload[field] };
  let changed = false;
  for (const [key, value] of Object.entries(configured)) {
    if (isRecord(value) && typeof value.$var === "string") {
      if (Object.hasOwn(next, key)) {
        delete next[key];
        changed = true;
      }
    }
  }
  if (!changed) return false;
  if (Object.keys(next).length === 0) delete payload[field];
  else payload[field] = next;
  return true;
}

function clearOmittedReasoning(
  payload: Record<string, unknown>,
  format: OpenAIThinkingFormat,
  compat: ExplicitOpenAIReasoningCompat,
): boolean {
  let changed = deleteField(payload, "reasoning_effort");
  changed = deleteField(payload, "thinking_token_budget") || changed;
  switch (format) {
    case "zai":
    case "deepseek":
    case "string-thinking":
      return deleteField(payload, "thinking") || changed;
    case "qwen":
      return deleteField(payload, "enable_thinking") || changed;
    case "openrouter":
    case "together":
    case "ant-ling":
      return deleteField(payload, "reasoning") || changed;
    case "qwen-chat-template":
      return deleteField(payload, "chat_template_kwargs") || changed;
    case "chat-template":
      return stripDynamicTemplateValues(
        payload,
        "chat_template_kwargs",
        compat.chatTemplateKwargs,
      ) || changed;
    case "baseten":
      return stripDynamicTemplateValues(
        payload,
        "chat_template_args",
        compat.chatTemplateArgs,
      ) || changed;
    case "openai":
      return changed;
  }
}

function nestedField(
  payload: Record<string, unknown>,
  field: string,
  nested: string,
): unknown {
  const value = payload[field];
  return isRecord(value) ? value[nested] : undefined;
}

function templateHasAppliedEffort(
  payload: Record<string, unknown>,
  field: "chat_template_kwargs" | "chat_template_args",
  configured: Readonly<Record<string, ChatTemplateValue>> | undefined,
  expected: string,
): boolean {
  const projected = payload[field];
  if (!isRecord(projected) || configured === undefined) return false;
  return Object.entries(configured).some(([key, value]) =>
    isRecord(value) &&
    value.$var === "thinking.effort" &&
    projected[key] === expected
  );
}

function hasDisabledReasoningShape(
  payload: Record<string, unknown>,
  model: Model<string>,
  format: OpenAIThinkingFormat,
  compat: ExplicitOpenAIReasoningCompat,
): boolean {
  const off = model.thinkingLevelMap?.off;
  switch (format) {
    case "zai":
    case "deepseek":
      return nestedField(payload, "thinking", "type") === "disabled";
    case "qwen":
      return payload.enable_thinking === false;
    case "qwen-chat-template":
      return nestedField(payload, "chat_template_kwargs", "enable_thinking") === false;
    case "chat-template": {
      const projected = payload.chat_template_kwargs;
      if (!isRecord(projected) || compat.chatTemplateKwargs === undefined) return false;
      return Object.entries(compat.chatTemplateKwargs).some(([key, value]) => {
        if (!isRecord(value)) return false;
        if (value.$var === "thinking.enabled") return projected[key] === false;
        return value.$var === "thinking.effort" && typeof off === "string" && projected[key] === off;
      });
    }
    case "baseten": {
      const projected = payload.chat_template_args;
      if (!isRecord(projected) || compat.chatTemplateArgs === undefined) return false;
      return Object.entries(compat.chatTemplateArgs).some(([key, value]) => {
        if (!isRecord(value)) return false;
        if (value.$var === "thinking.enabled") return projected[key] === false;
        return value.$var === "thinking.effort" && typeof off === "string" && projected[key] === off;
      });
    }
    case "openrouter":
      return off !== null && nestedField(payload, "reasoning", "effort") === (off ?? "none");
    case "together":
      return nestedField(payload, "reasoning", "enabled") === false;
    case "string-thinking":
      return off !== null && payload.thinking === (off ?? "none");
    case "ant-ling":
      return false;
    case "openai":
      return typeof off === "string" && payload.reasoning_effort === off;
  }
}

function hasEffortReasoningShape(
  payload: Record<string, unknown>,
  model: Model<string>,
  format: OpenAIThinkingFormat,
  compat: ResolvedOpenAIReasoningCompat,
  effort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
): boolean {
  const mapped = model.thinkingLevelMap?.[effort] ?? effort;
  if (mapped === null) return false;
  switch (format) {
    case "openrouter":
      return nestedField(payload, "reasoning", "effort") === mapped;
    case "string-thinking":
      return payload.thinking === mapped;
    case "ant-ling":
      return nestedField(payload, "reasoning", "effort") === mapped;
    case "qwen-chat-template":
      return false;
    case "chat-template":
      return templateHasAppliedEffort(
        payload,
        "chat_template_kwargs",
        compat.chatTemplateKwargs,
        mapped,
      );
    case "baseten":
      return templateHasAppliedEffort(
        payload,
        "chat_template_args",
        compat.chatTemplateArgs,
        mapped,
      ) || (compat.supportsReasoningEffort && payload.reasoning_effort === mapped);
    case "zai":
      return compat.supportsReasoningEffort &&
        nestedField(payload, "thinking", "type") === "enabled" &&
        payload.reasoning_effort === mapped;
    case "deepseek":
      return compat.supportsReasoningEffort &&
        nestedField(payload, "thinking", "type") === "enabled" &&
        payload.reasoning_effort === mapped;
    case "qwen":
      return compat.supportsReasoningEffort &&
        payload.enable_thinking === true &&
        payload.reasoning_effort === mapped;
    case "together":
      return compat.supportsReasoningEffort &&
        nestedField(payload, "reasoning", "enabled") === true &&
        payload.reasoning_effort === mapped;
    case "openai":
      return compat.supportsReasoningEffort && payload.reasoning_effort === mapped;
  }
}

function projectReasoning(
  payload: Record<string, unknown>,
  model: Model<string>,
  invocation: AnthropicSemanticInvocation,
  outcomes: AnthropicProjectionOutcome[],
): string | undefined {
  const activation = invocation.reasoning.activation;
  const effort = invocation.reasoning.effort;
  const compat = resolvePiOpenAIReasoningCompat(model);
  const format = compat.thinkingFormat;

  if (activation.kind === "omitted" && effort.kind !== "specified") {
    if (clearOmittedReasoning(payload, format, compat)) {
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-openai-completions",
        warning: "pi-native-mapping-repaired",
      });
    }
  } else if (activation.kind === "disabled") {
    delete payload.thinking_token_budget;
    if (cannotGuaranteeExplicitReasoningDisable(model)) {
      clearOmittedReasoning(payload, format, compat);
      degraded(
        outcomes,
        "reasoning.activation",
        explicitReasoningDisableWarning(model),
      );
    } else if (!hasDisabledReasoningShape(payload, model, format, compat)) {
      clearOmittedReasoning(payload, format, compat);
      degraded(
        outcomes,
        "reasoning.activation",
        `openai-completions ${format} target used its reasoning default after LuckyToken removed known enabling controls`,
      );
    } else {
      add(outcomes, "reasoning.activation", { kind: "pi-native" });
    }
  }

  if (effort.kind === "specified") {
    if (model.reasoning !== true) {
      clearOmittedReasoning(payload, format, compat);
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "target model does not support reasoning effort",
      });
    } else if (hasEffortReasoningShape(payload, model, format, compat, effort.level)) {
      add(outcomes, "reasoning.effort", { kind: "pi-native" });
    } else {
      clearOmittedReasoning(payload, format, compat);
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: `openai-completions ${format} has no certified ${effort.level} effort mapping`,
      });
    }
  }
  return undefined;
}

export function projectAnthropicToOpenAICompletions(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly payload: unknown;
}): AnthropicOpenAICompletionsProjectionResult {
  const payload = record(input.payload);
  requirePayloadShape(payload);
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  const maxField = Object.hasOwn(payload, "max_completion_tokens")
    ? "max_completion_tokens"
    : Object.hasOwn(payload, "max_tokens")
      ? "max_tokens"
      : undefined;
  if (maxField === undefined || typeof payload[maxField] !== "number") {
    return {
      payload,
      outcomes,
      failure: "openai-completions payload has no audited output-token field",
    };
  }
  const finalMaxTokens = Math.min(payload[maxField], supplement.outputTokenCeiling);
  exact(
    outcomes,
    "maxTokens",
    payload[maxField],
    finalMaxTokens,
    () => {
      payload[maxField] = finalMaxTokens;
    },
  );

  for (const [control, field, value] of [
    ["sampling.topP", "top_p", supplement.sampling.topP],
  ] as const) {
    if (value === undefined) continue;
    exact(outcomes, control, payload[field], value, () => {
      payload[field] = value;
    });
  }
  if (supplement.sampling.topK !== undefined) {
    if (TOP_K_CERTIFIED_PROVIDERS.has(input.model.provider)) {
      exact(
        outcomes,
        "sampling.topK",
        payload.top_k,
        supplement.sampling.topK,
        () => {
          payload.top_k = supplement.sampling.topK;
        },
      );
    }
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

  const choice = supplement.toolChoice;
  if (choice !== undefined) {
    const forcedUnsupported = forcedToolChoiceFailure(
      input.model,
      input.invocation,
    ) !== undefined;
    if (
      forcedUnsupported &&
      (choice.kind === "any" || choice.kind === "named")
    ) {
      payload.tool_choice = "auto";
      if (choice.kind === "named") {
        payload.tools = filterNamedOpenAITool(payload.tools, choice.name);
      }
      degraded(
        outcomes,
        "toolChoice",
        "CommandCode GOAT used automatic selection because thinking mode rejects forced tool_choice",
      );
    } else {
      const mapped =
        choice.kind === "named"
          ? { type: "function", function: { name: choice.name } }
          : choice.kind === "any"
            ? "required"
            : choice.kind;
      exact(outcomes, "toolChoice", payload.tool_choice, mapped, () => {
        payload.tool_choice = mapped;
      });
    }
    if (choice.kind !== "none") {
      exact(
        outcomes,
        "toolChoice.disableParallelToolUse",
        payload.parallel_tool_calls,
        !choice.disableParallelToolUse,
        () => {
          payload.parallel_tool_calls = !choice.disableParallelToolUse;
        },
      );
    }
  }

  const format = supplement.outputFormat;
  if (format.kind === "specified") {
    const mapped = {
      type: "json_schema",
      json_schema: {
        name: "anthropic_output",
        strict: true,
        schema: format.value.schema,
      },
    };
    exact(outcomes, "outputFormat", payload.response_format, mapped, () => {
      payload.response_format = mapped;
    });
  } else if (format.kind === "explicit-null") {
    delete payload.response_format;
    add(outcomes, "outputFormat", { kind: "pi-native" });
  }

  const userId = supplement.metadataUserId;
  if (userId.kind === "specified") {
    exact(outcomes, "metadataUserId", payload.user, userId.value, () => {
      payload.user = userId.value;
    });
  } else if (userId.kind === "explicit-null") {
    delete payload.user;
    add(outcomes, "metadataUserId", { kind: "pi-native" });
  }

  const tier = supplement.serviceTier;
  if (tier.kind === "specified") {
    const mapped = tier.value === "standard_only" ? "default" : "auto";
    exact(outcomes, "serviceTier", payload.service_tier, mapped, () => {
      payload.service_tier = mapped;
    });
  }

  const reasoningFailure = projectReasoning(
    payload,
    input.model,
    input.invocation,
    outcomes,
  );
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
    ...(reasoningFailure === undefined ? {} : { failure: reasoningFailure }),
  });
}
