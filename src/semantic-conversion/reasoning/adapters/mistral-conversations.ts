import type {
  ReasoningAdapter,
  ReasoningHistoryPreparationInput,
} from "./contract.js";
import { fallback, native, sourceMatchesTarget } from "./shared.js";
import { projectMistralPayload } from "./payload.js";

export const mistralConversationsReasoningAdapter: ReasoningAdapter =
  Object.freeze({
    id: "mistral-conversations",
    api: "mistral-conversations",
    projectPayload: projectMistralPayload,
    prepareHistory(input: ReasoningHistoryPreparationInput) {
      if (!input.model.reasoning) {
        return fallback("target does not support reasoning");
      }
      return sourceMatchesTarget(input.history.source, input)
        ? native()
        : fallback("Mistral reasoning provenance is not compatible with the target");
    },
  });
