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
} from "./candidate-resolution.js";

function piChoice(choice: ResponsesToolChoice): unknown | undefined {
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

export const responsesToPiMessagesProjector: ResponsesTargetProjector = Object.freeze({
  id: "pi-messages",
  api: "pi-messages",
  project(input: ResponsesTargetProjectionInput) {
    const payload = clonePayload(input.payload, input.model.api);
    requirePayloadShape(payload, input.model.api, [
      ["model", "string"],
      ["context", "object"],
      ["options", "object"],
    ]);
    const state = createState(this.id, payload, input.supplement);
    const options = { ...(payload.options as Record<string, unknown>) };
    const output = input.supplement.output;
    if (output?.format !== undefined) {
      if (output.format.value.type === "text") native(state, "output.format");
    }
    const tools = input.supplement.tools;
    if (tools?.choice !== undefined) {
      const mapped = piChoice(tools.choice.value);
      if (mapped !== undefined) {
        projectTargetValue(
          state,
          "tools.choice",
          options.toolChoice,
          mapped,
          (value) => {
            options.toolChoice = value;
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
        options.maxTokens,
        (value) => {
          options.maxTokens = value;
        },
      );
    }
    if (sampling?.temperature !== undefined) {
      projectExactNumber(
        state,
        "sampling.temperature",
        sampling.temperature,
        options.temperature,
        (value) => {
          options.temperature = value;
        },
      );
    }
    const cache = input.supplement.cache;
    if (cache?.retention !== undefined) {
      const expected = cache.retention.value === "24h" ? "long" : "short";
      if (options.cacheRetention === expected) native(state, "cache.retention");
    }
    payload.options = options;
    return finish(state);
  },
});
