import type { Context, Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../invocation.js";
import type { AnthropicProjectionOutcome } from "../projection/contract.js";

export interface PreparedAnthropicReasoning {
  readonly invocation: AnthropicSemanticInvocation;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
}

function sourceMatches(
  candidate: AnthropicSemanticInvocation["reasoning"]["continuity"][number],
  model: Model<string>,
): boolean {
  return (
    candidate.source.provider === model.provider &&
    candidate.source.api === model.api &&
    candidate.source.model === model.id
  );
}

function contentAt(
  context: Context,
  messageIndex: number,
  contentIndex: number,
): Record<string, unknown> | undefined {
  const message = context.messages[messageIndex];
  if (message?.role !== "assistant") return undefined;
  const block = message.content[contentIndex] as unknown;
  return typeof block === "object" && block !== null && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : undefined;
}

function acceptsNativeAnthropicHistory(model: Model<string>): boolean {
  return model.api === "anthropic-messages";
}

export function prepareAnthropicReasoning(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): PreparedAnthropicReasoning {
  const context = structuredClone(input.invocation.pi.context);
  const outcomes: AnthropicProjectionOutcome[] = [];
  const continuityByBlock = new Map<string, typeof input.invocation.reasoning.continuity>();
  for (const candidate of input.invocation.reasoning.continuity) {
    const key = `${candidate.piMessageIndex}:${candidate.piContentIndex}`;
    const existing = continuityByBlock.get(key) ?? [];
    continuityByBlock.set(key, [...existing, candidate]);
  }

  for (const [messageIndex, message] of context.messages.entries()) {
    if (message.role !== "assistant") continue;
    const candidates = input.invocation.reasoning.continuity.filter(
      (candidate) => candidate.piMessageIndex === messageIndex,
    );
    if (candidates.length === 0 || !candidates.every((candidate) => sourceMatches(candidate, input.model))) {
      continue;
    }
    const first = candidates[0]?.source;
    if (
      first !== undefined &&
      candidates.every(
        (candidate) =>
          candidate.source.provider === first.provider &&
          candidate.source.api === first.api &&
          candidate.source.model === first.model,
      )
    ) {
      message.provider = first.provider;
      message.api = first.api;
      message.model = first.model;
    }
  }

  for (const history of input.invocation.reasoning.history) {
    const block = contentAt(context, history.piMessageIndex, history.piContentIndex);
    if (block?.type !== "thinking") continue;
    const key = `${history.piMessageIndex}:${history.piContentIndex}`;
    const candidates = continuityByBlock.get(key) ?? [];
    const nativeProvenance = candidates.find(
      (candidate) => candidate.attachment.kind === "native-field-provenance",
    );
    const keepNative =
      nativeProvenance === undefined
        ? acceptsNativeAnthropicHistory(input.model)
        : sourceMatches(nativeProvenance, input.model);
    if (!keepNative && block.thinkingSignature !== undefined) {
      delete block.thinkingSignature;
      if (block.redacted === true) delete block.redacted;
      outcomes.push(
        Object.freeze({
          control: `reasoning.history[${history.sourceMessageIndex}:${history.sourceContentIndex}]`,
          outcome: Object.freeze({
            kind: "omitted" as const,
            warning: "opaque native thinking state is incompatible with the resolved target",
          }),
        }),
      );
    }
  }

  for (const candidate of input.invocation.reasoning.continuity) {
    if (candidate.attachment.kind === "native-field-provenance") continue;
    const block = contentAt(
      context,
      candidate.piMessageIndex,
      candidate.piContentIndex,
    );
    if (block === undefined) continue;
    if (!sourceMatches(candidate, input.model)) {
      outcomes.push(
        Object.freeze({
          control: `reasoning.continuity[${candidate.sourceMessageIndex}:${candidate.sourceContentIndex}]`,
          outcome: Object.freeze({
            kind: "omitted" as const,
            warning: "opaque continuity provenance is incompatible with the resolved target",
          }),
        }),
      );
      continue;
    }
    if (candidate.attachment.target === "thinking" && block.type === "thinking") {
      block.thinkingSignature = candidate.attachment.value;
    } else if (candidate.attachment.target === "text" && block.type === "text") {
      block.textSignature = candidate.attachment.value;
    } else if (
      candidate.attachment.target === "toolCall" &&
      block.type === "toolCall" &&
      block.id === candidate.attachment.callId
    ) {
      block.thoughtSignature = candidate.attachment.value;
    } else {
      outcomes.push(
        Object.freeze({
          control: `reasoning.continuity[${candidate.sourceMessageIndex}:${candidate.sourceContentIndex}]`,
          outcome: Object.freeze({
            kind: "omitted" as const,
            warning: "opaque continuity attachment no longer resolves to its Pi block",
          }),
        }),
      );
      continue;
    }
    outcomes.push(
      Object.freeze({
        control: `reasoning.continuity[${candidate.sourceMessageIndex}:${candidate.sourceContentIndex}]`,
        outcome: Object.freeze({ kind: "pi-native" as const }),
      }),
    );
  }

  const invocation: AnthropicSemanticInvocation = Object.freeze({
    pi: Object.freeze({
      context,
      options: input.invocation.pi.options,
    }),
    reasoning: input.invocation.reasoning,
    supplement: input.invocation.supplement,
  });
  return Object.freeze({
    invocation,
    outcomes: Object.freeze(outcomes),
  });
}
