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
} from "./candidate-resolution.js";
import { InvalidResponsesProjection } from "./contract.js";

export const responsesToCommandCodePrivateProjector: ResponsesTargetProjector =
  Object.freeze({
    id: "commandcode-private",
    api: "commandcode-private",
    project(input: ResponsesTargetProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      if (
        typeof payload.params !== "object" ||
        payload.params === null ||
        Array.isArray(payload.params)
      ) {
        throw new InvalidResponsesProjection(
          "commandcode-private payload shape mismatch at params",
        );
      }
      const state = createState(this.id, payload, input.supplement);
      const params = { ...(payload.params as Record<string, unknown>) };
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        if (output.format.value.type === "text") native(state, "output.format");
      }
      const tools = input.supplement.tools;
      if (tools?.choice !== undefined) {
        const choice = tools.choice.value;
        if (choice.kind === "auto") {
          native(state, "tools.choice");
        } else if (choice.kind === "none") {
          if (Array.isArray(params.tools) && params.tools.length === 0) {
            native(state, "tools.choice");
          }
        } else if (choice.kind === "allowed" && choice.mode === "auto") {
          const allowedNames = new Set(
            choice.tools.flatMap((tool) => {
              if (tool.toolType === "function" || tool.toolType === "custom") {
                return [tool.name];
              }
              if (tool.toolType === "apply_patch" || tool.toolType === "shell") {
                return [tool.toolType];
              }
              if (tool.toolType === "mcp") {
                return tool.name === undefined ? [] : [tool.name];
              }
              return [];
            }),
          );
          const finalTools = Array.isArray(params.tools) ? params.tools : [];
          const finalNames = finalTools.map((tool) =>
            typeof tool === "object" && tool !== null && !Array.isArray(tool)
              ? (tool as Record<string, unknown>).name
              : undefined,
          );
          if (
            finalNames.every(
              (name) => typeof name === "string" && allowedNames.has(name),
            )
          ) {
            native(state, "tools.choice");
          }
        }
      }
      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        projectCeilingNumber(
          state,
          "sampling.maxOutputTokens",
          sampling.maxOutputTokens,
          params.max_tokens,
          (value) => {
            params.max_tokens = value;
          },
        );
      }
      if (sampling?.temperature !== undefined) {
        projectExactNumber(
          state,
          "sampling.temperature",
          sampling.temperature,
          params.temperature,
          (value) => {
            params.temperature = value;
          },
        );
      }
      payload.params = params;
      return finish(state);
    },
  });
