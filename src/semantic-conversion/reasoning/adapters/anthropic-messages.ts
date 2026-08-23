import type {
  AnthropicMessagesCompat,
  Model,
} from "@earendil-works/pi-ai";

import type {
  ReasoningAdapter,
  ReasoningHistoryPreparationInput,
} from "./contract.js";
import {
  fallback,
  findCompatibleThinkingContinuity,
  native,
  sourceMatchesTarget,
} from "./shared.js";
import { projectAnthropicPayload } from "./payload.js";

export const anthropicMessagesReasoningAdapter: ReasoningAdapter =
  Object.freeze({
    id: "anthropic-messages",
    api: "anthropic-messages",
    projectPayload: projectAnthropicPayload,
    prepareHistory(input: ReasoningHistoryPreparationInput) {
      if (!input.model.reasoning) {
        return fallback("target does not support reasoning");
      }
      const signature = findCompatibleThinkingContinuity(
        input,
        "opaque-signature",
      );
      if (signature !== undefined) {
        return native({
          thinkingSignature: signature.value,
          ...(signature.representation === "redacted"
            ? { redacted: true as const }
            : {}),
        });
      }
      const compat = (input.model as Model<"anthropic-messages">).compat as
        | AnthropicMessagesCompat
        | undefined;
      if (
        compat?.allowEmptySignature === true &&
        sourceMatchesTarget(input.history.source, input)
      ) {
        return native({ thinkingSignature: "" });
      }
      return fallback("Anthropic historical thinking requires a compatible signature");
    },
  });
