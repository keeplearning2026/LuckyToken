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

function googleChoice(choice: SemanticToolChoice): Record<string, unknown> | undefined {
  if (choice.kind === "auto") return { mode: "AUTO" };
  if (choice.kind === "none") return { mode: "NONE" };
  if (choice.kind === "required") return { mode: "ANY" };
  if (choice.kind === "named") {
    return { mode: "ANY", allowedFunctionNames: [choice.name] };
  }
  if (choice.kind === "allowed") {
    const names = choice.tools.flatMap((tool) =>
      tool.toolType === "function" || tool.toolType === "custom"
        ? [tool.name]
        : [],
    );
    return names.length === choice.tools.length
      ? {
          mode: choice.mode === "required" ? "ANY" : "AUTO",
          allowedFunctionNames: names,
        }
      : undefined;
  }
  return undefined;
}

function adapter(api: "google-generative-ai" | "google-vertex"): SupplementProjector {
  return Object.freeze({
    id: api,
    api,
    project(input: SupplementProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["model", "string"],
        ["contents", "array"],
        ["config", "object"],
      ]);
      const state = createState(this.id, payload, input.supplement);
      handleUniversalResponseContracts(state);
      const config = { ...(payload.config as Record<string, unknown>) };
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        if (output.format.value.type === "text") {
          native(state, "output.format");
        } else {
          config.responseMimeType = "application/json";
          if (output.format.value.type === "json_schema") {
            config.responseJsonSchema = output.format.value.schema;
          }
          projected(state, "output.format");
        }
      }
      if (output?.verbosity !== undefined) {
        unsupported(
          state,
          "output.verbosity",
          output.verbosity,
          "Google has no text verbosity control",
        );
      }
      const tools = input.supplement.tools;
      if (tools?.parallelCalls !== undefined) {
        if (tools.parallelCalls.value) {
          unsupported(
            state,
            "tools.parallelCalls",
            tools.parallelCalls,
            "Google has no explicit parallel tool-call control",
          );
        } else {
          unsupported(
            state,
            "tools.parallelCalls",
            tools.parallelCalls,
            "Google cannot guarantee serial tool calls",
          );
        }
      }
      if (tools?.choice !== undefined) {
        const mapped = googleChoice(tools.choice.value);
        if (mapped === undefined) {
          unsupported(
            state,
            "tools.choice",
            tools.choice,
            "Google cannot express the requested hosted tool choice",
          );
        } else {
          config.toolConfig = { functionCallingConfig: mapped };
          projected(state, "tools.choice");
        }
      }
      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        requireNativeNumber(
          state,
          "sampling.maxOutputTokens",
          sampling.maxOutputTokens,
          config.maxOutputTokens,
          "ceiling",
        );
      }
      if (sampling?.temperature !== undefined) {
        projectExactNumber(
          state,
          "sampling.temperature",
          sampling.temperature,
          config.temperature,
          (value) => {
            config.temperature = value;
          },
        );
      }
      if (sampling?.topP !== undefined) {
        projectExactNumber(
          state,
          "sampling.topP",
          sampling.topP,
          config.topP,
          (value) => {
            config.topP = value;
          },
        );
      }
      payload.config = config;
      return finish(state);
    },
  });
}

export const googleGenerativeAISupplementProjector = adapter(
  "google-generative-ai",
);
export const googleVertexSupplementProjector = adapter("google-vertex");
