import type { Model } from "@earendil-works/pi-ai";

import type { ReasoningRequestIntent } from "../../reasoning/contract.js";
import type {
  ProjectionSupplement,
  SupplementProjectionResult,
} from "../contract.js";

export interface SupplementProjectionInput {
  readonly model: Model<string>;
  readonly payload: unknown;
  readonly supplement: ProjectionSupplement;
  readonly reasoning: ReasoningRequestIntent;
}

export interface SupplementProjector {
  readonly id: string;
  readonly api: string;
  project(input: SupplementProjectionInput): SupplementProjectionResult;
}

export class InvalidSupplementProjection extends Error {
  readonly kind = "InvalidSupplementProjection";

  constructor(message: string) {
    super(message);
    this.name = "InvalidSupplementProjection";
  }
}
