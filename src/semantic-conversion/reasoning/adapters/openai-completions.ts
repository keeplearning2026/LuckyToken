import type {
  Model,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";

import type {
  ReasoningAdapter,
  ReasoningContinuityPreparationInput,
  ReasoningHistoryPreparationInput,
} from "./contract.js";
import type { ReasoningContinuityAttachment } from "../contract.js";
import {
  continuitySourceMatchesTarget,
  nativeContinuity,
  omitContinuity,
} from "./shared.js";
import { projectOpenAICompletionsPayload } from "./payload.js";

const REASONING_FIELD_SELECTORS = new Set([
  "reasoning_content",
  "reasoning",
  "reasoning_text",
]);

export const openAICompletionsReasoningAdapter: ReasoningAdapter =
  Object.freeze({
    id: "openai-completions",
    api: "openai-completions",
    projectPayload: projectOpenAICompletionsPayload,
    prepareHistory(input: ReasoningHistoryPreparationInput) {
      const compat = (input.model as Model<"openai-completions">).compat as
        | OpenAICompletionsCompat
        | undefined;
      if (
        input.model.reasoning !== true ||
        compat?.requiresThinkingAsText === true
      ) {
        const reason =
          input.model.reasoning === true
            ? "target requires historical thinking as assistant content"
            : "target does not support reasoning";
        return Object.freeze({
          kind: "content-fallback",
          reason,
          outcome: Object.freeze({ kind: "content-fallback", reason }),
        });
      }

      const selector = input.continuity.find(
        (attachment: ReasoningContinuityAttachment) =>
          attachment.kind === "reasoning-field-selector" &&
          attachment.source.provider === input.model.provider &&
          attachment.source.api === input.model.api &&
          attachment.source.model === input.model.id &&
          REASONING_FIELD_SELECTORS.has(attachment.value),
      );
      // Pi's Chat Completions serializer requires a field selector in
      // thinkingSignature. Preserve a verified same-target selector when it
      // exists; otherwise use Pi's portable Chat reasoning field for visible
      // summaries. This selector is deterministic target adapter state, not
      // opaque source continuity, so it must not be stored in the client wire.
      const targetSelector = selector?.value ?? "reasoning_content";
      return Object.freeze({
        kind: "native",
        thinkingSignature: targetSelector,
        rebindAssistant: true,
        outcome: Object.freeze({ kind: "pi-native" }),
      });
    },
    prepareContinuity(input: ReasoningContinuityPreparationInput) {
      if (
        input.block.type !== "toolCall" ||
        input.continuity.attachment.target !== "toolCall" ||
        input.continuity.kind !== "opaque-signature" ||
        !continuitySourceMatchesTarget(input)
      ) {
        return omitContinuity(
          "OpenAI Completions continuity is not compatible with the target tool call",
        );
      }
      try {
        const parsed = JSON.parse(input.continuity.value) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return omitContinuity("OpenAI reasoning detail is malformed");
        }
      } catch {
        return omitContinuity("OpenAI reasoning detail is malformed");
      }
      return nativeContinuity("thoughtSignature", input.continuity.value);
    },
  });
