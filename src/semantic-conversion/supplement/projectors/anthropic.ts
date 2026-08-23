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

function anthropicChoice(choice: SemanticToolChoice): Record<string, unknown> | undefined {
  if (choice.kind === "auto" || choice.kind === "none") return { type: choice.kind };
  if (choice.kind === "required") return { type: "any" };
  if (choice.kind === "named") return { type: "tool", name: choice.name };
  if (choice.kind === "allowed") {
    return { type: choice.mode === "required" ? "any" : "auto" };
  }
  return undefined;
}

export const anthropicMessagesSupplementProjector: SupplementProjector =
  Object.freeze({
    id: "anthropic-messages",
    api: "anthropic-messages",
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
          payload.output_config = {
            ...existing,
            format: { type: "json_schema", schema },
          };
          projected(state, "output.format");
        }
      }
      if (output?.verbosity !== undefined) {
        unsupported(
          state,
          "output.verbosity",
          output.verbosity,
          "Anthropic has no text verbosity control",
        );
      }

      const tools = input.supplement.tools;
      if (tools?.choice !== undefined || tools?.parallelCalls !== undefined) {
        const selected =
          tools.choice === undefined
            ? { type: "auto" }
            : anthropicChoice(tools.choice.value);
        if (selected === undefined) {
          if (tools.choice !== undefined) {
            unsupported(
              state,
              "tools.choice",
              tools.choice,
              "Anthropic cannot express the requested hosted tool choice",
            );
          }
        } else {
          if (tools.parallelCalls !== undefined) {
            selected.disable_parallel_tool_use = !tools.parallelCalls.value;
            projected(state, "tools.parallelCalls");
          }
          payload.tool_choice = selected;
          if (tools.choice !== undefined) projected(state, "tools.choice");
        }
      }

      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        if (input.reasoning.effort.kind === "enabled") {
          unsupported(
            state,
            "sampling.maxOutputTokens",
            sampling.maxOutputTokens,
            "Anthropic treats max_tokens as visible output in addition to its thinking budget",
          );
        } else {
          requireNativeNumber(
            state,
            "sampling.maxOutputTokens",
            sampling.maxOutputTokens,
            payload.max_tokens,
            "ceiling",
          );
        }
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
          payload.top_p,
          (value) => {
            payload.top_p = value;
          },
        );
      }

      const cache = input.supplement.cache;
      if (cache?.key !== undefined) {
        unsupported(
          state,
          "cache.key",
          cache.key,
          "Anthropic cache markers cannot preserve an exact prompt cache key",
        );
      }
      if (cache?.retention !== undefined) {
        unsupported(
          state,
          "cache.retention",
          cache.retention,
          cache.retention.value === "24h"
            ? "Anthropic long cache retention is one hour, not 24 hours"
            : "Anthropic cache-marker retention is only a best effort",
        );
      }
      const identity = input.supplement.identity;
      if (identity?.safetyIdentifier !== undefined) {
        payload.metadata = { user_id: identity.safetyIdentifier.value };
        projected(state, "identity.safetyIdentifier");
        if (identity.deprecatedUser !== undefined) {
          unsupported(
            state,
            "identity.deprecatedUser",
            identity.deprecatedUser,
            "safety_identifier takes precedence over deprecated user",
          );
        }
      } else if (identity?.deprecatedUser !== undefined) {
        payload.metadata = { user_id: identity.deprecatedUser.value };
        projected(state, "identity.deprecatedUser");
      }
      const lifecycle = input.supplement.lifecycle;
      if (lifecycle?.serviceTier !== undefined) {
        if (lifecycle.serviceTier.value === "auto") {
          payload.service_tier = "auto";
          projected(state, "lifecycle.serviceTier");
        } else {
          unsupported(
            state,
            "lifecycle.serviceTier",
            lifecycle.serviceTier,
            "Responses service tiers do not map to Anthropic standard_only",
          );
        }
      }
      if (lifecycle?.truncation !== undefined) {
        unsupported(
          state,
          "lifecycle.truncation",
          lifecycle.truncation,
          "Anthropic has no Responses truncation control",
        );
      }
      return finish(state);
    },
  });
