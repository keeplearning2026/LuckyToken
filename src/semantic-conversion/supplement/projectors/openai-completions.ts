import type {
  SupplementProjectionInput,
  SupplementProjector,
} from "./contract.js";
import { forcedToolChoiceRestriction } from "../certified-compatibility.js";
import {
  clonePayload,
  createState,
  finish,
  handleUniversalResponseContracts,
  native,
  projectExactNumber,
  projected,
  requireNativeNumber,
  requirePayloadShape,
  toChatResponseFormat,
  toChatCompletionsToolChoice,
  unsupported,
} from "./shared.js";

export const openAICompletionsSupplementProjector: SupplementProjector =
  Object.freeze({
    id: "openai-completions",
    api: "openai-completions",
    project(input: SupplementProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["model", "string"],
        ["messages", "array"],
        ["stream", "true"],
      ]);
      const state = createState(this.id, payload, input.supplement);
      handleUniversalResponseContracts(state);

      const format = input.supplement.output?.format;
      if (format !== undefined) {
        const mapped = toChatResponseFormat(format.value);
        if (mapped === undefined) {
          native(state, "output.format");
        } else {
          payload.response_format = mapped;
          projected(state, "output.format");
        }
      }
      const verbosity = input.supplement.output?.verbosity;
      if (verbosity !== undefined) {
        unsupported(
          state,
          "output.verbosity",
          verbosity,
          "Chat Completions has no certified text verbosity control",
        );
      }

      const parallel = input.supplement.tools?.parallelCalls;
      if (parallel !== undefined) {
        payload.parallel_tool_calls = parallel.value;
        projected(state, "tools.parallelCalls");
      }
      const choice = input.supplement.tools?.choice;
      if (choice !== undefined) {
        const restriction = forcedToolChoiceRestriction(input.model, choice.value);
        if (restriction !== undefined) {
          unsupported(state, "tools.choice", choice, restriction);
        } else {
          const mapped = toChatCompletionsToolChoice(choice.value);
          if (mapped === undefined) {
            unsupported(state, "tools.choice", choice, "tool choice is not representable");
          } else {
            payload.tool_choice = mapped;
            projected(state, "tools.choice");
          }
        }
      }

      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        requireNativeNumber(
          state,
          "sampling.maxOutputTokens",
          sampling.maxOutputTokens,
          payload.max_completion_tokens ?? payload.max_tokens,
          "ceiling",
        );
      }
      if (sampling?.temperature !== undefined) {
        projectExactNumber(
          state,
          "sampling.temperature",
          sampling.temperature,
          payload.temperature,
          (value) => {
            payload.temperature = value;
          },
        );
      }
      if (sampling?.topP !== undefined) {
        projectExactNumber(
          state,
          "sampling.topP",
          sampling.topP,
          payload.top_p,
          (value) => {
            payload.top_p = value;
          },
        );
      }

      const cache = input.supplement.cache;
      if (cache?.key !== undefined) {
        payload.prompt_cache_key = cache.key.value;
        projected(state, "cache.key");
      }
      if (cache?.retention !== undefined) {
        payload.prompt_cache_retention = cache.retention.value;
        projected(state, "cache.retention");
      }
      const identity = input.supplement.identity;
      if (identity?.safetyIdentifier !== undefined) {
        payload.safety_identifier = identity.safetyIdentifier.value;
        projected(state, "identity.safetyIdentifier");
      }
      if (identity?.deprecatedUser !== undefined) {
        payload.user = identity.deprecatedUser.value;
        projected(state, "identity.deprecatedUser");
      }
      const lifecycle = input.supplement.lifecycle;
      if (lifecycle?.serviceTier !== undefined) {
        payload.service_tier = lifecycle.serviceTier.value;
        projected(state, "lifecycle.serviceTier");
      }
      if (lifecycle?.truncation !== undefined) {
        unsupported(
          state,
          "lifecycle.truncation",
          lifecycle.truncation,
          "Chat Completions has no Responses truncation control",
        );
      }
      return finish(state);
    },
  });
