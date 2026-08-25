import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type { AnthropicEffortPlan } from "../../reasoning/contract.js";
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

interface ProjectionInput {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly effortPlan: AnthropicEffortPlan;
  readonly payload: unknown;
}

function projectAnthropicToAnthropicMessages(
  input: ProjectionInput,
  phase: "reasoning" | "supplement",
): {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
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

  if (phase === "supplement" && supplement.content.length > 0) {
    const messages = reconstructMessages(payload, input.invocation);
    if (messages !== undefined) {
      payload.messages = messages;
      for (const entry of supplement.content) {
        add(
          outcomes,
          `content[${entry.sourceMessageIndex}:${entry.sourceContentIndex}]`,
          {
            kind: "payload-projected",
            projector: "anthropic-to-anthropic-messages",
          },
        );
      }
    }
  }
  if (phase === "supplement" && supplement.system?.kind === "blocks") {
    payload.system = supplement.system.blocks.map((block) => structuredClone(block));
    add(outcomes, "system", {
      kind: "payload-projected",
      projector: "anthropic-to-anthropic-messages",
    });
    if (supplement.system.blocks.some((block) => Object.hasOwn(block, "cache_control"))) {
      add(outcomes, "system.cacheControl", {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
  }
  const tools = phase === "supplement"
    ? reconstructTools(payload, input.invocation)
    : undefined;
  if (tools !== undefined) {
    payload.tools = tools;
    for (const entry of supplement.tools) {
      add(outcomes, `tools[${entry.sourceToolIndex}]`, {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
  }

  if (phase === "supplement") {
    const finalMaxTokens = Math.min(payload.max_tokens, supplement.outputTokenCeiling);
    exact(outcomes, "maxTokens", payload.max_tokens, finalMaxTokens, () => {
      payload.max_tokens = finalMaxTokens;
    });
    for (const [control, field, value] of [
      ["sampling.temperature", "temperature", supplement.sampling.temperature],
      ["sampling.topP", "top_p", supplement.sampling.topP],
      ["sampling.topK", "top_k", supplement.sampling.topK],
    ] as const) {
      if (value === undefined) continue;
      if (control === "sampling.temperature") {
        if (same(payload[field], value)) {
          add(outcomes, control, { kind: "pi-native" });
        }
        continue;
      }
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
  }

  const choice = supplement.toolChoice;
  if (phase === "supplement" && choice !== undefined) {
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
    const choiceWasExact = same(payload.tool_choice, mapped);
    exact(outcomes, "toolChoice", payload.tool_choice, mapped, () => {
      payload.tool_choice = mapped;
    });
    if (choice.kind !== "none" && choice.disableParallelToolUse) {
      add(
        outcomes,
        "toolChoice.disableParallelToolUse",
        choiceWasExact
          ? { kind: "pi-native" }
          : {
              kind: "payload-projected",
              projector: "anthropic-to-anthropic-messages",
              warning: "pi-native-mapping-repaired",
            },
      );
    }
  }

  const thinkingBudgetDoesNotFit = phase === "reasoning" &&
    input.invocation.reasoning.activation.kind === "enabled" &&
    input.invocation.reasoning.activation.budgetTokens >= payload.max_tokens;
  const requestedThinking = input.invocation.reasoning.activation;
  const targetCannotReason =
    !input.model.reasoning &&
    (requestedThinking.kind === "enabled" || requestedThinking.kind === "adaptive");
  const expectedThinking = thinkingBudgetDoesNotFit || targetCannotReason
    ? undefined
    : thinkingValue(input.invocation);
  if (phase === "reasoning" && thinkingBudgetDoesNotFit) {
    delete payload.thinking;
    add(outcomes, "reasoning.activation", {
      kind: "degraded",
      warning:
        "Anthropic thinking budget no longer fits below the context-safe final max_tokens ceiling; reasoning was disabled for this request",
    });
  } else if (phase === "reasoning" && targetCannotReason) {
    delete payload.thinking;
    add(outcomes, "reasoning.activation", {
      kind: "degraded",
      warning:
        "target model does not support reasoning; ordinary generation was retained",
    });
  } else if (phase === "reasoning" && expectedThinking === undefined) {
    const changed = Object.hasOwn(payload, "thinking");
    delete payload.thinking;
    if (changed) {
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
        warning: "pi-native-mapping-repaired",
      });
    }
  } else if (phase === "reasoning") {
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
  const effortPlan = input.effortPlan;
  const outputConfig: Record<string, unknown> =
    typeof payload.output_config === "object" &&
      payload.output_config !== null &&
      !Array.isArray(payload.output_config)
      ? { ...(payload.output_config as Record<string, unknown>) }
      : {};
  if (phase === "reasoning" && effortPlan.kind === "specified") {
    if (effortPlan.selection.kind !== "selected") {
      delete outputConfig.effort;
      add(outcomes, "reasoning.effort", {
        kind: "degraded",
        warning:
          effortPlan.selection.kind === "non-reasoning"
            ? "target model does not support reasoning; ordinary generation was retained"
            : "target model exposes no selectable reasoning level; Provider default was retained",
      });
    } else {
      const mapped = input.model.thinkingLevelMap?.[effortPlan.selection.level];
      const expected =
        typeof mapped === "string"
          ? mapped
          : effortPlan.selection.level === "minimal"
            ? undefined
            : effortPlan.selection.level;
      if (expected === undefined) {
        delete outputConfig.effort;
        add(outcomes, "reasoning.effort", {
          kind: "degraded",
          warning:
            "target has no certified Anthropic effort value for the selected Pi level; Provider default was retained",
        });
      } else if (outputConfig.effort === expected) {
        add(
          outcomes,
          "reasoning.effort",
          effortPlan.requested === effortPlan.selection.level
            ? { kind: "pi-native" }
            : {
                kind: "degraded",
                warning: `requested reasoning level ${effortPlan.requested} mapped to supported Pi level ${effortPlan.selection.level}`,
              },
        );
      } else {
        outputConfig.effort = expected;
        add(outcomes, "reasoning.effort", {
          kind: "payload-projected",
          projector: "anthropic-to-anthropic-messages",
          warning: "pi-native-mapping-repaired",
        });
      }
    }
  }
  if (phase === "supplement" && format !== undefined) {
    outputConfig.format =
      format === null
        ? null
        : { type: "json_schema", schema: format.schema };
  }
  if (Object.keys(outputConfig).length === 0) {
    delete payload.output_config;
  } else if (!same(payload.output_config, outputConfig)) {
    payload.output_config = outputConfig;
    if (phase === "supplement" && format !== undefined) {
      add(outcomes, "outputFormat", {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
  }

  if (phase === "supplement") {
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
    if (tier !== undefined) {
      exact(outcomes, "serviceTier", payload.service_tier, tier, () => {
        payload.service_tier = tier;
      });
    }
    const geo = nullableValue(supplement.inferenceGeo);
    if (geo !== undefined) {
      exact(outcomes, "inferenceGeo", payload.inference_geo, geo, () => {
        payload.inference_geo = geo;
      });
    }
    const container = nullableValue(supplement.container);
    if (container !== undefined) {
      exact(outcomes, "container", payload.container, container, () => {
        payload.container = container;
      });
    }
    const cache = nullableValue(supplement.cacheControl);
    if (cache !== undefined) {
      const expected =
        cache === null
          ? null
          : { type: "ephemeral", ...(cache.ttl === undefined ? {} : { ttl: cache.ttl }) };
      exact(outcomes, "cacheControl", payload.cache_control, expected, () => {
        payload.cache_control = expected;
      });
    }
  }

  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}

export function projectAnthropicToAnthropicMessagesReasoning(
  input: ProjectionInput,
) {
  return projectAnthropicToAnthropicMessages(input, "reasoning");
}

export function projectAnthropicToAnthropicMessagesSupplement(
  input: ProjectionInput,
) {
  return projectAnthropicToAnthropicMessages(input, "supplement");
}
