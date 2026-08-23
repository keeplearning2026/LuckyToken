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

function bedrockChoice(choice: SemanticToolChoice): Record<string, unknown> | undefined {
  if (choice.kind === "auto") return { auto: {} };
  if (choice.kind === "required") return { any: {} };
  if (choice.kind === "named") return { tool: { name: choice.name } };
  if (choice.kind === "allowed") {
    return choice.mode === "required" ? { any: {} } : { auto: {} };
  }
  return undefined;
}

export const bedrockConverseSupplementProjector: SupplementProjector =
  Object.freeze({
    id: "bedrock-converse-stream",
    api: "bedrock-converse-stream",
    project(input: SupplementProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["modelId", "string"],
        ["messages", "array"],
        ["inferenceConfig", "object"],
      ]);
      const state = createState(this.id, payload, input.supplement);
      handleUniversalResponseContracts(state);
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        if (output.format.value.type === "text") native(state, "output.format");
        else {
          unsupported(
            state,
            "output.format",
            output.format,
            "Bedrock Converse has no generic structured-output contract",
          );
        }
      }
      if (output?.verbosity !== undefined) {
        unsupported(
          state,
          "output.verbosity",
          output.verbosity,
          "Bedrock Converse has no text verbosity control",
        );
      }
      const tools = input.supplement.tools;
      if (tools?.parallelCalls !== undefined) {
        unsupported(
          state,
          "tools.parallelCalls",
          tools.parallelCalls,
          tools.parallelCalls.value
            ? "Bedrock has no explicit parallel tool-call control"
            : "Bedrock cannot guarantee serial tool calls",
        );
      }
      if (tools?.choice !== undefined) {
        if (tools.choice.value.kind === "none") {
          delete payload.toolConfig;
          projected(state, "tools.choice");
        } else {
          const mapped = bedrockChoice(tools.choice.value);
          const toolConfig = payload.toolConfig;
          if (
            mapped === undefined ||
            typeof toolConfig !== "object" ||
            toolConfig === null ||
            Array.isArray(toolConfig)
          ) {
            unsupported(
              state,
              "tools.choice",
              tools.choice,
              "Bedrock tool choice requires a compatible non-empty tool catalog",
            );
          } else {
            payload.toolConfig = {
              ...(toolConfig as Record<string, unknown>),
              toolChoice: mapped,
            };
            projected(state, "tools.choice");
          }
        }
      }
      const inference = {
        ...(payload.inferenceConfig as Record<string, unknown>),
      };
      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        if (input.reasoning.effort.kind === "enabled") {
          unsupported(
            state,
            "sampling.maxOutputTokens",
            sampling.maxOutputTokens,
            "Bedrock Claude adds a thinking budget outside the visible maxTokens ceiling",
          );
        } else {
          requireNativeNumber(
            state,
            "sampling.maxOutputTokens",
            sampling.maxOutputTokens,
            inference.maxTokens,
            "ceiling",
          );
        }
      }
      if (sampling?.temperature !== undefined) {
        projectExactNumber(
          state,
          "sampling.temperature",
          sampling.temperature,
          inference.temperature,
          (value) => {
            inference.temperature = value;
          },
        );
      }
      if (sampling?.topP !== undefined) {
        projectExactNumber(
          state,
          "sampling.topP",
          sampling.topP,
          inference.topP,
          (value) => {
            inference.topP = value;
          },
        );
      }
      payload.inferenceConfig = inference;
      const cache = input.supplement.cache;
      if (cache?.key !== undefined) {
        unsupported(
          state,
          "cache.key",
          cache.key,
          "Bedrock cache points cannot preserve an exact prompt cache key",
        );
      }
      if (cache?.retention !== undefined) {
        unsupported(
          state,
          "cache.retention",
          cache.retention,
          cache.retention.value === "24h"
            ? "Bedrock long cache retention is one hour, not 24 hours"
            : "Bedrock cache-point retention is only a best effort",
        );
      }
      return finish(state);
    },
  });
