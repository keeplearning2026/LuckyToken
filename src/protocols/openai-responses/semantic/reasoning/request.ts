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
  PreparedResponsesReasoning,
  ResponsesReasoningContinuityAttachment,
  ResponsesReasoningOutcome,
  ResponsesReasoningProjectionResult,
  ResponsesReasoningSemantics,
} from "./contract.js";
import { resolveResponsesEffortPlan } from "./levels.js";
import { resolveResponsesReasoningAdapter } from "./registry.js";

export class InvalidResponsesReasoningSemantics extends Error {
  readonly kind = "InvalidResponsesReasoningSemantics";

  constructor(message: string) {
    super(message);
    this.name = "InvalidResponsesReasoningSemantics";
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
  semantics: ResponsesReasoningSemantics,
  messageIndex: number,
  contentIndex: number,
): readonly ResponsesReasoningContinuityAttachment[] {
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
    throw new InvalidResponsesReasoningSemantics(
      "historical reasoning attachment did not resolve to an assistant message",
    );
  }
  const content = message.content as Array<
    TextContent | ThinkingContent | ToolCall
  >;
  content[contentIndex] = { type: "text", text: thinking };
}

export function prepareResponsesReasoning<TApi extends string>(input: {
  readonly model: Model<TApi>;
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
  readonly semantics: ResponsesReasoningSemantics;
}): PreparedResponsesReasoning {
  const context = cloneContext(input.context);
  const options = cloneOptions(input.options);
  const outcomes: ResponsesReasoningOutcome[] = [];
  const adapter = resolveResponsesReasoningAdapter(input.model);

  for (const history of input.semantics.history) {
    const { messageIndex, contentIndex } = history.attachment;
    const message = context.messages[messageIndex];
    if (message?.role !== "assistant") {
      throw new InvalidResponsesReasoningSemantics(
        "historical reasoning attachment did not resolve to an assistant message",
      );
    }
    const block = message.content[contentIndex];
    if (
      block?.type !== "thinking" ||
      block.thinking !== history.summaryText
    ) {
      throw new InvalidResponsesReasoningSemantics(
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
      throw new InvalidResponsesReasoningSemantics(
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
      throw new InvalidResponsesReasoningSemantics(
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
        throw new InvalidResponsesReasoningSemantics(
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

  const effortPlan = resolveResponsesEffortPlan(
    input.model,
    input.semantics.request.effort,
  );
  delete options.reasoning;
  if (
    effortPlan.kind === "enabled" &&
    effortPlan.selection.kind === "selected"
  ) {
    options.reasoning = effortPlan.selection.level;
  }

  return Object.freeze({
    context,
    options: Object.freeze(options),
    request: input.semantics.request,
    effortPlan,
    outcomes: Object.freeze(outcomes),
    ...(adapter === undefined ? {} : { adapterId: adapter.id }),
  });
}

export function projectResponsesReasoningPayload(input: {
  readonly model: Model<string>;
  readonly prepared: PreparedResponsesReasoning;
  readonly payload: unknown;
}): ResponsesReasoningProjectionResult {
  const adapter = resolveResponsesReasoningAdapter(input.model);
  if (adapter !== undefined) {
    return adapter.projectPayload(input);
  }
  const outcomes: ResponsesReasoningOutcome[] = [...input.prepared.outcomes];
  const effort = input.prepared.request.effort;
  if (effort.kind === "disabled") {
    outcomes.push(
      Object.freeze({
        subject: "effort",
        outcome: Object.freeze({
          kind: "degraded",
          projector: input.model.api,
          fallback: "reasoning-disable-to-provider-default",
          warning:
            "resolved API has no certified reasoning payload Adapter; Provider default retained",
        }),
      }),
    );
  } else if (effort.kind === "enabled") {
    const nonReasoning =
      input.prepared.effortPlan.kind === "enabled" &&
      input.prepared.effortPlan.selection.kind === "non-reasoning";
    outcomes.push(
      Object.freeze({
        subject: "effort",
        outcome: Object.freeze({
          kind: "degraded",
          projector: input.model.api,
          fallback: nonReasoning
            ? "reasoning-to-ordinary-generation"
            : "reasoning-to-provider-default",
          warning: nonReasoning
            ? "target model does not support reasoning; ordinary generation retained"
            : "resolved API has no certified reasoning effort mapping; Provider default retained",
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
