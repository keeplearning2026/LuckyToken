import type { Model } from "@earendil-works/pi-ai";

export interface ResponsesPayloadProjectionResult<TOutcome> {
  readonly payload: unknown;
  readonly outcomes: readonly TOutcome[];
  readonly failure?: string;
}

export interface ResponsesPayloadProjectionOperation<TOutcome> {
  readonly initialOutcomes: readonly TOutcome[];
  readonly initialFailure?: string;
  project(
    payload: unknown,
    model: Model<string>,
  ):
    | ResponsesPayloadProjectionResult<TOutcome>
    | Promise<ResponsesPayloadProjectionResult<TOutcome>>;
}
