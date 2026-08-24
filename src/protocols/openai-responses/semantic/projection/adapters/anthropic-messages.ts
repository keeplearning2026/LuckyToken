import type { Model } from "@earendil-works/pi-ai";

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
  projectTargetValue,
  requirePayloadShape,
} from "./candidate-resolution.js";

function hasAnthropicCacheControl(value: unknown, ttl?: "1h"): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasAnthropicCacheControl(entry, ttl));
  }
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const cacheControl = record.cache_control;
  if (
    typeof cacheControl === "object" &&
    cacheControl !== null &&
    !Array.isArray(cacheControl)
  ) {
    const cache = cacheControl as Record<string, unknown>;
    if (
      cache.type === "ephemeral" &&
      (ttl === undefined ? cache.ttl === undefined : cache.ttl === ttl)
    ) {
      return true;
    }
  }
  return Object.values(record).some((entry) => hasAnthropicCacheControl(entry, ttl));
}

function anthropicChoice(choice: ResponsesToolChoice): Record<string, unknown> | undefined {
  if (choice.kind === "auto" || choice.kind === "none") return { type: choice.kind };
  if (choice.kind === "required") return { type: "any" };
  if (choice.kind === "named") return { type: "tool", name: choice.name };
  if (choice.kind === "allowed") {
    return { type: choice.mode === "required" ? "any" : "auto" };
  }
  return undefined;
}

export const responsesToAnthropicMessagesProjector: ResponsesTargetProjector =
  Object.freeze({
    id: "anthropic-messages",
    api: "anthropic-messages",
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
        if (output.format.value.type === "text") {
          native(state, "output.format");
        } else {
          const existing =
            typeof payload.output_config === "object" &&
            payload.output_config !== null &&
            !Array.isArray(payload.output_config)
              ? (payload.output_config as Record<string, unknown>)
              : {};
          const schema =
            output.format.value.type === "json_object"
              ? { type: "object" }
              : output.format.value.schema;
          const mapped = { type: "json_schema", schema };
          projectTargetValue(
            state,
            "output.format",
            existing.format,
            mapped,
            (value) => {
              payload.output_config = { ...existing, format: value };
            },
          );
        }
      }
      const tools = input.supplement.tools;
      if (tools?.choice !== undefined) {
        const mapped = anthropicChoice(tools.choice.value);
        if (mapped !== undefined) {
          const existing =
            typeof payload.tool_choice === "object" &&
            payload.tool_choice !== null &&
            !Array.isArray(payload.tool_choice)
              ? (payload.tool_choice as Record<string, unknown>)
              : undefined;
          const actual =
            existing === undefined
              ? undefined
              : {
                  type: existing.type,
                  ...(Object.hasOwn(mapped, "name") ? { name: existing.name } : {}),
                };
          projectTargetValue(state, "tools.choice", actual, mapped, (value) => {
            const next = { ...(existing ?? {}), ...value };
            if (!Object.hasOwn(value, "name")) delete next.name;
            payload.tool_choice = next;
          });
        }
      }
      if (tools?.parallelCalls !== undefined) {
        const existing =
          typeof payload.tool_choice === "object" &&
          payload.tool_choice !== null &&
          !Array.isArray(payload.tool_choice)
            ? (payload.tool_choice as Record<string, unknown>)
            : undefined;
        projectTargetValue(
          state,
          "tools.parallelCalls",
          existing?.disable_parallel_tool_use,
          !tools.parallelCalls.value,
          (value) => {
            payload.tool_choice = {
              ...(existing ?? { type: "auto" }),
              disable_parallel_tool_use: value,
            };
          },
        );
      }

      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        if (input.reasoning.effort.kind !== "enabled") {
          projectCeilingNumber(
            state,
            "sampling.maxOutputTokens",
            sampling.maxOutputTokens,
            payload.max_tokens,
            (value) => {
              payload.max_tokens = value;
            },
          );
        }
      }
      if (sampling?.temperature !== undefined) {
        const anthropicModel = input.model as Model<"anthropic-messages">;
        if (input.reasoning.effort.kind === "enabled") {
          delete payload.temperature;
        } else if (anthropicModel.compat?.supportsTemperature === false) {
          delete payload.temperature;
        } else {
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
      }
      if (sampling?.topP !== undefined) {
        projectExactNumber(
          state,
          "sampling.topP",
          sampling.topP,
          payload.top_p,
          (value) => {
            payload.top_p = value;
          },
        );
      }

      const cache = input.supplement.cache;
      if (cache?.retention !== undefined) {
        if (
          cache.retention.value === "24h" &&
          hasAnthropicCacheControl(payload, "1h")
        ) {
          degraded(
            state,
            "cache.retention",
            "cache-retention-24h-to-1h",
            "Anthropic applies a verified one hour cache fallback, not 24 hours",
          );
        } else if (
          cache.retention.value === "in_memory" &&
          hasAnthropicCacheControl(payload)
        ) {
          degraded(
            state,
            "cache.retention",
            "cache-retention-in-memory-to-provider-ephemeral",
            "Anthropic applies its verified provider-default ephemeral cache fallback",
          );
        }
      }
      const identity = input.supplement.identity;
      if (identity?.safetyIdentifier !== undefined) {
        const metadata =
          typeof payload.metadata === "object" &&
          payload.metadata !== null &&
          !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : {};
        projectTargetValue(
          state,
          "identity.safetyIdentifier",
          metadata.user_id,
          identity.safetyIdentifier.value,
          (value) => {
            payload.metadata = { ...metadata, user_id: value };
          },
        );
      } else if (identity?.deprecatedUser !== undefined) {
        const metadata =
          typeof payload.metadata === "object" &&
          payload.metadata !== null &&
          !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : {};
        projectTargetValue(
          state,
          "identity.deprecatedUser",
          metadata.user_id,
          identity.deprecatedUser.value,
          (value) => {
            payload.metadata = { ...metadata, user_id: value };
          },
        );
      }
      const lifecycle = input.supplement.lifecycle;
      if (lifecycle?.serviceTier !== undefined) {
        if (lifecycle.serviceTier.value === "auto") {
          projectTargetValue(
            state,
            "lifecycle.serviceTier",
            payload.service_tier,
            "auto",
            (value) => {
              payload.service_tier = value;
            },
          );
        }
      }
      return finish(state);
    },
  });
