import type {
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@luckytoken/provider-contract/diagnostics";

import {
  execute,
  freezePiInvocation,
  type ExecutionOperation,
} from "../../execution.js";
import type { PayloadProjectionOperation } from "./contract.js";

export interface PiInvocation {
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
}

export interface PiKernelInfrastructure {
  readonly executeOperation?: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
}

export interface PiKernelResult<TOutcome> {
  readonly message: AssistantMessage;
  readonly outcomes: readonly TOutcome[];
}

export class InvalidPiKernelExecution extends Error {
  readonly kind = "InvalidPiKernelExecution";

  constructor(message: string) {
    super(message);
    this.name = "InvalidPiKernelExecution";
  }
}

export async function executeWithPiKernel<TOutcome>(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly pi: PiInvocation;
  readonly projection: PayloadProjectionOperation<TOutcome>;
  readonly infrastructure: PiKernelInfrastructure;
}): Promise<PiKernelResult<TOutcome>> {
  if (input.pi.options.onPayload !== undefined) {
    throw new InvalidPiKernelExecution(
      "Pi invocation must not supply onPayload",
    );
  }
  if (input.projection.initialFailure !== undefined) {
    throw new InvalidPiKernelExecution(input.projection.initialFailure);
  }

  let projectionCalls = 0;
  let outcomes: readonly TOutcome[] = input.projection.initialOutcomes;
  const options: ModelsSimpleStreamOptions = {
    ...input.pi.options,
    async onPayload(payload) {
      projectionCalls += 1;
      if (projectionCalls !== 1) {
        throw new InvalidPiKernelExecution(
          "Pi invoked the payload projection seam more than once",
        );
      }
      const projected = await input.projection.project(payload, input.model);
      outcomes = Object.freeze([...projected.outcomes]);
      if (projected.failure !== undefined) {
        throw new InvalidPiKernelExecution(projected.failure);
      }
      return projected.payload;
    },
  };

  freezePiInvocation(input.model, input.pi.context, options);
  const operation = input.infrastructure.executeOperation ?? execute;
  const message = await operation(
    input.models,
    input.model,
    input.pi.context,
    options,
    input.infrastructure.factsSink,
  );
  if (projectionCalls !== 1) {
    throw new InvalidPiKernelExecution(
      `Pi API ${input.model.api} completed without invoking the kernel-owned onPayload seam`,
    );
  }
  return Object.freeze({
    message,
    outcomes: Object.freeze([...outcomes]),
  });
}
