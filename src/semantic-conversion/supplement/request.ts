import type { Model } from "@earendil-works/pi-ai";

import type { ReasoningRequestIntent } from "../reasoning/contract.js";
import type {
  ProjectionSupplement,
  SupplementProjectionResult,
} from "./contract.js";
import { resolveSupplementProjector } from "./registry.js";
import {
  clonePayload,
  createState,
  finish,
  handleUniversalResponseContracts,
} from "./projectors/shared.js";

export function projectSupplementPayload(input: {
  readonly model: Model<string>;
  readonly payload: unknown;
  readonly supplement: ProjectionSupplement;
  readonly reasoning: ReasoningRequestIntent;
}): SupplementProjectionResult {
  const projector = resolveSupplementProjector(input.model);
  if (projector !== undefined) return projector.project(input);
  const payload = clonePayload(input.payload, input.model.api);
  const state = createState("uncertified-api", payload, input.supplement);
  handleUniversalResponseContracts(state);
  return finish(state);
}
