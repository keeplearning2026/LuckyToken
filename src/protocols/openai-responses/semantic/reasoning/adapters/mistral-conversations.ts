import type {
  ResponsesReasoningAdapter,
  ResponsesReasoningHistoryPreparationInput,
} from "./contract.js";
import { fallback, native, sourceMatchesTarget } from "./continuity-decisions.js";
import { projectMistralPayload } from "./payload.js";

export const responsesToMistralConversationsReasoningAdapter: ResponsesReasoningAdapter =
  Object.freeze({
    id: "mistral-conversations",
    api: "mistral-conversations",
    projectPayload: projectMistralPayload,
    prepareHistory(input: ResponsesReasoningHistoryPreparationInput) {
      if (!input.model.reasoning) {
        return fallback("target does not support reasoning");
      }
      return sourceMatchesTarget(input.history.source, input)
        ? native()
        : fallback("Mistral reasoning provenance is not compatible with the target");
    },
  });
