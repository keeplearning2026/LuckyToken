import type { Model } from "@earendil-works/pi-ai";

export type AnthropicProjectionDisposition =
  | { readonly kind: "pi-native" }
  | {
      readonly kind: "payload-projected";
      readonly projector: string;
      readonly warning?: "pi-native-mapping-repaired";
    }
  | { readonly kind: "degraded"; readonly warning: string }
  | { readonly kind: "omitted"; readonly warning: string }
  | { readonly kind: "failed"; readonly error: string };

export interface AnthropicProjectionOutcome {
  readonly control: string;
  readonly outcome: AnthropicProjectionDisposition;
}

export type AnthropicProjectionFailureKind =
  | "unsupported-semantics"
  | "payload-contract";

export interface AnthropicPayloadProjectionResult {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
  readonly failure?: string;
  readonly failureKind?: AnthropicProjectionFailureKind;
}

export interface AnthropicPayloadProjectionOperation {
  readonly initialOutcomes: readonly AnthropicProjectionOutcome[];
  readonly initialFailure?: string;
  project(
    payload: unknown,
    model: Model<string>,
  ):
    | AnthropicPayloadProjectionResult
    | Promise<AnthropicPayloadProjectionResult>;
}
