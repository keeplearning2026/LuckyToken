export type ResponsesReasoningEffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ResponsesReasoningEffortIntent =
  | { readonly kind: "provider-default" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly level: ResponsesReasoningEffortLevel;
    };

export type ResponsesReasoningSummaryPreference = "auto" | "concise" | "detailed";

export type ResponsesReasoningSummaryIntent =
  | { readonly kind: "provider-default" }
  | {
      readonly kind: "requested";
      readonly value: ResponsesReasoningSummaryPreference;
    };

export interface ResponsesReasoningRequestIntent {
  readonly effort: ResponsesReasoningEffortIntent;
  readonly summary: ResponsesReasoningSummaryIntent;
}

export interface ResponsesReasoningSource {
  readonly provider: string;
  readonly api: string;
  readonly model: string;
}

export interface ResponsesHistoricalReasoning {
  readonly attachment: {
    readonly messageIndex: number;
    readonly contentIndex: number;
    readonly sourceItemId?: string;
  };
  readonly summaryText: string;
  readonly source?: ResponsesReasoningSource;
}

export type ResponsesReasoningContinuityAttachmentPoint =
  | {
      readonly target: "thinking" | "text";
      readonly messageIndex: number;
      readonly contentIndex: number;
      readonly sourceItemId?: string;
    }
  | {
      readonly target: "toolCall";
      readonly messageIndex: number;
      readonly contentIndex: number;
      readonly callId: string;
    };

export interface ResponsesReasoningContinuityAttachment {
  readonly attachment: ResponsesReasoningContinuityAttachmentPoint;
  readonly source: ResponsesReasoningSource;
  readonly kind:
    | "opaque-signature"
    | "responses-reasoning-item"
    | "reasoning-field-selector";
  readonly value: string;
  readonly representation?: "redacted";
}

export interface ResponsesReasoningSemantics {
  readonly request: ResponsesReasoningRequestIntent;
  readonly history: readonly ResponsesHistoricalReasoning[];
  readonly continuity: readonly ResponsesReasoningContinuityAttachment[];
}

import type { ResponsesProjectionOutcome } from "../projection/outcome.js";
export type { ResponsesProjectionOutcome } from "../projection/outcome.js";

export interface ResponsesReasoningOutcome {
  readonly subject: "history" | "effort" | "summary";
  readonly attachment?: ResponsesReasoningContinuityAttachmentPoint;
  readonly outcome: ResponsesProjectionOutcome;
}

export interface PreparedResponsesReasoning {
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
  readonly request: ResponsesReasoningRequestIntent;
  readonly outcomes: readonly ResponsesReasoningOutcome[];
  readonly adapterId?: string;
}

export interface ResponsesReasoningProjectionResult {
  readonly payload: unknown;
  readonly outcomes: readonly ResponsesReasoningOutcome[];
}
import type {
  Context,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
