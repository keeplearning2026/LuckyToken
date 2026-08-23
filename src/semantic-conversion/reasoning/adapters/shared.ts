import type { ReasoningSource } from "../contract.js";
import type {
  ReasoningContinuityPreparationDecision,
  ReasoningContinuityPreparationInput,
  ReasoningHistoryPreparationDecision,
  ReasoningHistoryPreparationInput,
} from "./contract.js";

export function sourceMatchesTarget(
  source: ReasoningSource | undefined,
  input: ReasoningHistoryPreparationInput,
): boolean {
  return (
    source?.provider === input.model.provider &&
    source.api === input.model.api &&
    source.model === input.model.id
  );
}

export function fallback(reason: string): ReasoningHistoryPreparationDecision {
  return Object.freeze({
    kind: "content-fallback",
    reason,
    outcome: Object.freeze({ kind: "content-fallback", reason }),
  });
}

export function native(input?: {
  readonly thinkingSignature?: string;
  readonly redacted?: true;
}): ReasoningHistoryPreparationDecision {
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
  input: ReasoningHistoryPreparationInput,
  kind: "opaque-signature" | "responses-reasoning-item" | "reasoning-field-selector",
) {
  return input.continuity.find(
    (attachment) =>
      attachment.kind === kind &&
      sourceMatchesTarget(attachment.source, input),
  );
}

export function continuitySourceMatchesTarget(
  input: ReasoningContinuityPreparationInput,
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
): ReasoningContinuityPreparationDecision {
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
): ReasoningContinuityPreparationDecision {
  return Object.freeze({
    kind: "omit",
    outcome: Object.freeze({ kind: "omitted", warning }),
  });
}
