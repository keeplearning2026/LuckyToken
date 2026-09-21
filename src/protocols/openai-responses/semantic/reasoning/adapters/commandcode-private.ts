import type {
  ResponsesReasoningAdapter,
  ResponsesReasoningHistoryPreparationInput,
} from "./contract.js";
import { fallback, native } from "./continuity-decisions.js";

export const responsesToCommandCodePrivateReasoningAdapter: ResponsesReasoningAdapter =
  Object.freeze({
    id: "commandcode-private",
    api: "commandcode-private",
    prepareHistory(input: ResponsesReasoningHistoryPreparationInput) {
      return input.model.reasoning
        ? native()
        : fallback("target does not support reasoning");
    },
  });
