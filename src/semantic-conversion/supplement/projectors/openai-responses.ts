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
  toResponsesToolChoice,
  unsupported,
} from "./shared.js";

function projectResponses(input: SupplementProjectionInput) {
  const payload = clonePayload(input.payload, input.model.api);
  requirePayloadShape(payload, input.model.api, [
    ["model", "string"],
    ["input", "array"],
    ["stream", "true"],
  ]);
  const state = createState(input.model.api, payload, input.supplement);
  handleUniversalResponseContracts(state);
  const output = input.supplement.output;
  if (output?.format !== undefined || output?.verbosity !== undefined) {
    const text =
      typeof payload.text === "object" &&
      payload.text !== null &&
      !Array.isArray(payload.text)
        ? { ...(payload.text as Record<string, unknown>) }
        : {};
    if (output.format !== undefined) {
      text.format = output.format.value;
      projected(state, "output.format");
    }
    if (output.verbosity !== undefined) {
      text.verbosity = output.verbosity.value;
      projected(state, "output.verbosity");
    }
    payload.text = text;
  }
  if (
    output?.include !== undefined &&
    !state.handled.has("output.include")
  ) {
    const values = output.include.value;
    if (values.every((value) => value === "reasoning.encrypted_content")) {
      payload.include = [...values];
      projected(state, "output.include");
    }
  }

  const tools = input.supplement.tools;
  if (tools?.parallelCalls !== undefined) {
    payload.parallel_tool_calls = tools.parallelCalls.value;
    projected(state, "tools.parallelCalls");
  }
  if (tools?.choice !== undefined) {
    const mapped = toResponsesToolChoice(tools.choice.value);
    if (mapped === undefined) {
      unsupported(state, "tools.choice", tools.choice, "tool choice is not representable");
    } else {
      payload.tool_choice = mapped;
      projected(state, "tools.choice");
    }
  }

  const sampling = input.supplement.sampling;
  if (sampling?.maxOutputTokens !== undefined) {
    requireNativeNumber(
      state,
      "sampling.maxOutputTokens",
      sampling.maxOutputTokens,
      payload.max_output_tokens,
      "ceiling",
    );
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
    payload.prompt_cache_key = cache.key.value;
    projected(state, "cache.key");
  }
  if (cache?.retention !== undefined) {
    payload.prompt_cache_retention = cache.retention.value;
    projected(state, "cache.retention");
  }
  const identity = input.supplement.identity;
  if (identity?.safetyIdentifier !== undefined) {
    payload.safety_identifier = identity.safetyIdentifier.value;
    projected(state, "identity.safetyIdentifier");
  }
  if (identity?.deprecatedUser !== undefined) {
    payload.user = identity.deprecatedUser.value;
    projected(state, "identity.deprecatedUser");
  }
  const lifecycle = input.supplement.lifecycle;
  if (lifecycle?.serviceTier !== undefined) {
    payload.service_tier = lifecycle.serviceTier.value;
    projected(state, "lifecycle.serviceTier");
  }
  if (lifecycle?.truncation !== undefined) {
    payload.truncation = lifecycle.truncation.value;
    projected(state, "lifecycle.truncation");
  }
  return finish(state);
}

function adapter(api: "openai-responses" | "azure-openai-responses"): SupplementProjector {
  return Object.freeze({ id: api, api, project: projectResponses });
}

export const openAIResponsesSupplementProjector = adapter("openai-responses");
export const azureOpenAIResponsesSupplementProjector = adapter(
  "azure-openai-responses",
);

export const openAICodexResponsesSupplementProjector: SupplementProjector =
  Object.freeze({
    id: "openai-codex-responses",
    api: "openai-codex-responses",
    project(input: SupplementProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["model", "string"],
        ["input", "array"],
        ["stream", "true"],
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
            "Codex Responses has no certified structured-output field",
          );
        }
      }
      if (output?.verbosity !== undefined) {
        const text = payload.text as Record<string, unknown> | undefined;
        if (text?.verbosity === output.verbosity.value) {
          native(state, "output.verbosity");
        } else {
          payload.text = { ...(text ?? {}), verbosity: output.verbosity.value };
          projected(state, "output.verbosity");
        }
      }
      if (output?.include !== undefined && !state.handled.has("output.include")) {
        if (
          output.include.value.every(
            (value: string) => value === "reasoning.encrypted_content",
          )
        ) {
          payload.include = [...output.include.value];
          projected(state, "output.include");
        }
      }
      const tools = input.supplement.tools;
      if (tools?.parallelCalls !== undefined) {
        if (tools.parallelCalls.value) native(state, "tools.parallelCalls");
        else {
          unsupported(
            state,
            "tools.parallelCalls",
            tools.parallelCalls,
            "Codex Responses requires parallel_tool_calls=true",
          );
        }
      }
      if (tools?.choice !== undefined) {
        const choice = tools.choice.value;
        const mapped =
          choice.kind === "allowed" ? choice.mode : choice.kind === "named" ? undefined : choice.kind;
        if (mapped === "auto" || mapped === "none" || mapped === "required") {
          payload.tool_choice = mapped;
          projected(state, "tools.choice");
        } else {
          unsupported(
            state,
            "tools.choice",
            tools.choice,
            "Codex Responses has no certified named or hosted tool-choice field",
          );
        }
      }
      const sampling = input.supplement.sampling;
      if (sampling?.maxOutputTokens !== undefined) {
        unsupported(
          state,
          "sampling.maxOutputTokens",
          sampling.maxOutputTokens,
          "Codex Responses does not accept max_output_tokens",
        );
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
        unsupported(
          state,
          "sampling.topP",
          sampling.topP,
          "Codex Responses has no certified top_p control",
        );
      }
      const cache = input.supplement.cache;
      if (cache?.key !== undefined) {
        payload.prompt_cache_key = cache.key.value;
        projected(state, "cache.key");
      }
      if (cache?.retention !== undefined) {
        unsupported(
          state,
          "cache.retention",
          cache.retention,
          "Codex Responses has no certified prompt-cache retention field",
        );
      }
      const identity = input.supplement.identity;
      if (identity?.safetyIdentifier !== undefined) {
        unsupported(
          state,
          "identity.safetyIdentifier",
          identity.safetyIdentifier,
          "Codex Responses has no certified safety identifier field",
        );
      }
      if (identity?.deprecatedUser !== undefined) {
        unsupported(
          state,
          "identity.deprecatedUser",
          identity.deprecatedUser,
          "Codex Responses has no certified user field",
        );
      }
      const lifecycle = input.supplement.lifecycle;
      if (lifecycle?.serviceTier !== undefined) {
        payload.service_tier = lifecycle.serviceTier.value;
        projected(state, "lifecycle.serviceTier");
      }
      if (lifecycle?.truncation !== undefined) {
        unsupported(
          state,
          "lifecycle.truncation",
          lifecycle.truncation,
          "Codex Responses has no certified truncation control",
        );
      }
      return finish(state);
    },
  });
