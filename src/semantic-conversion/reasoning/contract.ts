export type ReasoningEffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningEffortIntent =
  | { readonly kind: "provider-default" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly level: ReasoningEffortLevel;
    };

export type ReasoningSummaryPreference = "auto" | "concise" | "detailed";

export type ReasoningSummaryIntent =
  | { readonly kind: "provider-default" }
  | {
      readonly kind: "requested";
      readonly value: ReasoningSummaryPreference;
    };

export interface ReasoningRequestIntent {
  readonly effort: ReasoningEffortIntent;
  readonly summary: ReasoningSummaryIntent;
}

export interface ReasoningSource {
  readonly provider: string;
  readonly api: string;
  readonly model: string;
}

export interface HistoricalReasoning {
  readonly attachment: {
    readonly messageIndex: number;
    readonly contentIndex: number;
    readonly sourceItemId?: string;
  };
  readonly summaryText: string;
  readonly source?: ReasoningSource;
}

export type ReasoningContinuityAttachmentPoint =
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

export interface ReasoningContinuityAttachment {
  readonly attachment: ReasoningContinuityAttachmentPoint;
  readonly source: ReasoningSource;
  readonly kind:
    | "opaque-signature"
    | "responses-reasoning-item"
    | "reasoning-field-selector";
  readonly value: string;
  readonly representation?: "redacted";
}

export interface ReasoningSemantics {
  readonly request: ReasoningRequestIntent;
  readonly history: readonly HistoricalReasoning[];
  readonly continuity: readonly ReasoningContinuityAttachment[];
}

import type { ProjectionOutcome } from "../projection-outcome.js";
export type { ProjectionOutcome } from "../projection-outcome.js";

export interface ReasoningOutcome {
  readonly subject: "history" | "effort" | "summary";
  readonly attachment?: ReasoningContinuityAttachmentPoint;
  readonly outcome: ProjectionOutcome;
}

export interface PreparedReasoning {
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
  readonly request: ReasoningRequestIntent;
  readonly outcomes: readonly ReasoningOutcome[];
  readonly adapterId?: string;
}

export interface ReasoningProjectionResult {
  readonly payload: unknown;
  readonly outcomes: readonly ReasoningOutcome[];
}
import type {
  Context,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
