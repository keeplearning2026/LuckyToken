import type { Model } from "@earendil-works/pi-ai";

import { UnsupportedFeature } from "./failures.js";
import type { ValidatedAnthropicSourceRequest } from "./request.js";

export interface AnthropicModelValidityPolicy {
  readonly revision: string;
  hasCertifiedImageFidelity(model: Model<string>): boolean;
}

export const defaultAnthropicModelValidityPolicy: AnthropicModelValidityPolicy = {
  revision: "anthropic-model-validity-unclassified-v1",
  hasCertifiedImageFidelity: () => false,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiresNativeAnthropicContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "image") {
    return isRecord(value.source) && value.source.type === "url";
  }
  if (value.type === "document") {
    return isRecord(value.source) &&
      (value.source.type === "url" || value.source.type === "base64");
  }
  if (value.type !== "tool_result" || !Array.isArray(value.content)) {
    return false;
  }
  return value.content.some(requiresNativeAnthropicContent);
}

function hasNativeOnlyContent(request: ValidatedAnthropicSourceRequest): boolean {
  return request.messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some(requiresNativeAnthropicContent),
  );
}

export function assertAnthropicModelAwareValidity(
  request: ValidatedAnthropicSourceRequest,
  model: Model<string>,
  policy: AnthropicModelValidityPolicy,
): void {
  if (hasNativeOnlyContent(request) && model.api !== "anthropic-messages") {
    throw new UnsupportedFeature(
      "The resolved target has no valid model-visible representation for an Anthropic document, media, or server-tool content block",
    );
  }

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

  // A final assistant turn is represented as ordinary assistant history, not
  // as a target-native prefill. Historical visible thinking similarly has a
  // bounded request-preparation fallback for non-reasoning targets.
}
