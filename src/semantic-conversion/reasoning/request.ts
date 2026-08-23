import type {
  Context,
  Message,
  Model,
  ModelsSimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";

import type {
  PreparedReasoning,
  ReasoningContinuityAttachment,
  ReasoningOutcome,
  ReasoningProjectionResult,
  ReasoningSemantics,
} from "./contract.js";
import { resolveReasoningAdapter } from "./registry.js";

export class InvalidReasoningSemantics extends Error {
  readonly kind = "InvalidReasoningSemantics";

  constructor(message: string) {
    super(message);
    this.name = "InvalidReasoningSemantics";
  }
}

function cloneContext(context: Context): Context {
  return structuredClone(context);
}

function cloneOptions(
  options: ModelsSimpleStreamOptions,
): ModelsSimpleStreamOptions {
  return {
    ...options,
    ...(options.samplingParams === undefined
      ? {}
      : { samplingParams: { ...options.samplingParams } }),
    ...(options.metadata === undefined
      ? {}
      : { metadata: { ...options.metadata } }),
    ...(options.headers === undefined
      ? {}
      : { headers: { ...options.headers } }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.thinkingBudgets === undefined
      ? {}
      : { thinkingBudgets: { ...options.thinkingBudgets } }),
  };
}

function continuityForHistory(
  semantics: ReasoningSemantics,
  messageIndex: number,
  contentIndex: number,
): readonly ReasoningContinuityAttachment[] {
  return semantics.continuity.filter(
    (entry) =>
      entry.attachment.target === "thinking" &&
      entry.attachment.messageIndex === messageIndex &&
      entry.attachment.contentIndex === contentIndex,
  );
}

function replaceThinkingWithText(
  message: Message,
  contentIndex: number,
  thinking: string,
): void {
  if (message.role !== "assistant") {
    throw new InvalidReasoningSemantics(
      "historical reasoning attachment did not resolve to an assistant message",
    );
  }
  const content = message.content as Array<
    TextContent | ThinkingContent | ToolCall
  >;
  content[contentIndex] = { type: "text", text: thinking };
}

export function prepareReasoning(input: {
  readonly model: Model<string>;
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
  readonly semantics: ReasoningSemantics;
}): PreparedReasoning {
  const context = cloneContext(input.context);
  const options = cloneOptions(input.options);
  const outcomes: ReasoningOutcome[] = [];
  const adapter = resolveReasoningAdapter(input.model);

  for (const history of input.semantics.history) {
    const { messageIndex, contentIndex } = history.attachment;
    const message = context.messages[messageIndex];
    if (message?.role !== "assistant") {
      throw new InvalidReasoningSemantics(
        "historical reasoning attachment did not resolve to an assistant message",
      );
    }
    const block = message.content[contentIndex];
    if (
      block?.type !== "thinking" ||
      block.thinking !== history.summaryText
    ) {
      throw new InvalidReasoningSemantics(
        "historical reasoning attachment did not resolve to its thinking block",
      );
    }
    const continuity = continuityForHistory(
      input.semantics,
      messageIndex,
      contentIndex,
    );
    if (adapter === undefined) {
      const reason = "resolved API has no certified reasoning Adapter";
      replaceThinkingWithText(message, contentIndex, block.thinking);
      outcomes.push(
        Object.freeze({
          subject: "history",
          attachment: Object.freeze({
            target: "thinking",
            ...history.attachment,
          }),
          outcome: Object.freeze({ kind: "content-fallback", reason }),
        }),
      );
      continue;
    }
    const decision = adapter.prepareHistory({
      model: input.model,
      block,
      history,
      continuity,
    });
    if (decision.kind === "content-fallback") {
      replaceThinkingWithText(message, contentIndex, block.thinking);
    } else {
      if (decision.thinkingSignature !== undefined) {
        block.thinkingSignature = decision.thinkingSignature;
      }
      if (decision.redacted === true) {
        block.redacted = true;
      }
      if (decision.rebindAssistant) {
        message.provider = input.model.provider;
        message.api = input.model.api;
        message.model = input.model.id;
      }
    }
    outcomes.push(
      Object.freeze({
        subject: "history",
        attachment: Object.freeze({
          target: "thinking",
          ...history.attachment,
        }),
        outcome: decision.outcome,
      }),
    );
  }

  for (const continuity of input.semantics.continuity) {
    if (continuity.attachment.target === "thinking") continue;
    const { messageIndex, contentIndex } = continuity.attachment;
    const message = context.messages[messageIndex];
    if (message?.role !== "assistant") {
      throw new InvalidReasoningSemantics(
        "reasoning continuity did not resolve to an assistant message",
      );
    }
    const block = message.content[contentIndex];
    const targetMatchesBlock =
      (continuity.attachment.target === "text" && block?.type === "text") ||
      (continuity.attachment.target === "toolCall" &&
        block?.type === "toolCall" &&
        block.id === continuity.attachment.callId);
    if (!targetMatchesBlock || block === undefined) {
      throw new InvalidReasoningSemantics(
        "reasoning continuity did not resolve to its Pi content block",
      );
    }
    const decision = adapter?.prepareContinuity?.({
      model: input.model,
      block,
      continuity,
    }) ?? {
      kind: "omit" as const,
      outcome: Object.freeze({
        kind: "omitted" as const,
        warning: "resolved API has no certified continuity mapping",
      }),
    };
    if (decision.kind === "native") {
      if (decision.field === "textSignature" && block.type === "text") {
        block.textSignature = decision.value;
      } else if (
        decision.field === "thoughtSignature" &&
        block.type === "toolCall"
      ) {
        block.thoughtSignature = decision.value;
      } else {
        throw new InvalidReasoningSemantics(
          "reasoning Adapter selected an incompatible Pi signature field",
        );
      }
      if (decision.rebindAssistant) {
        message.provider = input.model.provider;
        message.api = input.model.api;
        message.model = input.model.id;
      }
    }
    outcomes.push(
      Object.freeze({
        subject: "history",
        attachment: continuity.attachment,
        outcome: decision.outcome,
      }),
    );
  }

  if (input.semantics.request.effort.kind === "enabled") {
    options.reasoning = input.semantics.request.effort.level;
  }

  return Object.freeze({
    context,
    options: Object.freeze(options),
    request: input.semantics.request,
    outcomes: Object.freeze(outcomes),
    ...(adapter === undefined ? {} : { adapterId: adapter.id }),
  });
}

export function projectReasoningPayload(input: {
  readonly model: Model<string>;
  readonly prepared: PreparedReasoning;
  readonly payload: unknown;
}): ReasoningProjectionResult {
  const adapter = resolveReasoningAdapter(input.model);
  if (adapter !== undefined) {
    return adapter.projectPayload(input);
  }
  const outcomes: ReasoningOutcome[] = [...input.prepared.outcomes];
  const effort = input.prepared.request.effort;
  if (effort.kind === "disabled") {
    outcomes.push(
      Object.freeze({
        subject: "effort",
        outcome: Object.freeze({
          kind: "failed",
          error: "resolved API has no certified reasoning payload Adapter",
        }),
      }),
    );
  } else if (effort.kind === "enabled") {
    outcomes.push(
      Object.freeze({
        subject: "effort",
        outcome: Object.freeze({
          kind: "omitted",
          warning: "resolved API has no certified reasoning effort mapping",
        }),
      }),
    );
  }
  if (input.prepared.request.summary.kind === "requested") {
    outcomes.push(
      Object.freeze({
        subject: "summary",
        outcome: Object.freeze({
          kind: "omitted",
          warning: "resolved API has no certified reasoning summary mapping",
        }),
      }),
    );
  }
  return Object.freeze({
    payload: structuredClone(input.payload),
    outcomes: Object.freeze(outcomes),
  });
}
