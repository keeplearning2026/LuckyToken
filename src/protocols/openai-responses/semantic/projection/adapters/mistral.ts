import type { ResponsesToolChoice } from "../../supplement/contract.js";
import type {
  ResponsesTargetProjectionInput,
  ResponsesTargetProjector,
} from "./contract.js";
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
} from "./candidate-resolution.js";

function mistralChoice(choice: ResponsesToolChoice): unknown | undefined {
  if (
    choice.kind === "auto" ||
    choice.kind === "none" ||
    choice.kind === "required"
  ) {
    return choice.kind;
  }
  if (choice.kind === "named") {
    return { type: "function", function: { name: choice.name } };
  }
  if (choice.kind === "allowed") return choice.mode;
  return undefined;
}

export const responsesToMistralConversationsProjector: ResponsesTargetProjector =
  Object.freeze({
    id: "mistral-conversations",
    api: "mistral-conversations",
    project(input: ResponsesTargetProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["model", "string"],
        ["messages", "array"],
        ["stream", "true"],
      ]);
      const state = createState(this.id, payload, input.supplement);
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        const mapped = toChatResponseFormat(output.format.value);
        if (mapped === undefined) native(state, "output.format");
        else {
          projectTargetValue(
            state,
            "output.format",
            payload.responseFormat,
            mapped,
            (value) => {
              payload.responseFormat = value;
            },
          );
        }
      }
      const tools = input.supplement.tools;
      if (tools?.parallelCalls !== undefined) {
        projectTargetValue(
          state,
          "tools.parallelCalls",
          payload.parallelToolCalls,
          tools.parallelCalls.value,
          (value) => {
            payload.parallelToolCalls = value;
          },
        );
      }
      if (tools?.choice !== undefined) {
        const mapped = mistralChoice(tools.choice.value);
        if (mapped !== undefined) {
          projectTargetValue(
            state,
            "tools.choice",
            payload.toolChoice,
            mapped,
            (value) => {
              payload.toolChoice = value;
            },
          );
        }
      }
      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        projectCeilingNumber(
          state,
          "sampling.maxOutputTokens",
          sampling.maxOutputTokens,
          payload.maxTokens,
          (value) => {
            payload.maxTokens = value;
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
          payload.topP,
          (value) => {
            payload.topP = value;
          },
        );
      }
      const cache = input.supplement.cache;
      if (cache?.key !== undefined) {
        projectTargetValue(
          state,
          "cache.key",
          payload.promptCacheKey,
          cache.key.value,
          (value) => {
            payload.promptCacheKey = value;
          },
        );
      }
      return finish(state);
    },
  });
