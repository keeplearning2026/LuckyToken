import type { SemanticToolChoice } from "../contract.js";
import type {
  SupplementProjectionInput,
  SupplementProjector,
} from "./contract.js";
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
  unsupported,
} from "./shared.js";

function mistralChoice(choice: SemanticToolChoice): unknown | undefined {
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

export const mistralConversationsSupplementProjector: SupplementProjector =
  Object.freeze({
    id: "mistral-conversations",
    api: "mistral-conversations",
    project(input: SupplementProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["model", "string"],
        ["messages", "array"],
        ["stream", "true"],
      ]);
      const state = createState(this.id, payload, input.supplement);
      handleUniversalResponseContracts(state);
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        const mapped = toChatResponseFormat(output.format.value);
        if (mapped === undefined) native(state, "output.format");
        else {
          payload.responseFormat = mapped;
          projected(state, "output.format");
        }
      }
      if (output?.verbosity !== undefined) {
        unsupported(
          state,
          "output.verbosity",
          output.verbosity,
          "Mistral has no text verbosity control",
        );
      }
      const tools = input.supplement.tools;
      if (tools?.parallelCalls !== undefined) {
        payload.parallelToolCalls = tools.parallelCalls.value;
        projected(state, "tools.parallelCalls");
      }
      if (tools?.choice !== undefined) {
        const mapped = mistralChoice(tools.choice.value);
        if (mapped === undefined) {
          unsupported(
            state,
            "tools.choice",
            tools.choice,
            "Mistral cannot express the requested hosted tool choice",
          );
        } else {
          payload.toolChoice = mapped;
          projected(state, "tools.choice");
        }
      }
      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        requireNativeNumber(
          state,
          "sampling.maxOutputTokens",
          sampling.maxOutputTokens,
          payload.maxTokens,
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
          payload.topP,
          (value) => {
            payload.topP = value;
          },
        );
      }
      const cache = input.supplement.cache;
      if (cache?.key !== undefined) {
        payload.promptCacheKey = cache.key.value;
        projected(state, "cache.key");
      }
      if (cache?.retention !== undefined) {
        unsupported(
          state,
          "cache.retention",
          cache.retention,
          "Mistral prompt-cache retention duration is not explicit on the wire",
        );
      }
      return finish(state);
    },
  });
