import type {
  AssistantMessage,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@token/provider-contract/diagnostics";

import {
  execute,
  type ExecutionObservation,
  type ExecutionOperation,
} from "../../../execution.js";
import { PiContextCompatibilityError } from "../../../pi-context-compatibility-error.js";
import { InvalidRequest } from "../request.js";
import type { ResponsesSemanticInvocation } from "./invocation.js";
import { prepareResponsesReasoning } from "./reasoning/request.js";
import type { ResponsesReasoningOutcome } from "./reasoning/contract.js";

export interface ResponsesSemanticExecutionCapabilities {
  readonly executeOperation?: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
  readonly providerEvidence?: Readonly<{
    request(payload: unknown): void;
    response?(response: unknown): void;
  }>;
}

export interface ResponsesSemanticExecutionResult {
  readonly message: AssistantMessage;
  readonly reasoningOutcomes: readonly ResponsesReasoningOutcome[];
}

function publishReasoningWarnings(
  outcomes: readonly ResponsesReasoningOutcome[],
  factsSink: ExecutionFactsSink | undefined,
): void {
  for (const entry of outcomes) {
    const outcome = entry.outcome;
    if (
      outcome.kind !== "omitted" &&
      outcome.kind !== "degraded" &&
      outcome.kind !== "content-fallback"
    ) {
      continue;
    }
    try {
      factsSink?.notice({
        adapter: "openai-responses",
        direction: "request",
        code:
          outcome.kind === "content-fallback"
            ? "semantic_reasoning_content_fallback"
            : outcome.kind === "degraded"
              ? "semantic_reasoning_degraded"
              : "semantic_reasoning_omitted",
        action: "degrade",
      });
    } catch {
      // Diagnostics are fail-open and cannot affect semantic execution.
    }
  }
}

export async function executeOpenAIResponsesSemanticInvocation(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly invocation: ResponsesSemanticInvocation;
  readonly infrastructure: ResponsesSemanticExecutionCapabilities;
}): Promise<ResponsesSemanticExecutionResult> {
  const prepared = prepareResponsesReasoning({
    model: input.model,
    context: input.invocation.pi.context,
    options: input.invocation.pi.options,
    semantics: input.invocation.reasoning,
  });
  publishReasoningWarnings(prepared.outcomes, input.infrastructure.factsSink);

  const operation = input.infrastructure.executeOperation ?? execute;
  const providerEvidence = input.infrastructure.providerEvidence;
  const observation: ExecutionObservation | undefined =
    providerEvidence === undefined
      ? undefined
      : {
          providerRequest: providerEvidence.request,
          ...(providerEvidence.response === undefined
            ? {}
            : { providerResponse: providerEvidence.response }),
        };
  let message: AssistantMessage;
  try {
    message = await operation(
      input.models,
      input.model,
      prepared.context,
      prepared.options,
      input.infrastructure.factsSink,
      observation,
    );
  } catch (error) {
    if (error instanceof PiContextCompatibilityError) {
      throw new InvalidRequest(error.message);
    }
    throw error;
  }
  return Object.freeze({
    message,
    reasoningOutcomes: prepared.outcomes,
  });
}
