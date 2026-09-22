export type AnthropicThinkingDisplayIntent =
  | { readonly kind: "omitted" }
  | { readonly kind: "explicit-null" }
  | {
      readonly kind: "specified";
      readonly value: "summarized" | "omitted";
    };

export type AnthropicThinkingActivation =
  | { readonly kind: "omitted" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly budgetTokens: number;
      readonly display: AnthropicThinkingDisplayIntent;
    }
  | {
      readonly kind: "adaptive";
      readonly display: AnthropicThinkingDisplayIntent;
    };

export type AnthropicEffortIntent =
  | { readonly kind: "omitted" }
  | { readonly kind: "explicit-null" }
  | {
      readonly kind: "specified";
      readonly level: "low" | "medium" | "high" | "xhigh" | "max";
      readonly normalizedFromUnknown?: string;
    };

export type AnthropicSelectedPiEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type AnthropicEffortPlan =
  | { readonly kind: "omitted" }
  | { readonly kind: "explicit-null" }
  | {
      readonly kind: "specified";
      readonly requested: "low" | "medium" | "high" | "xhigh" | "max";
      readonly selection:
        | { readonly kind: "selected"; readonly level: AnthropicSelectedPiEffort }
        | { readonly kind: "no-selectable-level" }
        | { readonly kind: "non-reasoning" };
    };

export interface AnthropicHistoricalReasoning {
  readonly sourceMessageIndex: number;
  readonly sourceContentIndex: number;
  readonly piMessageIndex: number;
  readonly piContentIndex: number;
  readonly representation: "thinking" | "redacted";
}

export interface AnthropicContinuityCandidate {
  readonly sourceMessageIndex: number;
  readonly sourceContentIndex: number;
  readonly target: "thinking" | "text" | "toolCall";
  readonly callId?: string;
  readonly piMessageIndex: number;
  readonly piContentIndex: number;
  readonly source: AnthropicContinuitySource;
  readonly attachment: AnthropicContinuityAttachment;
}

export interface AnthropicReasoningSemantics {
  readonly activation: AnthropicThinkingActivation;
  readonly effort: AnthropicEffortIntent;
  readonly history: readonly AnthropicHistoricalReasoning[];
  readonly continuity: readonly AnthropicContinuityCandidate[];
}

export type AnthropicReasoningOutcomeId =
  | "reasoning.activation"
  | "reasoning.effort"
  | "reasoning.encrypted_content"
  | `reasoning.history[${number}:${number}]`
  | `reasoning.continuity[${number}:${number}]`;

export type AnthropicReasoningDisposition =
  | { readonly kind: "pi-native" }
  | { readonly kind: "degraded"; readonly warning: string }
  | { readonly kind: "omitted"; readonly warning: string };

export interface AnthropicReasoningOutcome {
  readonly candidateId: AnthropicReasoningOutcomeId;
  readonly outcome: AnthropicReasoningDisposition;
  readonly notice?: Readonly<{
    readonly code: string;
    readonly jsonPath?: string;
  }>;
}
import type {
  AnthropicContinuityAttachment,
  AnthropicContinuitySource,
} from "./continuity.js";
