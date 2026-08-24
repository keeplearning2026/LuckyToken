import type {
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";

import type {
  ResponsesHistoricalReasoning,
  ResponsesReasoningContinuityAttachment,
  ResponsesProjectionOutcome,
  PreparedResponsesReasoning,
  ResponsesReasoningProjectionResult,
} from "../contract.js";

export interface ResponsesReasoningHistoryPreparationInput {
  readonly model: Model<string>;
  readonly block: ThinkingContent;
  readonly history: ResponsesHistoricalReasoning;
  readonly continuity: readonly ResponsesReasoningContinuityAttachment[];
}

export type ResponsesReasoningHistoryPreparationDecision =
  | {
      readonly kind: "native";
      readonly thinkingSignature?: string;
      readonly redacted?: true;
      readonly rebindAssistant: boolean;
      readonly outcome: ResponsesProjectionOutcome;
    }
  | {
      readonly kind: "content-fallback";
      readonly reason: string;
      readonly outcome: ResponsesProjectionOutcome;
    };

export interface ResponsesReasoningContinuityPreparationInput {
  readonly model: Model<string>;
  readonly block: TextContent | ToolCall;
  readonly continuity: ResponsesReasoningContinuityAttachment;
}

export type ResponsesReasoningContinuityPreparationDecision =
  | {
      readonly kind: "native";
      readonly field: "textSignature" | "thoughtSignature";
      readonly value: string;
      readonly rebindAssistant: boolean;
      readonly outcome: ResponsesProjectionOutcome;
    }
  | {
      readonly kind: "omit";
      readonly outcome: ResponsesProjectionOutcome;
    };

export interface ResponsesReasoningAdapter {
  readonly id: string;
  readonly api: string;
  prepareHistory(
    input: ResponsesReasoningHistoryPreparationInput,
  ): ResponsesReasoningHistoryPreparationDecision;
  prepareContinuity?(
    input: ResponsesReasoningContinuityPreparationInput,
  ): ResponsesReasoningContinuityPreparationDecision;
  projectPayload(input: {
    readonly model: Model<string>;
    readonly prepared: PreparedResponsesReasoning;
    readonly payload: unknown;
  }): ResponsesReasoningProjectionResult;
}
