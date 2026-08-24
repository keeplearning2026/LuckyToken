import type {
  ResponsesTargetProjectionInput,
  ResponsesTargetProjector,
} from "./contract.js";
import { forcedToolChoiceRestriction } from "../certified-compatibility.js";
import {
  clonePayload,
  createState,
  finish,
  native,
  projectCeilingNumber,
  projectExactNumber,
  projectTargetValue,
  requirePayloadShape,
  toChatResponseFormat,
  toChatCompletionsToolChoice,
} from "./candidate-resolution.js";

export const responsesToOpenAICompletionsProjector: ResponsesTargetProjector =
  Object.freeze({
    id: "openai-completions",
    api: "openai-completions",
    project(input: ResponsesTargetProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["model", "string"],
        ["messages", "array"],
        ["stream", "true"],
      ]);
      const state = createState(this.id, payload, input.supplement);

      const format = input.supplement.output?.format;
      if (format !== undefined) {
        const mapped = toChatResponseFormat(format.value);
        if (mapped === undefined) {
          native(state, "output.format");
        } else {
          projectTargetValue(
            state,
            "output.format",
            payload.response_format,
            mapped,
            (value) => {
              payload.response_format = value;
            },
          );
        }
      }
      const parallel = input.supplement.tools?.parallelCalls;
      if (parallel !== undefined) {
        projectTargetValue(
          state,
          "tools.parallelCalls",
          payload.parallel_tool_calls,
          parallel.value,
          (value) => {
            payload.parallel_tool_calls = value;
          },
        );
      }
      const choice = input.supplement.tools?.choice;
      if (choice !== undefined) {
        const restriction = forcedToolChoiceRestriction(input.model, choice.value);
        if (restriction === undefined) {
          const mapped = toChatCompletionsToolChoice(choice.value);
          if (mapped !== undefined) {
            projectTargetValue(
              state,
              "tools.choice",
              payload.tool_choice,
              mapped,
              (value) => {
                payload.tool_choice = value;
              },
            );
          }
        }
      }

      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        const compat = (input.model as unknown as {
          readonly compat?: {
            readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
          };
        }).compat;
        const maxTokensField =
          payload.max_completion_tokens !== undefined
            ? "max_completion_tokens"
            : payload.max_tokens !== undefined
              ? "max_tokens"
              : compat?.maxTokensField === "max_tokens"
                ? "max_tokens"
                : "max_completion_tokens";
        projectCeilingNumber(
          state,
          "sampling.maxOutputTokens",
          sampling.maxOutputTokens,
          payload[maxTokensField],
          (value) => {
            payload[maxTokensField] = value;
          },
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
        projectTargetValue(
          state,
          "cache.key",
          payload.prompt_cache_key,
          cache.key.value,
          (value) => {
            payload.prompt_cache_key = value;
          },
        );
      }
      if (cache?.retention !== undefined) {
        projectTargetValue(
          state,
          "cache.retention",
          payload.prompt_cache_retention,
          cache.retention.value,
          (value) => {
            payload.prompt_cache_retention = value;
          },
        );
      }
      const identity = input.supplement.identity;
      if (identity?.safetyIdentifier !== undefined) {
        projectTargetValue(
          state,
          "identity.safetyIdentifier",
          payload.safety_identifier,
          identity.safetyIdentifier.value,
          (value) => {
            payload.safety_identifier = value;
          },
        );
      }
      if (identity?.deprecatedUser !== undefined) {
        projectTargetValue(
          state,
          "identity.deprecatedUser",
          payload.user,
          identity.deprecatedUser.value,
          (value) => {
            payload.user = value;
          },
        );
      }
      const lifecycle = input.supplement.lifecycle;
      if (lifecycle?.serviceTier !== undefined) {
        projectTargetValue(
          state,
          "lifecycle.serviceTier",
          payload.service_tier,
          lifecycle.serviceTier.value,
          (value) => {
            payload.service_tier = value;
          },
        );
      }
      return finish(state);
    },
  });
