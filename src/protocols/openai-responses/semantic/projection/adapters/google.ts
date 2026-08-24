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

function googleChoice(choice: ResponsesToolChoice): Record<string, unknown> | undefined {
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

function adapter(api: "google-generative-ai" | "google-vertex"): ResponsesTargetProjector {
  return Object.freeze({
    id: api,
    api,
    project(input: ResponsesTargetProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["model", "string"],
        ["contents", "array"],
        ["config", "object"],
      ]);
      const state = createState(this.id, payload, input.supplement);
      const config = { ...(payload.config as Record<string, unknown>) };
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        if (output.format.value.type === "text") {
          native(state, "output.format");
        } else {
          const expected = {
            responseMimeType: "application/json",
            ...(output.format.value.type === "json_schema"
              ? { responseJsonSchema: output.format.value.schema }
              : {}),
          };
          const actual =
            config.responseMimeType === undefined &&
            config.responseJsonSchema === undefined
              ? undefined
              : {
                  responseMimeType: config.responseMimeType,
                  ...(config.responseJsonSchema === undefined
                    ? {}
                    : { responseJsonSchema: config.responseJsonSchema }),
                };
          projectTargetValue(state, "output.format", actual, expected, (value) => {
            config.responseMimeType = value.responseMimeType;
            if ("responseJsonSchema" in value) {
              config.responseJsonSchema = value.responseJsonSchema;
            } else {
              delete config.responseJsonSchema;
            }
          });
        }
      }
      const tools = input.supplement.tools;
      if (tools?.choice !== undefined) {
        const mapped = googleChoice(tools.choice.value);
        if (mapped !== undefined) {
          const toolConfig =
            typeof config.toolConfig === "object" &&
            config.toolConfig !== null &&
            !Array.isArray(config.toolConfig)
              ? (config.toolConfig as Record<string, unknown>)
              : {};
          projectTargetValue(
            state,
            "tools.choice",
            toolConfig.functionCallingConfig,
            mapped,
            (value) => {
              config.toolConfig = { ...toolConfig, functionCallingConfig: value };
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
          config.maxOutputTokens,
          (value) => {
            config.maxOutputTokens = value;
          },
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

export const responsesToGoogleGenerativeAIProjector = adapter(
  "google-generative-ai",
);
export const responsesToGoogleVertexProjector = adapter("google-vertex");
