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
} from "./shared.js";
import { projectOpenAIResponsesPayload } from "./payload.js";

function isCompleteReasoningItem(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const item = parsed as Record<string, unknown>;
  return (
    item.type === "reasoning" &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.length > 0
  );
}

function adapter(api: string): ReasoningAdapter {
  return Object.freeze({
    id: api,
    api,
    projectPayload: projectOpenAIResponsesPayload,
    prepareHistory(input: ReasoningHistoryPreparationInput) {
      if (!input.model.reasoning) {
        return fallback("target does not support reasoning");
      }
      const item = findCompatibleThinkingContinuity(
        input,
        "responses-reasoning-item",
      );
      if (item === undefined || !isCompleteReasoningItem(item.value)) {
        return fallback(
          "a complete same-target Responses reasoning item is unavailable",
        );
      }
      return native({ thinkingSignature: item.value });
    },
    prepareContinuity(input: ReasoningContinuityPreparationInput) {
      if (
        input.block.type !== "text" ||
        input.continuity.attachment.target !== "text" ||
        input.continuity.kind !== "opaque-signature" ||
        !continuitySourceMatchesTarget(input)
      ) {
        return omitContinuity(
          "Responses continuity is not compatible with the target text item",
        );
      }
      return nativeContinuity("textSignature", input.continuity.value);
    },
  });
}

export const openAIResponsesReasoningAdapter = adapter("openai-responses");
export const azureOpenAIResponsesReasoningAdapter = adapter(
  "azure-openai-responses",
);
export const openAICodexResponsesReasoningAdapter = adapter(
  "openai-codex-responses",
);
