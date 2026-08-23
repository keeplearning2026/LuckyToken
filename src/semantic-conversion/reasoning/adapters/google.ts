import type {
  ReasoningAdapter,
  ReasoningContinuityPreparationInput,
  ReasoningHistoryPreparationInput,
} from "./contract.js";
import {
  continuitySourceMatchesTarget,
  fallback,
  findCompatibleThinkingContinuity,
  native,
  nativeContinuity,
  omitContinuity,
  sourceMatchesTarget,
} from "./shared.js";
import { projectGooglePayload } from "./payload.js";

function adapter(api: "google-generative-ai" | "google-vertex"): ReasoningAdapter {
  return Object.freeze({
    id: api,
    api,
    projectPayload: projectGooglePayload,
    prepareHistory(input: ReasoningHistoryPreparationInput) {
      if (!input.model.reasoning) {
        return fallback("target does not support reasoning");
      }
      if (!sourceMatchesTarget(input.history.source, input)) {
        return fallback("Google thought provenance is not compatible with the target");
      }
      const signature = findCompatibleThinkingContinuity(
        input,
        "opaque-signature",
      );
      return native(
        signature === undefined
          ? undefined
          : { thinkingSignature: signature.value },
      );
    },
    prepareContinuity(input: ReasoningContinuityPreparationInput) {
      if (
        input.continuity.kind !== "opaque-signature" ||
        !continuitySourceMatchesTarget(input) ||
        !isValidBase64(input.continuity.value)
      ) {
        return omitContinuity(
          "Google thought signature is malformed or target-incompatible",
        );
      }
      if (
        input.block.type === "text" &&
        input.continuity.attachment.target === "text"
      ) {
        return nativeContinuity("textSignature", input.continuity.value);
      }
      if (
        input.block.type === "toolCall" &&
        input.continuity.attachment.target === "toolCall"
      ) {
        return nativeContinuity("thoughtSignature", input.continuity.value);
      }
      return omitContinuity("Google thought signature attachment is misplaced");
    },
  });
}

const BASE64_SIGNATURE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function isValidBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_SIGNATURE.test(value);
}

export const googleGenerativeAIReasoningAdapter = adapter(
  "google-generative-ai",
);
export const googleVertexReasoningAdapter = adapter("google-vertex");
