import type {
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";

import type {
  HistoricalReasoning,
  ReasoningContinuityAttachment,
  ProjectionOutcome,
  PreparedReasoning,
  ReasoningProjectionResult,
} from "../contract.js";

export interface ReasoningHistoryPreparationInput {
  readonly model: Model<string>;
  readonly block: ThinkingContent;
  readonly history: HistoricalReasoning;
  readonly continuity: readonly ReasoningContinuityAttachment[];
}

export type ReasoningHistoryPreparationDecision =
  | {
      readonly kind: "native";
      readonly thinkingSignature?: string;
      readonly redacted?: true;
      readonly rebindAssistant: boolean;
      readonly outcome: ProjectionOutcome;
    }
  | {
      readonly kind: "content-fallback";
      readonly reason: string;
      readonly outcome: ProjectionOutcome;
    };

export interface ReasoningContinuityPreparationInput {
  readonly model: Model<string>;
  readonly block: TextContent | ToolCall;
  readonly continuity: ReasoningContinuityAttachment;
}

export type ReasoningContinuityPreparationDecision =
  | {
      readonly kind: "native";
      readonly field: "textSignature" | "thoughtSignature";
      readonly value: string;
      readonly rebindAssistant: boolean;
      readonly outcome: ProjectionOutcome;
    }
  | {
      readonly kind: "omit";
      readonly outcome: ProjectionOutcome;
    };

export interface ReasoningAdapter {
  readonly id: string;
  readonly api: string;
  prepareHistory(
    input: ReasoningHistoryPreparationInput,
  ): ReasoningHistoryPreparationDecision;
  prepareContinuity?(
    input: ReasoningContinuityPreparationInput,
  ): ReasoningContinuityPreparationDecision;
  projectPayload(input: {
    readonly model: Model<string>;
    readonly prepared: PreparedReasoning;
    readonly payload: unknown;
  }): ReasoningProjectionResult;
}
