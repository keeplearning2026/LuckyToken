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
import { projectPiMessagesPayload } from "./payload.js";

export const piMessagesReasoningAdapter: ReasoningAdapter = Object.freeze({
  id: "pi-messages",
  api: "pi-messages",
  projectPayload: projectPiMessagesPayload,
  prepareHistory(input: ReasoningHistoryPreparationInput) {
    if (!input.model.reasoning) {
      return fallback("target does not support reasoning");
    }
    if (!sourceMatchesTarget(input.history.source, input)) {
      return fallback("Pi Messages reasoning provenance is not compatible with the target");
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
      !continuitySourceMatchesTarget(input)
    ) {
      return omitContinuity("Pi Messages continuity is target-incompatible");
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
    return omitContinuity("Pi Messages continuity attachment is misplaced");
  },
});
