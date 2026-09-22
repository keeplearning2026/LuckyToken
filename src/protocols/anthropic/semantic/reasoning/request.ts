import type {
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../invocation.js";
import type {
  AnthropicEffortPlan,
  AnthropicReasoningOutcome,
} from "./contract.js";
import { resolveAnthropicEffortPlan } from "./levels.js";

export interface PreparedAnthropicReasoning {
  readonly invocation: AnthropicSemanticInvocation;
  readonly effortPlan: AnthropicEffortPlan;
  readonly outcomes: readonly AnthropicReasoningOutcome[];
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

const MAX_UNKNOWN_EFFORT_DIAGNOSTIC_CHARS = 96;

function boundedDiagnosticValue(value: string): string {
  const characters = [...value];
  const bounded =
    characters.length <= MAX_UNKNOWN_EFFORT_DIAGNOSTIC_CHARS
      ? value
      : `${characters
          .slice(0, MAX_UNKNOWN_EFFORT_DIAGNOSTIC_CHARS - 3)
          .join("")}...`;
  return JSON.stringify(bounded);
}

const UNKNOWN_EFFORT_NOTICE = Object.freeze({
  code: "anthropic_unknown_effort_fallback",
  jsonPath: "$.output_config.effort",
});

function unknownEffortOutcome(
  originalEffort: string,
  resolution: string,
): AnthropicReasoningOutcome {
  return Object.freeze({
    candidateId: "reasoning.effort",
    outcome: Object.freeze({
      kind: "degraded" as const,
      warning: `Unknown Anthropic reasoning effort ${boundedDiagnosticValue(originalEffort)} was normalized to "max". ${resolution} When captured, the Provider request payload diagnostic is the factual final adapter representation.`,
    }),
    notice: UNKNOWN_EFFORT_NOTICE,
  });
}

function reasoningLevelForBudget(
  budget: number,
): "minimal" | "low" | "medium" | "high" {
  if (budget < 4_096) return "minimal";
  if (budget < 16_384) return "low";
  if (budget < 65_536) return "medium";
  return "high";
}

export function prepareAnthropicReasoning<TApi extends string>(input: {
  readonly model: Model<TApi>;
  readonly invocation: AnthropicSemanticInvocation;
}): PreparedAnthropicReasoning {
  const context = structuredClone(input.invocation.pi.context);
  const options = cloneOptions(input.invocation.pi.options);
  const effortPlan = resolveAnthropicEffortPlan(
    input.model,
    input.invocation.reasoning.effort,
  );
  delete options.reasoning;
  const outcomes: AnthropicReasoningOutcome[] = [];
  const activation = input.invocation.reasoning.activation;
  const normalizedFromUnknown =
    input.invocation.reasoning.effort.kind === "specified"
      ? input.invocation.reasoning.effort.normalizedFromUnknown
      : undefined;
  if (activation.kind === "disabled") {
    delete options.thinkingBudgets;
    outcomes.push(Object.freeze({
      candidateId: "reasoning.activation",
      outcome: Object.freeze({
        kind: "omitted" as const,
        warning: "explicit reasoning disable has no neutral Pi simple option; no reasoning level was requested and the target Pi adapter determines the resulting thinking behavior",
      }),
    }));
  } else if (!input.model.reasoning && (
    activation.kind === "enabled" ||
    activation.kind === "adaptive" ||
    effortPlan.kind === "specified"
  )) {
    delete options.thinkingBudgets;
    outcomes.push(Object.freeze(
      normalizedFromUnknown === undefined
        ? {
            candidateId: "reasoning.activation" as const,
            outcome: Object.freeze({
              kind: "degraded" as const,
              warning: "target model does not support reasoning; ordinary generation retained",
            }),
          }
        : unknownEffortOutcome(
            normalizedFromUnknown,
            "No Pi reasoning level was selected because the target model does not support reasoning. The target Pi adapter determines the resulting thinking behavior.",
          ),
    ));
  } else {
    const selectedLevel =
      effortPlan.kind === "specified" &&
      effortPlan.selection.kind === "selected"
        ? effortPlan.selection.level
        : activation.kind === "enabled"
          ? reasoningLevelForBudget(activation.budgetTokens)
          : activation.kind === "adaptive"
            ? "medium"
            : undefined;
    if (selectedLevel !== undefined) {
      options.reasoning = selectedLevel;
      outcomes.push(Object.freeze(
        normalizedFromUnknown === undefined
          ? {
              candidateId: "reasoning.activation" as const,
              outcome: Object.freeze({ kind: "pi-native" as const }),
            }
          : unknownEffortOutcome(
              normalizedFromUnknown,
              `Pi selected reasoning level ${JSON.stringify(selectedLevel)}. The target Pi adapter determines the final Provider request representation.`,
            ),
      ));
      if (activation.kind === "enabled") {
        const budgetLevel =
          selectedLevel === "xhigh" || selectedLevel === "max"
            ? "high"
            : selectedLevel;
        options.thinkingBudgets = Object.freeze({
          [budgetLevel]: activation.budgetTokens,
        });
      }
    } else if (
      effortPlan.kind === "specified" &&
      effortPlan.selection.kind !== "selected"
    ) {
      delete options.thinkingBudgets;
      outcomes.push(Object.freeze(
        normalizedFromUnknown === undefined
          ? {
              candidateId: "reasoning.effort" as const,
              outcome: Object.freeze({
                kind: "degraded" as const,
                warning:
                  effortPlan.selection.kind === "non-reasoning"
                    ? "target model does not support reasoning; ordinary generation retained"
                    : "target model exposes no selectable reasoning level; no Pi reasoning level was requested and the target Pi adapter determines the resulting thinking behavior",
              }),
            }
          : unknownEffortOutcome(
              normalizedFromUnknown,
              "No Pi reasoning level was selected for the target model. The target Pi adapter determines the resulting thinking behavior.",
            ),
      ));
    }
  }
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
    if (!input.model.reasoning) {
      const visibleThinking =
        history.representation === "thinking" && typeof block.thinking === "string"
          ? block.thinking
          : "";
      block.type = "text";
      block.text = visibleThinking;
      delete block.thinking;
      delete block.thinkingSignature;
      delete block.redacted;
      outcomes.push(
        Object.freeze({
          candidateId: `reasoning.history[${history.sourceMessageIndex}:${history.sourceContentIndex}]`,
          outcome: Object.freeze(
            visibleThinking.length > 0
              ? {
                  kind: "degraded" as const,
                  warning:
                    "visible historical thinking was replayed as ordinary assistant text for a non-reasoning target",
                }
              : {
                  kind: "omitted" as const,
                  warning:
                    "redacted historical thinking has no visible representation for a non-reasoning target",
                },
          ),
        }),
      );
      continue;
    }
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
          candidateId: `reasoning.history[${history.sourceMessageIndex}:${history.sourceContentIndex}]`,
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
          candidateId: `reasoning.continuity[${candidate.sourceMessageIndex}:${candidate.sourceContentIndex}]`,
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
          candidateId: `reasoning.continuity[${candidate.sourceMessageIndex}:${candidate.sourceContentIndex}]`,
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
        candidateId: `reasoning.continuity[${candidate.sourceMessageIndex}:${candidate.sourceContentIndex}]`,
        outcome: Object.freeze({ kind: "pi-native" as const }),
      }),
    );
  }

  const invocation: AnthropicSemanticInvocation = Object.freeze({
    pi: Object.freeze({
      context,
      options,
    }),
    reasoning: input.invocation.reasoning,
  });
  return Object.freeze({
    invocation,
    effortPlan,
    outcomes: Object.freeze(outcomes),
  });
}
