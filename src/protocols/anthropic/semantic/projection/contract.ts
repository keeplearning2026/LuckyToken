import type { Model } from "@earendil-works/pi-ai";
import type { AnthropicCandidateId } from "../supplement/contract.js";

export type AnthropicReasoningOutcomeId =
  | "reasoning.activation"
  | "reasoning.effort"
  | "reasoning.encrypted_content"
  | `reasoning.history[${number}:${number}]`
  | `reasoning.continuity[${number}:${number}]`;

export type AnthropicProjectionOutcomeId =
  | AnthropicCandidateId
  | AnthropicReasoningOutcomeId;

export type AnthropicProjectionDisposition =
  | { readonly kind: "pi-native" }
  | {
      readonly kind: "payload-projected";
      readonly projector: string;
      readonly warning?: "pi-native-mapping-repaired";
    }
  | { readonly kind: "degraded"; readonly warning: string }
  | { readonly kind: "omitted"; readonly warning: string };

export interface AnthropicProjectionOutcome {
  readonly candidateId: AnthropicProjectionOutcomeId;
  readonly outcome: AnthropicProjectionDisposition;
}

export interface AnthropicPayloadProjectionResult {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
}

export interface AnthropicPayloadProjectionOperation {
  readonly initialOutcomes: readonly AnthropicProjectionOutcome[];
  project(
    payload: unknown,
    model: Model<string>,
  ):
    | AnthropicPayloadProjectionResult
    | Promise<AnthropicPayloadProjectionResult>;
}
