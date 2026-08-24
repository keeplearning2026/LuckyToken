import type { Model } from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@luckytoken/provider-contract/diagnostics";

import type { AnthropicSemanticInvocation } from "../invocation.js";
import {
  initialAnthropicToOpenAICompletionsFailure,
  projectAnthropicToOpenAICompletions,
} from "./adapters/openai-completions.js";
import { projectAnthropicToAnthropicMessages } from "./adapters/anthropic-messages.js";
import {
  initialAnthropicToGoogleFailure,
  projectAnthropicToGoogle,
} from "./adapters/google.js";
import {
  initialAnthropicToMistralFailure,
  projectAnthropicToMistral,
} from "./adapters/mistral.js";
import {
  initialAnthropicToOpenAIResponsesFailure,
  projectAnthropicToOpenAIResponses,
  type AnthropicResponsesTargetApi,
} from "./adapters/openai-responses.js";
import {
  initialAnthropicToBedrockFailure,
  projectAnthropicToBedrock,
} from "./adapters/bedrock.js";
import {
  initialAnthropicToPiMessagesFailure,
  projectAnthropicToPiMessages,
} from "./adapters/pi-messages.js";
import type {
  AnthropicPayloadProjectionOperation,
  AnthropicProjectionOutcome,
} from "./contract.js";
import {
  initialAnthropicToCommandCodePrivateFailure,
  projectAnthropicToCommandCodePrivate,
} from "./adapters/commandcode-private.js";
import {
  assessUnprojectedAnthropicSupplement,
  type AnthropicSupplementDisposition,
} from "./supplement-disposition.js";
import { selectAnthropicPayloadProjector } from "./registry.js";

export function publishAnthropicProjectionWarnings(
  outcomes: readonly AnthropicProjectionOutcome[],
  factsSink: ExecutionFactsSink | undefined,
): void {
  for (const entry of outcomes) {
    const disposition = entry.outcome;
    const notice =
      disposition.kind === "payload-projected" && disposition.warning !== undefined
        ? {
            adapter: disposition.projector,
            code: "anthropic_semantic_pi_native_mapping_repaired",
            action: "xrepair" as const,
          }
        : disposition.kind === "omitted"
          ? {
              adapter: "anthropic-messages",
              code: "anthropic_semantic_projection_omitted",
              action: "degrade" as const,
            }
          : disposition.kind === "degraded"
            ? {
                adapter: "anthropic-messages",
                code: "anthropic_semantic_projection_degraded",
                action: "degrade" as const,
              }
          : undefined;
    if (notice === undefined) continue;
    try {
      factsSink?.notice?.({
        ...notice,
        direction: "request",
      });
    } catch {
      // Observation remains fail-open.
    }
  }
}

export function prepareAnthropicPayloadProjection(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly factsSink?: ExecutionFactsSink;
}): AnthropicPayloadProjectionOperation {
  const commonInitialFailure =
    input.invocation.supplement.outputTokenCeiling < 1
      ? "Anthropic max_tokens=0 cannot be represented by Pi Provider requests without increasing the Client output-token ceiling"
      : undefined;
  const finish = <T extends {
    readonly payload: unknown;
    readonly outcomes: readonly AnthropicProjectionOutcome[];
    readonly failure?: string;
    readonly failureKind?: "unsupported-semantics" | "payload-contract";
  }>(result: T): T => {
    const supplementDisposition: AnthropicSupplementDisposition =
      input.model.api === "anthropic-messages"
        ? Object.freeze({ outcomes: Object.freeze([]) })
        : assessUnprojectedAnthropicSupplement({
            invocation: input.invocation,
            target: `${input.model.provider}/${input.model.api}/${input.model.id}`,
            targetSupportsReasoning: input.model.reasoning,
            resolvedControls: new Set(result.outcomes.map((entry) => entry.control)),
          });
    const combined = Object.freeze([
      ...result.outcomes,
      ...supplementDisposition.outcomes,
    ]);
    const finished = {
      ...result,
      outcomes: combined,
      ...(result.failure === undefined && supplementDisposition.failure !== undefined
        ? {
            failure: supplementDisposition.failure,
            failureKind: "unsupported-semantics" as const,
          }
        : result.failure !== undefined && result.failureKind === undefined
          ? { failureKind: "payload-contract" as const }
        : {}),
    } as T;
    publishAnthropicProjectionWarnings(combined, input.factsSink);
    return finished;
  };
  const failureField = (
    targetFailure: string | undefined,
  ): { readonly initialFailure?: string } => {
    const failure = commonInitialFailure ?? targetFailure;
    return failure === undefined ? {} : { initialFailure: failure };
  };

  if (selectAnthropicPayloadProjector(input.model) === undefined) {
    return Object.freeze({
      initialOutcomes: Object.freeze([]),
      ...failureField(undefined),
      project(payload: unknown) {
        return finish({ payload, outcomes: [] });
      },
    });
  }

  if (input.model.api === "commandcode-private") {
    const initialFailure = initialAnthropicToCommandCodePrivateFailure(input);
    return Object.freeze({
      initialOutcomes: Object.freeze([]),
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToCommandCodePrivate({ ...input, payload }));
      },
    });
  }

  if (input.model.api === "anthropic-messages") {
    return Object.freeze({
      initialOutcomes: Object.freeze([]),
      ...failureField(undefined),
      project(payload: unknown) {
        return finish(projectAnthropicToAnthropicMessages({
          ...input,
          payload,
        }));
      },
    });
  }
  if (
    input.model.api === "google-generative-ai" ||
    input.model.api === "google-vertex"
  ) {
    const initialFailure = initialAnthropicToGoogleFailure(input);
    const api = input.model.api;
    return Object.freeze({
      initialOutcomes: Object.freeze([]),
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToGoogle({
          ...input,
          api,
          payload,
        }));
      },
    });
  }
  if (input.model.api === "bedrock-converse-stream") {
    const initialFailure = initialAnthropicToBedrockFailure(input);
    return Object.freeze({
      initialOutcomes: Object.freeze([]),
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToBedrock({ ...input, payload }));
      },
    });
  }
  if (input.model.api === "pi-messages") {
    const initialFailure = initialAnthropicToPiMessagesFailure(input);
    return Object.freeze({
      initialOutcomes: Object.freeze([]),
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToPiMessages({ ...input, payload }));
      },
    });
  }
  if (input.model.api === "mistral-conversations") {
    const initialFailure = initialAnthropicToMistralFailure(input);
    return Object.freeze({
      initialOutcomes: Object.freeze([]),
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToMistral({ ...input, payload }));
      },
    });
  }
  if (
    input.model.api === "openai-responses" ||
    input.model.api === "azure-openai-responses" ||
    input.model.api === "openai-codex-responses"
  ) {
    const api = input.model.api as AnthropicResponsesTargetApi;
    const initialFailure = initialAnthropicToOpenAIResponsesFailure({ ...input, api });
    return Object.freeze({
      initialOutcomes: Object.freeze([]),
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToOpenAIResponses({ ...input, api, payload }));
      },
    });
  }
  if (input.model.api !== "openai-completions") {
    throw new Error(`Anthropic projector registry mismatch for Pi API ${input.model.api}`);
  }
  const initialFailure = initialAnthropicToOpenAICompletionsFailure(input);
  return Object.freeze({
    initialOutcomes: Object.freeze([]),
    ...failureField(initialFailure),
    project(payload: unknown) {
      return finish(projectAnthropicToOpenAICompletions({
        ...input,
        payload,
      }));
    },
  });
}
