import type { Model } from "@earendil-works/pi-ai";

import { InvalidRequest, UnsupportedFeature } from "./failures.js";
import type { ResolvedAnthropicSourceProfile } from "./profile.js";
import type { ValidatedAnthropicSourceRequest } from "./request.js";

export type FinalAssistantPrefillValidity =
  | "allowed"
  | "forbidden"
  | "unknown";

export interface AnthropicModelValidityPolicy {
  readonly revision: string;
  classifyFinalAssistantPrefill(
    model: Model<string>,
    sourceProfile: ResolvedAnthropicSourceProfile,
  ): FinalAssistantPrefillValidity;
  hasCertifiedImageFidelity(model: Model<string>): boolean;
}

export const defaultAnthropicModelValidityPolicy: AnthropicModelValidityPolicy = {
  revision: "anthropic-model-validity-unclassified-v1",
  classifyFinalAssistantPrefill: () => "unknown",
  hasCertifiedImageFidelity: () => false,
};

export function assertAnthropicModelAwareValidity(
  request: ValidatedAnthropicSourceRequest,
  model: Model<string>,
  sourceProfile: ResolvedAnthropicSourceProfile,
  policy: AnthropicModelValidityPolicy,
): void {
  if (request.hasImages) {
    if (
      !model.input.includes("image") ||
      !policy.hasCertifiedImageFidelity(model)
    ) {
      throw new UnsupportedFeature(
        "Image input lacks a declared model capability or certified fidelity path",
      );
    }
  }

  if (request.finalAssistantPrefill) {
    const validity = policy.classifyFinalAssistantPrefill(model, sourceProfile);
    if (validity === "forbidden") {
      throw new InvalidRequest(
        "The resolved source model forbids final-assistant prefill",
      );
    }
    if (validity === "allowed") {
      throw new UnsupportedFeature(
        "Source-valid final-assistant prefill is outside LuckyToken v1",
      );
    }
    throw new UnsupportedFeature(
      "Final-assistant prefill source validity is unknown for the resolved model",
    );
  }
}
