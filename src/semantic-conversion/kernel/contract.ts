import type { Model } from "@earendil-works/pi-ai";

export interface PayloadProjectionResult<TOutcome> {
  readonly payload: unknown;
  readonly outcomes: readonly TOutcome[];
  readonly failure?: string;
}

export interface PayloadProjectionOperation<TOutcome> {
  readonly initialOutcomes: readonly TOutcome[];
  readonly initialFailure?: string;
  project(
    payload: unknown,
    model: Model<string>,
  ):
    | PayloadProjectionResult<TOutcome>
    | Promise<PayloadProjectionResult<TOutcome>>;
}
