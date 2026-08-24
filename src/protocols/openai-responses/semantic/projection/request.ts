import type { Model } from "@earendil-works/pi-ai";

import type { ResponsesReasoningRequestIntent } from "../reasoning/contract.js";
import type {
  ResponsesProjectionSupplement,
  ResponsesProjectionResult,
} from "../supplement/contract.js";
import { resolveResponsesTargetProjector } from "./registry.js";
import {
  clonePayload,
  createState,
  finish,
} from "./adapters/candidate-resolution.js";

export function projectResponsesPayload(input: {
  readonly model: Model<string>;
  readonly payload: unknown;
  readonly supplement: ResponsesProjectionSupplement;
  readonly reasoning: ResponsesReasoningRequestIntent;
}): ResponsesProjectionResult {
  const projector = resolveResponsesTargetProjector(input.model);
  if (projector !== undefined) return projector.project(input);
  const payload = clonePayload(input.payload, input.model.api);
  const state = createState("uncertified-api", payload, input.supplement);
  return finish(state);
}
