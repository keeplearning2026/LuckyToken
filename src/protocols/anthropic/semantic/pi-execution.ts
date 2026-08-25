import type {
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@token/provider-contract/diagnostics";

import {
  execute,
  ExecutionFailure,
  freezePiInvocation,
  type ExecutionOperation,
} from "../../../execution.js";
import type { AnthropicPayloadProjectionOperation } from "./projection/contract.js";

export interface AnthropicPiInvocation {
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
}

export interface AnthropicPiExecutionCapabilities {
  readonly executeOperation?: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
  readonly providerEvidence?: Readonly<{
    request(payload: unknown): void;
    response?(response: unknown): void;
  }>;
}

export interface AnthropicPiExecutionResult {
  readonly message: AssistantMessage;
  readonly outcomes: AnthropicPayloadProjectionOperation["initialOutcomes"];
}

export class InvalidAnthropicPiExecution extends Error {
  readonly kind = "InvalidAnthropicPiExecution";
  readonly outcomes: AnthropicPayloadProjectionOperation["initialOutcomes"];

  constructor(
    message: string,
    outcomes: AnthropicPayloadProjectionOperation["initialOutcomes"] = [],
  ) {
    super(message);
    this.name = "InvalidAnthropicPiExecution";
    this.outcomes = Object.freeze([...outcomes]);
  }
}

class AnthropicPayloadCallbackFailure extends Error {
  readonly projectionCause: unknown;

  constructor(cause: unknown) {
    super("Anthropic payload projection callback failed");
    this.name = "AnthropicPayloadCallbackFailure";
    this.projectionCause = cause;
  }
}

function unwrapCallbackFailure(error: unknown): unknown | undefined {
  if (error instanceof InvalidAnthropicPiExecution) return error;
  if (error instanceof AnthropicPayloadCallbackFailure) {
    return error.projectionCause;
  }
  if (error instanceof ExecutionFailure) {
    if (error.diagnostic instanceof InvalidAnthropicPiExecution) {
      return error.diagnostic;
    }
    if (error.diagnostic instanceof AnthropicPayloadCallbackFailure) {
      return error.diagnostic.projectionCause;
    }
  }
  return undefined;
}

export async function executeWithAnthropicPi(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly pi: AnthropicPiInvocation;
  readonly projection: AnthropicPayloadProjectionOperation;
  readonly infrastructure: AnthropicPiExecutionCapabilities;
}): Promise<AnthropicPiExecutionResult> {
  if (input.pi.options.onPayload !== undefined) {
    throw new InvalidAnthropicPiExecution(
      "Anthropic Pi invocation must not supply onPayload",
    );
  }
  if (input.pi.options.onResponse !== undefined) {
    throw new InvalidAnthropicPiExecution(
      "Anthropic Pi invocation must not supply onResponse",
    );
  }
  let projectionCalls = 0;
  let outcomes = input.projection.initialOutcomes;
  let retainedCallbackFailure: unknown | undefined;
  const options: ModelsSimpleStreamOptions = {
    ...input.pi.options,
    async onPayload(payload) {
      try {
        projectionCalls += 1;
        if (projectionCalls !== 1) {
          throw new InvalidAnthropicPiExecution(
            "Pi invoked the Anthropic payload projection seam more than once",
            outcomes,
          );
        }
        const projected = await input.projection.project(payload, input.model);
        outcomes = Object.freeze([...projected.outcomes]);
        try {
          input.infrastructure.providerEvidence?.request(projected.payload);
        } catch {
          // Observation failure cannot alter Anthropic-owned projection.
        }
        return projected.payload;
      } catch (error) {
        const wrapped = error instanceof InvalidAnthropicPiExecution
          ? error
          : new AnthropicPayloadCallbackFailure(error);
        retainedCallbackFailure = wrapped;
        throw wrapped;
      }
    },
    onResponse(response) {
      try {
        input.infrastructure.providerEvidence?.response?.(response);
      } catch {
        // Observation failure cannot alter Anthropic Provider handling.
      }
    },
  };

  freezePiInvocation(input.model, input.pi.context, options);
  const operation = input.infrastructure.executeOperation ?? execute;
  let message: AssistantMessage;
  try {
    message = await operation(
      input.models,
      input.model,
      input.pi.context,
      options,
      input.infrastructure.factsSink,
    );
  } catch (error) {
    const direct = unwrapCallbackFailure(error);
    if (direct !== undefined) throw direct;
    const retained = unwrapCallbackFailure(retainedCallbackFailure);
    if (retained !== undefined) throw retained;
    throw error;
  }
  const retained = unwrapCallbackFailure(retainedCallbackFailure);
  if (retained !== undefined) throw retained;
  if (projectionCalls !== 1) {
    throw new InvalidAnthropicPiExecution(
      `Pi API ${input.model.api} completed without invoking the Anthropic-owned onPayload seam`,
      outcomes,
    );
  }
  return Object.freeze({
    message,
    outcomes: Object.freeze([...outcomes]),
  });
}
