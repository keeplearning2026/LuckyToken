import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
} from "../contract.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("anthropic-messages payload must be an object");
  }
  return structuredClone(value) as Record<string, unknown>;
}

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
    projector: "anthropic-to-anthropic-messages",
    warning: "pi-native-mapping-repaired",
  });
}

function nullableValue<T>(
  intent:
    | { readonly kind: "omitted" }
    | { readonly kind: "explicit-null" }
    | { readonly kind: "specified"; readonly value: T },
): T | null | undefined {
  if (intent.kind === "omitted") return undefined;
  return intent.kind === "explicit-null" ? null : intent.value;
}

function thinkingValue(invocation: AnthropicSemanticInvocation): unknown {
  const activation = invocation.reasoning.activation;
  if (activation.kind === "omitted") return undefined;
  if (activation.kind === "disabled") return { type: "disabled" };
  const display = nullableValue(activation.display);
  return {
    type: activation.kind,
    ...(activation.kind === "enabled"
      ? { budget_tokens: activation.budgetTokens }
      : {}),
    ...(display === undefined ? {} : { display }),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return structuredClone(value) as Record<string, unknown>;
}

function projectedContentQueue(payload: Record<string, unknown>): Record<string, unknown>[] {
  const messages = payload.messages as unknown[];
  const queue: Record<string, unknown>[] = [];
  for (const [index, candidate] of messages.entries()) {
    const message = asRecord(candidate, `anthropic-messages messages[${index}]`);
    if (typeof message.content === "string") {
      queue.push({ type: "text", text: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      throw new Error(`anthropic-messages messages[${index}].content shape mismatch`);
    }
    for (const block of message.content) {
      queue.push(asRecord(block, `anthropic-messages messages[${index}].content`));
    }
  }
  return queue;
}

function reconstructMessages(
  payload: Record<string, unknown>,
  invocation: AnthropicSemanticInvocation,
): unknown[] | undefined {
  const frames = invocation.supplement.messageFrames;
  const queue = projectedContentQueue(payload);
  const messages = frames.map((frame) => {
    const content = frame.entries.map((entry) => {
      if (entry.ownership === "supplement") {
        if (entry.consumesPi) {
          const consumed = queue.shift();
          if (consumed === undefined) {
            throw new Error("anthropic-messages content association did not resolve");
          }
        }
        return structuredClone(entry.value);
      }
      const projected = queue.shift();
      if (projected === undefined) {
        throw new Error("anthropic-messages Pi content association did not resolve");
      }
      return projected;
    });
    return { role: frame.role, content };
  });
  if (queue.length !== 0) {
    throw new Error("anthropic-messages payload contains unassociated Pi content");
  }
  return messages;
}

function reconstructTools(
  payload: Record<string, unknown>,
  invocation: AnthropicSemanticInvocation,
): unknown[] | undefined {
  const supplements = invocation.supplement.tools;
  if (supplements.length === 0) return undefined;
  const projected = Array.isArray(payload.tools)
    ? payload.tools.map((tool) => asRecord(tool, "anthropic-messages tool"))
    : [];
  const byIndex = new Map(supplements.map((tool) => [tool.sourceToolIndex, tool]));
  const total = Math.max(
    projected.length + supplements.filter((tool) => tool.piRepresentation === "none").length,
    ...supplements.map((tool) => tool.sourceToolIndex + 1),
  );
  const tools: unknown[] = [];
  for (let index = 0; index < total; index += 1) {
    const supplement = byIndex.get(index);
    if (supplement !== undefined) {
      if (supplement.piRepresentation === "partial" && projected.shift() === undefined) {
        throw new Error("anthropic-messages tool association did not resolve");
      }
      tools.push(structuredClone(supplement.value));
      continue;
    }
    const tool = projected.shift();
    if (tool === undefined) {
      throw new Error("anthropic-messages Pi tool association did not resolve");
    }
    tools.push(tool);
  }
  if (projected.length !== 0) {
    throw new Error("anthropic-messages payload contains unassociated Pi tools");
  }
  return tools;
}

export function projectAnthropicToAnthropicMessages(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly payload: unknown;
}): {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
  readonly failure?: string;
  readonly failureKind?: "unsupported-semantics";
} {
  const payload = record(input.payload);
  if (
    typeof payload.model !== "string" ||
    !Array.isArray(payload.messages) ||
    payload.stream !== true ||
    typeof payload.max_tokens !== "number"
  ) {
    throw new Error("anthropic-messages payload shape mismatch");
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  if (supplement.content.length > 0) {
    const messages = reconstructMessages(payload, input.invocation);
    if (messages !== undefined) {
      payload.messages = messages;
      add(outcomes, "content", {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
  }
  if (supplement.system?.kind === "blocks") {
    payload.system = supplement.system.blocks.map((block) => structuredClone(block));
    add(outcomes, "system", {
      kind: "payload-projected",
      projector: "anthropic-to-anthropic-messages",
    });
  }
  const tools = reconstructTools(payload, input.invocation);
  if (tools !== undefined) {
    payload.tools = tools;
    add(outcomes, "tools", {
      kind: "payload-projected",
      projector: "anthropic-to-anthropic-messages",
    });
  }

  const finalMaxTokens = Math.min(payload.max_tokens, supplement.outputTokenCeiling);
  exact(outcomes, "maxTokens", payload.max_tokens, finalMaxTokens, () => {
    payload.max_tokens = finalMaxTokens;
  });
  for (const [control, field, value] of [
    ["sampling.topP", "top_p", supplement.sampling.topP],
    ["sampling.topK", "top_k", supplement.sampling.topK],
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
      payload.stop_sequences,
      supplement.stopSequences,
      () => {
        payload.stop_sequences = [...supplement.stopSequences!];
      },
    );
  }

  const choice = supplement.toolChoice;
  if (choice !== undefined) {
    const mapped =
      choice.kind === "named"
        ? {
            type: "tool",
            name: choice.name,
            disable_parallel_tool_use: choice.disableParallelToolUse,
          }
        : choice.kind === "none"
          ? { type: "none" }
          : {
              type: choice.kind,
              disable_parallel_tool_use: choice.disableParallelToolUse,
            };
    exact(outcomes, "toolChoice", payload.tool_choice, mapped, () => {
      payload.tool_choice = mapped;
    });
  }

  const thinkingBudgetDoesNotFit =
    input.invocation.reasoning.activation.kind === "enabled" &&
    input.invocation.reasoning.activation.budgetTokens >= finalMaxTokens;
  const expectedThinking = thinkingBudgetDoesNotFit
    ? undefined
    : thinkingValue(input.invocation);
  if (thinkingBudgetDoesNotFit) {
    delete payload.thinking;
    add(outcomes, "reasoning.activation", {
      kind: "degraded",
      warning:
        "Anthropic thinking budget no longer fits below the context-safe final max_tokens ceiling; reasoning was disabled for this request",
    });
  } else if (expectedThinking === undefined) {
    const changed = Object.hasOwn(payload, "thinking");
    delete payload.thinking;
    if (changed) {
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
        warning: "pi-native-mapping-repaired",
      });
    }
  } else {
    exact(
      outcomes,
      "reasoning.activation",
      payload.thinking,
      expectedThinking,
      () => {
        payload.thinking = expectedThinking;
      },
    );
  }
  const format = nullableValue(supplement.outputFormat);
  const effortIntent = input.invocation.reasoning.effort;
  const outputConfig: Record<string, unknown> =
    typeof payload.output_config === "object" &&
      payload.output_config !== null &&
      !Array.isArray(payload.output_config)
      ? { ...(payload.output_config as Record<string, unknown>) }
      : {};
  if (effortIntent.kind === "specified") {
    if (typeof outputConfig.effort === "string") {
      add(outcomes, "reasoning.effort", { kind: "pi-native" });
    } else {
      add(outcomes, "reasoning.effort", {
        kind: "omitted",
        warning: "Pi did not emit a certified Anthropic effort field for this target model",
      });
    }
  }
  if (format !== undefined) {
    outputConfig.format =
      format === null
        ? null
        : { type: "json_schema", schema: format.schema };
  }
  if (Object.keys(outputConfig).length === 0) {
    delete payload.output_config;
  } else if (!same(payload.output_config, outputConfig)) {
    payload.output_config = outputConfig;
    add(outcomes, "outputFormat", {
      kind: "payload-projected",
      projector: "anthropic-to-anthropic-messages",
    });
  }

  const userId = nullableValue(supplement.metadataUserId);
  if (userId === undefined) {
    delete payload.metadata;
  } else {
    exact(
      outcomes,
      "metadataUserId",
      payload.metadata,
      { user_id: userId },
      () => {
        payload.metadata = { user_id: userId };
      },
    );
  }
  const tier = nullableValue(supplement.serviceTier);
  if (tier !== undefined) payload.service_tier = tier;
  const geo = nullableValue(supplement.inferenceGeo);
  if (geo !== undefined) payload.inference_geo = geo;
  const container = nullableValue(supplement.container);
  if (container !== undefined) payload.container = container;
  const cache = nullableValue(supplement.cacheControl);
  if (cache !== undefined) {
    payload.cache_control =
      cache === null
        ? null
        : { type: "ephemeral", ...(cache.ttl === undefined ? {} : { ttl: cache.ttl }) };
  }

  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}
