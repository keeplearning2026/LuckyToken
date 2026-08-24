import type { ResponsesReasoningSource } from "../contract.js";
import type {
  ResponsesReasoningContinuityPreparationDecision,
  ResponsesReasoningContinuityPreparationInput,
  ResponsesReasoningHistoryPreparationDecision,
  ResponsesReasoningHistoryPreparationInput,
} from "./contract.js";

export function sourceMatchesTarget(
  source: ResponsesReasoningSource | undefined,
  input: ResponsesReasoningHistoryPreparationInput,
): boolean {
  return (
    source?.provider === input.model.provider &&
    source.api === input.model.api &&
    source.model === input.model.id
  );
}

export function fallback(reason: string): ResponsesReasoningHistoryPreparationDecision {
  return Object.freeze({
    kind: "content-fallback",
    reason,
    outcome: Object.freeze({ kind: "content-fallback", reason }),
  });
}

export function native(input?: {
  readonly thinkingSignature?: string;
  readonly redacted?: true;
}): ResponsesReasoningHistoryPreparationDecision {
  return Object.freeze({
    kind: "native",
    ...(input?.thinkingSignature === undefined
      ? {}
      : { thinkingSignature: input.thinkingSignature }),
    ...(input?.redacted === true ? { redacted: true as const } : {}),
    rebindAssistant: true,
    outcome: Object.freeze({ kind: "pi-native" }),
  });
}

export function findCompatibleThinkingContinuity(
  input: ResponsesReasoningHistoryPreparationInput,
  kind: "opaque-signature" | "responses-reasoning-item" | "reasoning-field-selector",
) {
  return input.continuity.find(
    (attachment) =>
      attachment.kind === kind &&
      sourceMatchesTarget(attachment.source, input),
  );
}

export function continuitySourceMatchesTarget(
  input: ResponsesReasoningContinuityPreparationInput,
): boolean {
  return (
    input.continuity.source.provider === input.model.provider &&
    input.continuity.source.api === input.model.api &&
    input.continuity.source.model === input.model.id
  );
}

export function nativeContinuity(
  field: "textSignature" | "thoughtSignature",
  value: string,
): ResponsesReasoningContinuityPreparationDecision {
  return Object.freeze({
    kind: "native",
    field,
    value,
    rebindAssistant: true,
    outcome: Object.freeze({ kind: "pi-native" }),
  });
}

export function omitContinuity(
  warning: string,
): ResponsesReasoningContinuityPreparationDecision {
  return Object.freeze({
    kind: "omit",
    outcome: Object.freeze({ kind: "omitted", warning }),
  });
}
