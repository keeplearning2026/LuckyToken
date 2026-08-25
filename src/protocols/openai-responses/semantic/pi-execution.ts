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
import type { ResponsesPayloadProjectionOperation } from "./projection/operation.js";

export interface ResponsesPiInvocation {
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
}

export interface ResponsesPiExecutionCapabilities {
  readonly executeOperation?: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
}

export interface ResponsesPiExecutionResult<TOutcome> {
  readonly message: AssistantMessage;
  readonly outcomes: readonly TOutcome[];
}

export class InvalidResponsesPiExecution extends Error {
  readonly kind = "InvalidResponsesPiExecution";

  constructor(message: string) {
    super(message);
    this.name = "InvalidResponsesPiExecution";
  }
}

export class ResponsesProjectionRejected extends Error {
  readonly kind = "ResponsesProjectionRejected";
  readonly outcomes: readonly unknown[];

  constructor(message: string, outcomes: readonly unknown[]) {
    super(message);
    this.name = "ResponsesProjectionRejected";
    this.outcomes = Object.freeze([...outcomes]);
  }
}

class PayloadProjectionCallbackFailure extends Error {
  readonly projectionCause: unknown;

  constructor(cause: unknown) {
    super("Payload projection callback failed");
    this.name = "PayloadProjectionCallbackFailure";
    this.projectionCause = cause;
  }
}

export async function executeWithResponsesPi<TOutcome>(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly pi: ResponsesPiInvocation;
  readonly projection: ResponsesPayloadProjectionOperation<TOutcome>;
  readonly infrastructure: ResponsesPiExecutionCapabilities;
}): Promise<ResponsesPiExecutionResult<TOutcome>> {
  if (input.pi.options.onPayload !== undefined) {
    throw new InvalidResponsesPiExecution(
      "Pi invocation must not supply onPayload",
    );
  }
  if (input.projection.initialFailure !== undefined) {
    throw new ResponsesProjectionRejected(
      input.projection.initialFailure,
      input.projection.initialOutcomes,
    );
  }

  let projectionCalls = 0;
  let outcomes: readonly TOutcome[] = input.projection.initialOutcomes;
  let callbackFailed = false;
  let callbackFailure: unknown;
  const options: ModelsSimpleStreamOptions = {
    ...input.pi.options,
    async onPayload(payload) {
      try {
        projectionCalls += 1;
        if (projectionCalls !== 1) {
          throw new InvalidResponsesPiExecution(
            "Pi invoked the payload projection seam more than once",
          );
        }
        const projected = await input.projection.project(payload, input.model);
        outcomes = Object.freeze([...projected.outcomes]);
        if (projected.failure !== undefined) {
          throw new ResponsesProjectionRejected(
            projected.failure,
            outcomes,
          );
        }
        return projected.payload;
      } catch (error) {
        callbackFailed = true;
        if (
          error instanceof InvalidResponsesPiExecution ||
          error instanceof ResponsesProjectionRejected
        ) {
          callbackFailure = error;
          throw error;
        }
        callbackFailure = new PayloadProjectionCallbackFailure(error);
        throw callbackFailure;
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
    if (callbackFailed) {
      if (callbackFailure instanceof PayloadProjectionCallbackFailure) {
        throw callbackFailure.projectionCause;
      }
      throw callbackFailure;
    }
    if (error instanceof PayloadProjectionCallbackFailure) {
      throw error.projectionCause;
    }
    if (error instanceof ExecutionFailure) {
      if (error.diagnostic instanceof InvalidResponsesPiExecution) {
        throw error.diagnostic;
      }
      if (error.diagnostic instanceof ResponsesProjectionRejected) {
        throw error.diagnostic;
      }
      if (error.diagnostic instanceof PayloadProjectionCallbackFailure) {
        throw error.diagnostic.projectionCause;
      }
    }
    throw error;
  }
  if (projectionCalls !== 1) {
    throw new InvalidResponsesPiExecution(
      `Pi API ${input.model.api} completed without invoking the Responses-owned onPayload seam`,
    );
  }
  return Object.freeze({
    message,
    outcomes: Object.freeze([...outcomes]),
  });
}
