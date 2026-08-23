import type { Model } from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@luckytoken/provider-contract/diagnostics";

import type { PayloadProjectionOperation } from "../../../../semantic-conversion/kernel/contract.js";
import type { AnthropicSemanticInvocation } from "../invocation.js";
import {
  initialOpenAICompletionsFailure,
  projectAnthropicToOpenAICompletions,
} from "./adapters/openai-completions.js";
import { projectAnthropicToAnthropicMessages } from "./adapters/anthropic-messages.js";
import {
  initialGoogleFailure,
  projectAnthropicToGoogle,
} from "./adapters/google.js";
import {
  initialMistralFailure,
  projectAnthropicToMistral,
} from "./adapters/mistral.js";
import {
  initialOpenAIResponsesFailure,
  projectAnthropicToOpenAIResponses,
  type AnthropicResponsesTargetApi,
} from "./adapters/openai-responses.js";
import {
  initialBedrockFailure,
  projectAnthropicToBedrock,
} from "./adapters/bedrock.js";
import {
  initialPiMessagesFailure,
  projectAnthropicToPiMessages,
} from "./adapters/pi-messages.js";
import type { AnthropicProjectionOutcome } from "./contract.js";
import {
  initialCommandCodePrivateFailure,
  projectAnthropicToCommandCodePrivate,
} from "./adapters/commandcode-private.js";
import {
  assessUnprojectedAnthropicSupplement,
  type AnthropicSupplementDisposition,
} from "./supplement-disposition.js";

function publishWarnings(
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
}): PayloadProjectionOperation<AnthropicProjectionOutcome> {
  const supplementDisposition: AnthropicSupplementDisposition =
    input.model.api === "anthropic-messages"
      ? Object.freeze({ outcomes: Object.freeze([]) })
      : assessUnprojectedAnthropicSupplement({
          invocation: input.invocation,
          target: `${input.model.provider}/${input.model.api}/${input.model.id}`,
        });
  const finish = <T extends {
    readonly payload: unknown;
    readonly outcomes: readonly AnthropicProjectionOutcome[];
    readonly failure?: string;
  }>(result: T): T => {
    const combined = Object.freeze([
      ...supplementDisposition.outcomes,
      ...result.outcomes,
    ]);
    const finished = { ...result, outcomes: combined } as T;
    publishWarnings(combined, input.factsSink);
    return finished;
  };
  const failure = (targetFailure: string | undefined): string | undefined =>
    supplementDisposition.failure ?? targetFailure;
  const failureField = (
    targetFailure: string | undefined,
  ): { readonly initialFailure?: string } => {
    const resolved = failure(targetFailure);
    return resolved === undefined ? {} : { initialFailure: resolved };
  };

  if (input.model.api === "commandcode-private") {
    const initialFailure = initialCommandCodePrivateFailure(input);
    return Object.freeze({
      initialOutcomes: supplementDisposition.outcomes,
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToCommandCodePrivate({ ...input, payload }));
      },
    });
  }

  if (input.model.api === "anthropic-messages") {
    return Object.freeze({
      initialOutcomes: supplementDisposition.outcomes,
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
    const initialFailure = initialGoogleFailure(input);
    const api = input.model.api;
    return Object.freeze({
      initialOutcomes: supplementDisposition.outcomes,
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
    const initialFailure = initialBedrockFailure(input);
    return Object.freeze({
      initialOutcomes: supplementDisposition.outcomes,
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToBedrock({ ...input, payload }));
      },
    });
  }
  if (input.model.api === "pi-messages") {
    const initialFailure = initialPiMessagesFailure(input);
    return Object.freeze({
      initialOutcomes: supplementDisposition.outcomes,
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToPiMessages({ ...input, payload }));
      },
    });
  }
  if (input.model.api === "mistral-conversations") {
    const initialFailure = initialMistralFailure(input);
    return Object.freeze({
      initialOutcomes: supplementDisposition.outcomes,
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
    const initialFailure = initialOpenAIResponsesFailure({ ...input, api });
    return Object.freeze({
      initialOutcomes: supplementDisposition.outcomes,
      ...failureField(initialFailure),
      project(payload: unknown) {
        return finish(projectAnthropicToOpenAIResponses({ ...input, api, payload }));
      },
    });
  }
  if (input.model.api !== "openai-completions") {
    return Object.freeze({
      initialOutcomes: supplementDisposition.outcomes,
      initialFailure: failure(
        `Anthropic semantic projection is not certified for Pi API ${input.model.api}`,
      )!,
      project(payload: unknown) {
        return { payload, outcomes: [] };
      },
    });
  }
  const initialFailure = initialOpenAICompletionsFailure(input);
  return Object.freeze({
    initialOutcomes: supplementDisposition.outcomes,
    ...failureField(initialFailure),
    project(payload: unknown) {
      return finish(projectAnthropicToOpenAICompletions({
        ...input,
        payload,
      }));
    },
  });
}
