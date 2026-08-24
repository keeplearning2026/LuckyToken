import type { Model } from "@earendil-works/pi-ai";

import type { ResponsesReasoningRequestIntent } from "../../reasoning/contract.js";
import type {
  ResponsesProjectionSupplement,
  ResponsesProjectionResult,
} from "../../supplement/contract.js";

export interface ResponsesTargetProjectionInput {
  readonly model: Model<string>;
  readonly payload: unknown;
  readonly supplement: ResponsesProjectionSupplement;
  readonly reasoning: ResponsesReasoningRequestIntent;
}

export interface ResponsesTargetProjector {
  readonly id: string;
  readonly api: string;
  project(input: ResponsesTargetProjectionInput): ResponsesProjectionResult;
}

export class InvalidResponsesProjection extends Error {
  readonly kind = "InvalidResponsesProjection";

  constructor(message: string) {
    super(message);
    this.name = "InvalidResponsesProjection";
  }
}
