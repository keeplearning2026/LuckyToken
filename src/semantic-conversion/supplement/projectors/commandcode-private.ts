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
  requireNativeNumber,
  unsupported,
} from "./shared.js";
import { InvalidSupplementProjection } from "./contract.js";

export const commandCodePrivateSupplementProjector: SupplementProjector =
  Object.freeze({
    id: "commandcode-private",
    api: "commandcode-private",
    project(input: SupplementProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      if (
        typeof payload.params !== "object" ||
        payload.params === null ||
        Array.isArray(payload.params)
      ) {
        throw new InvalidSupplementProjection(
          "commandcode-private payload shape mismatch at params",
        );
      }
      const state = createState(this.id, payload, input.supplement);
      handleUniversalResponseContracts(state);
      const params = { ...(payload.params as Record<string, unknown>) };
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        if (output.format.value.type === "text") native(state, "output.format");
        else {
          unsupported(
            state,
            "output.format",
            output.format,
            "CommandCode Private has no structured-output field",
          );
        }
      }
      if (output?.verbosity !== undefined) {
        unsupported(
          state,
          "output.verbosity",
          output.verbosity,
          "CommandCode Private has no text verbosity field",
        );
      }
      const tools = input.supplement.tools;
      if (tools?.parallelCalls !== undefined) {
        unsupported(
          state,
          "tools.parallelCalls",
          tools.parallelCalls,
          tools.parallelCalls.value
            ? "CommandCode Private has no explicit parallel tool-call field"
            : "CommandCode Private cannot guarantee serial tool calls",
        );
      }
      if (tools?.choice !== undefined) {
        const choice = tools.choice.value;
        if (choice.kind === "auto") {
          native(state, "tools.choice");
        } else if (choice.kind === "none") {
          if (Array.isArray(params.tools) && params.tools.length === 0) {
            native(state, "tools.choice");
          } else {
            unsupported(
              state,
              "tools.choice",
              tools.choice,
              "Pi did not remove the CommandCode tool catalog for tool_choice none",
            );
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
          } else {
            unsupported(
              state,
              "tools.choice",
              tools.choice,
              "Pi emitted a tool outside the allowed_tools filter",
            );
          }
        } else {
          unsupported(
            state,
            "tools.choice",
            tools.choice,
            "CommandCode Private has no tool-choice wire field",
          );
        }
      }
      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        requireNativeNumber(
          state,
          "sampling.maxOutputTokens",
          sampling.maxOutputTokens,
          params.max_tokens,
          "ceiling",
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
      if (sampling?.topP !== undefined) {
        unsupported(
          state,
          "sampling.topP",
          sampling.topP,
          "CommandCode Private has no top-p field",
        );
      }
      payload.params = params;
      return finish(state);
    },
  });
