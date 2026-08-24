import type { ResponsesToolChoice } from "../../supplement/contract.js";
import type {
  ResponsesTargetProjectionInput,
  ResponsesTargetProjector,
} from "./contract.js";
import {
  clonePayload,
  createState,
  degraded,
  finish,
  native,
  projectCeilingNumber,
  projectExactNumber,
  projectTargetAbsence,
  projectTargetValue,
  requirePayloadShape,
} from "./candidate-resolution.js";

function hasBedrockCachePoint(value: unknown, ttl?: "1h"): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasBedrockCachePoint(entry, ttl));
  }
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const cachePoint = record.cachePoint;
  if (
    typeof cachePoint === "object" &&
    cachePoint !== null &&
    !Array.isArray(cachePoint)
  ) {
    const cache = cachePoint as Record<string, unknown>;
    if (
      cache.type === "default" &&
      (ttl === undefined ? cache.ttl === undefined : cache.ttl === ttl)
    ) {
      return true;
    }
  }
  return Object.values(record).some((entry) => hasBedrockCachePoint(entry, ttl));
}

function bedrockChoice(choice: ResponsesToolChoice): Record<string, unknown> | undefined {
  if (choice.kind === "auto") return { auto: {} };
  if (choice.kind === "required") return { any: {} };
  if (choice.kind === "named") return { tool: { name: choice.name } };
  if (choice.kind === "allowed") {
    return choice.mode === "required" ? { any: {} } : { auto: {} };
  }
  return undefined;
}

export const responsesToBedrockConverseProjector: ResponsesTargetProjector =
  Object.freeze({
    id: "bedrock-converse-stream",
    api: "bedrock-converse-stream",
    project(input: ResponsesTargetProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["modelId", "string"],
        ["messages", "array"],
        ["inferenceConfig", "object"],
      ]);
      const state = createState(this.id, payload, input.supplement);
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        if (output.format.value.type === "text") native(state, "output.format");
      }
      const tools = input.supplement.tools;
      if (tools?.choice !== undefined) {
        if (tools.choice.value.kind === "none") {
          projectTargetAbsence(
            state,
            "tools.choice",
            payload.toolConfig,
            () => {
              delete payload.toolConfig;
            },
          );
        } else {
          const mapped = bedrockChoice(tools.choice.value);
          const toolConfig = payload.toolConfig;
          if (
            mapped !== undefined &&
            typeof toolConfig === "object" &&
            toolConfig !== null &&
            !Array.isArray(toolConfig)
          ) {
            const existing = toolConfig as Record<string, unknown>;
            projectTargetValue(
              state,
              "tools.choice",
              existing.toolChoice,
              mapped,
              (value) => {
                payload.toolConfig = { ...existing, toolChoice: value };
              },
            );
          }
        }
      }
      const inference = {
        ...(payload.inferenceConfig as Record<string, unknown>),
      };
      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        if (input.reasoning.effort.kind !== "enabled") {
          projectCeilingNumber(
            state,
            "sampling.maxOutputTokens",
            sampling.maxOutputTokens,
            inference.maxTokens,
            (value) => {
              inference.maxTokens = value;
            },
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
      if (cache?.retention !== undefined) {
        if (
          cache.retention.value === "24h" &&
          hasBedrockCachePoint(payload, "1h")
        ) {
          degraded(
            state,
            "cache.retention",
            "cache-retention-24h-to-1h",
            "Bedrock applies a verified one hour cache fallback, not 24 hours",
          );
        } else if (
          cache.retention.value === "in_memory" &&
          hasBedrockCachePoint(payload)
        ) {
          degraded(
            state,
            "cache.retention",
            "cache-retention-in-memory-to-provider-ephemeral",
            "Bedrock applies its verified provider-default ephemeral cache fallback",
          );
        }
      }
      return finish(state);
    },
  });
