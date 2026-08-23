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
  unsupported,
} from "./shared.js";

function piChoice(choice: SemanticToolChoice): unknown | undefined {
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

export const piMessagesSupplementProjector: SupplementProjector = Object.freeze({
  id: "pi-messages",
  api: "pi-messages",
  project(input: SupplementProjectionInput) {
    const payload = clonePayload(input.payload, input.model.api);
    requirePayloadShape(payload, input.model.api, [
      ["model", "string"],
      ["context", "object"],
      ["options", "object"],
    ]);
    const state = createState(this.id, payload, input.supplement);
    handleUniversalResponseContracts(state);
    const options = { ...(payload.options as Record<string, unknown>) };
    const output = input.supplement.output;
    if (output?.format !== undefined) {
      if (output.format.value.type === "text") native(state, "output.format");
      else {
        unsupported(
          state,
          "output.format",
          output.format,
          "Pi Messages has no structured-output field",
        );
      }
    }
    if (output?.verbosity !== undefined) {
      unsupported(
        state,
        "output.verbosity",
        output.verbosity,
        "Pi Messages has no text verbosity field",
      );
    }
    const tools = input.supplement.tools;
    if (tools?.parallelCalls !== undefined) {
      unsupported(
        state,
        "tools.parallelCalls",
        tools.parallelCalls,
        tools.parallelCalls.value
          ? "Pi Messages has no explicit parallel tool-call field"
          : "Pi Messages cannot guarantee serial tool calls",
      );
    }
    if (tools?.choice !== undefined) {
      const mapped = piChoice(tools.choice.value);
      if (mapped === undefined) {
        unsupported(
          state,
          "tools.choice",
          tools.choice,
          "Pi Messages cannot express the requested hosted tool choice",
        );
      } else {
        options.toolChoice = mapped;
        projected(state, "tools.choice");
      }
    }
    const sampling = input.supplement.sampling;
    if (sampling?.maxOutputTokens !== undefined) {
      requireNativeNumber(
        state,
        "sampling.maxOutputTokens",
        sampling.maxOutputTokens,
        options.maxTokens,
        "ceiling",
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
    if (sampling?.topP !== undefined) {
      unsupported(
        state,
        "sampling.topP",
        sampling.topP,
        "Pi Messages has no top-p field",
      );
    }
    const cache = input.supplement.cache;
    if (cache?.key !== undefined) {
      unsupported(
        state,
        "cache.key",
        cache.key,
        "Pi Messages carries a session ID but no exact prompt cache key",
      );
    }
    if (cache?.retention !== undefined) {
      const expected = cache.retention.value === "24h" ? "long" : "short";
      if (options.cacheRetention === expected) native(state, "cache.retention");
      else {
        unsupported(
          state,
          "cache.retention",
          cache.retention,
          "Pi Messages did not carry the equivalent cache-retention intent",
        );
      }
    }
    payload.options = options;
    return finish(state);
  },
});
