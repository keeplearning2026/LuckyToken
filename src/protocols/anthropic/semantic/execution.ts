import type { Model, Models } from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@token/provider-contract/diagnostics";

import {
  execute,
  type ExecutionObservation,
  type ExecutionOperation,
} from "../../../execution.js";
import { PiContextCompatibilityError } from "../../../pi-context-compatibility-error.js";
import { InvalidRequest } from "../failures.js";
import type { AnthropicSemanticInvocation } from "./invocation.js";
import type { AnthropicReasoningOutcome } from "./reasoning/contract.js";
import { prepareAnthropicReasoning } from "./reasoning/request.js";

export interface AnthropicSemanticExecutionResult {
  readonly message: Awaited<ReturnType<ExecutionOperation>>;
  readonly outcomes: readonly AnthropicReasoningOutcome[];
}

function publishReasoningWarnings(
  outcomes: readonly AnthropicReasoningOutcome[],
  factsSink: ExecutionFactsSink | undefined,
): void {
  for (const entry of outcomes) {
    if (entry.outcome.kind === "pi-native") continue;
    try {
      factsSink?.notice({
        adapter: "anthropic",
        direction: "request",
        code:
          entry.notice?.code ??
          (entry.outcome.kind === "degraded"
            ? "semantic_reasoning_degraded"
            : "semantic_reasoning_omitted"),
        ...(entry.notice?.jsonPath === undefined
          ? {}
          : { jsonPath: entry.notice.jsonPath }),
        action: "degrade",
        message: entry.outcome.warning,
      });
    } catch {
      // Diagnostics are fail-open and cannot affect semantic execution.
    }
  }
}

export async function executeAnthropicSemanticInvocation(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly execution: {
    readonly executeOperation: ExecutionOperation;
    readonly factsSink?: ExecutionFactsSink;
    readonly providerEvidence?: Readonly<{
      request(payload: unknown): void;
      response?(response: unknown): void;
    }>;
  };
}): Promise<AnthropicSemanticExecutionResult> {
  const prepared = prepareAnthropicReasoning({
    model: input.model,
    invocation: input.invocation,
  });
  publishReasoningWarnings(prepared.outcomes, input.execution.factsSink);

  const providerEvidence = input.execution.providerEvidence;
  const observation: ExecutionObservation | undefined =
    providerEvidence === undefined
      ? undefined
      : {
          providerRequest: providerEvidence.request,
          ...(providerEvidence.response === undefined
            ? {}
            : { providerResponse: providerEvidence.response }),
        };
  let message: Awaited<ReturnType<ExecutionOperation>>;
  try {
    message = await (input.execution.executeOperation ?? execute)(
      input.models,
      input.model,
      prepared.invocation.pi.context,
      prepared.invocation.pi.options,
      input.execution.factsSink,
      observation,
    );
  } catch (error) {
    if (error instanceof PiContextCompatibilityError) {
      throw new InvalidRequest(error.message);
    }
    throw error;
  }
  return Object.freeze({ message, outcomes: prepared.outcomes });
}
