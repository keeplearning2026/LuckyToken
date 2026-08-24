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
  toResponsesToolChoice,
} from "./candidate-resolution.js";

function projectResponses(input: ResponsesTargetProjectionInput) {
  const payload = clonePayload(input.payload, input.model.api);
  requirePayloadShape(payload, input.model.api, [
    ["model", "string"],
    ["input", "array"],
    ["stream", "true"],
  ]);
  const state = createState(input.model.api, payload, input.supplement);
  const output = input.supplement.output;
  if (output?.format !== undefined || output?.verbosity !== undefined) {
    const text =
      typeof payload.text === "object" &&
      payload.text !== null &&
      !Array.isArray(payload.text)
        ? { ...(payload.text as Record<string, unknown>) }
        : {};
    if (output.format !== undefined) {
      projectTargetValue(
        state,
        "output.format",
        text.format,
        output.format.value,
        (value) => {
          text.format = value;
          payload.text = text;
        },
      );
    }
    if (output.verbosity !== undefined) {
      projectTargetValue(
        state,
        "output.verbosity",
        text.verbosity,
        output.verbosity.value,
        (value) => {
          text.verbosity = value;
          payload.text = text;
        },
      );
    }
  }
  if (
    output?.include !== undefined &&
    !state.handled.has("output.include")
  ) {
    const values = output.include.value;
    if (values.every((value) => value === "reasoning.encrypted_content")) {
      projectTargetValue(
        state,
        "output.include",
        payload.include,
        [...values],
        (value) => {
          payload.include = value;
        },
      );
    }
  }

  const tools = input.supplement.tools;
  if (tools?.parallelCalls !== undefined) {
    projectTargetValue(
      state,
      "tools.parallelCalls",
      payload.parallel_tool_calls,
      tools.parallelCalls.value,
      (value) => {
        payload.parallel_tool_calls = value;
      },
    );
  }
  if (tools?.choice !== undefined) {
    const mapped = toResponsesToolChoice(tools.choice.value);
    if (mapped !== undefined) {
      projectTargetValue(
        state,
        "tools.choice",
        payload.tool_choice,
        mapped,
        (value) => {
          payload.tool_choice = value;
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
      payload.max_output_tokens,
      (value) => {
        payload.max_output_tokens = value;
      },
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
    projectTargetValue(
      state,
      "cache.key",
      payload.prompt_cache_key,
      cache.key.value,
      (value) => {
        payload.prompt_cache_key = value;
      },
    );
  }
  if (cache?.retention !== undefined) {
    projectTargetValue(
      state,
      "cache.retention",
      payload.prompt_cache_retention,
      cache.retention.value,
      (value) => {
        payload.prompt_cache_retention = value;
      },
    );
  }
  const identity = input.supplement.identity;
  if (identity?.safetyIdentifier !== undefined) {
    projectTargetValue(
      state,
      "identity.safetyIdentifier",
      payload.safety_identifier,
      identity.safetyIdentifier.value,
      (value) => {
        payload.safety_identifier = value;
      },
    );
  }
  if (identity?.deprecatedUser !== undefined) {
    projectTargetValue(
      state,
      "identity.deprecatedUser",
      payload.user,
      identity.deprecatedUser.value,
      (value) => {
        payload.user = value;
      },
    );
  }
  const lifecycle = input.supplement.lifecycle;
  if (lifecycle?.serviceTier !== undefined) {
    projectTargetValue(
      state,
      "lifecycle.serviceTier",
      payload.service_tier,
      lifecycle.serviceTier.value,
      (value) => {
        payload.service_tier = value;
      },
    );
  }
  if (lifecycle?.truncation !== undefined) {
    projectTargetValue(
      state,
      "lifecycle.truncation",
      payload.truncation,
      lifecycle.truncation.value,
      (value) => {
        payload.truncation = value;
      },
    );
  }
  return finish(state);
}

function adapter(api: "openai-responses" | "azure-openai-responses"): ResponsesTargetProjector {
  return Object.freeze({ id: api, api, project: projectResponses });
}

export const responsesToOpenAIResponsesProjector = adapter("openai-responses");
export const responsesToAzureOpenAIResponsesProjector = adapter(
  "azure-openai-responses",
);

export const responsesToOpenAICodexResponsesProjector: ResponsesTargetProjector =
  Object.freeze({
    id: "openai-codex-responses",
    api: "openai-codex-responses",
    project(input: ResponsesTargetProjectionInput) {
      const payload = clonePayload(input.payload, input.model.api);
      requirePayloadShape(payload, input.model.api, [
        ["model", "string"],
        ["input", "array"],
        ["stream", "true"],
      ]);
      const state = createState(this.id, payload, input.supplement);
      const output = input.supplement.output;
      if (output?.format !== undefined) {
        if (output.format.value.type === "text") native(state, "output.format");
      }
      if (output?.verbosity !== undefined) {
        const text = payload.text as Record<string, unknown> | undefined;
        projectTargetValue(
          state,
          "output.verbosity",
          text?.verbosity,
          output.verbosity.value,
          (value) => {
            payload.text = { ...(text ?? {}), verbosity: value };
          },
        );
      }
      if (output?.include !== undefined && !state.handled.has("output.include")) {
        if (
          output.include.value.every(
            (value: string) => value === "reasoning.encrypted_content",
          )
        ) {
          projectTargetValue(
            state,
            "output.include",
            payload.include,
            [...output.include.value],
            (value) => {
              payload.include = value;
            },
          );
        }
      }
      const tools = input.supplement.tools;
      if (tools?.parallelCalls !== undefined) {
        if (tools.parallelCalls.value) native(state, "tools.parallelCalls");
      }
      if (tools?.choice !== undefined) {
        const choice = tools.choice.value;
        const mapped =
          choice.kind === "allowed" ? choice.mode : choice.kind === "named" ? undefined : choice.kind;
        if (mapped === "auto" || mapped === "none" || mapped === "required") {
          projectTargetValue(
            state,
            "tools.choice",
            payload.tool_choice,
            mapped,
            (value) => {
              payload.tool_choice = value;
            },
          );
        }
      }
      const sampling = input.supplement.sampling;
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
      const cache = input.supplement.cache;
      if (cache?.key !== undefined) {
        projectTargetValue(
          state,
          "cache.key",
          payload.prompt_cache_key,
          cache.key.value,
          (value) => {
            payload.prompt_cache_key = value;
          },
        );
      }
      const lifecycle = input.supplement.lifecycle;
      if (lifecycle?.serviceTier !== undefined) {
        projectTargetValue(
          state,
          "lifecycle.serviceTier",
          payload.service_tier,
          lifecycle.serviceTier.value,
          (value) => {
            payload.service_tier = value;
          },
        );
      }
      return finish(state);
    },
  });
