import type { Model, Models } from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@luckytoken/provider-contract/diagnostics";

import type { ExecutionOperation } from "../../../execution.js";
import {
  executeWithAnthropicPi,
  InvalidAnthropicPiExecution,
} from "./pi-execution.js";
import type { AnthropicSemanticInvocation } from "./invocation.js";
import {
  prepareAnthropicPayloadProjection,
  publishAnthropicProjectionWarnings,
} from "./projection/request.js";
import type { AnthropicProjectionOutcome } from "./projection/contract.js";
import { prepareAnthropicReasoning } from "./reasoning/request.js";

export interface AnthropicSemanticExecutionResult {
  readonly message: Awaited<ReturnType<ExecutionOperation>>;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
}

export class InvalidAnthropicSemanticExecution extends Error {
  readonly kind = "InvalidAnthropicSemanticExecution";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAnthropicSemanticExecution";
  }
}

export async function executeAnthropicSemanticInvocation(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly execution: {
    readonly executeOperation: ExecutionOperation;
    readonly factsSink?: ExecutionFactsSink;
  };
}): Promise<AnthropicSemanticExecutionResult> {
  const prepared = prepareAnthropicReasoning({
    model: input.model,
    invocation: input.invocation,
  });
  publishAnthropicProjectionWarnings(
    prepared.outcomes,
    input.execution.factsSink,
  );
  const providerProjection = prepareAnthropicPayloadProjection({
    model: input.model,
    invocation: prepared.invocation,
    effortPlan: prepared.effortPlan,
    ...(input.execution.factsSink === undefined
      ? {}
      : { factsSink: input.execution.factsSink }),
  });
  const projection = Object.freeze({
    initialOutcomes: prepared.outcomes,
    async project(payload: unknown, model: Model<string>) {
      const result = await providerProjection.project(payload, model);
      return {
        ...result,
        outcomes: Object.freeze([...prepared.outcomes, ...result.outcomes]),
      };
    },
  });
  try {
    return await executeWithAnthropicPi({
      models: input.models,
      model: input.model,
      pi: prepared.invocation.pi,
      projection,
      infrastructure: {
        executeOperation: input.execution.executeOperation,
        ...(input.execution.factsSink === undefined
          ? {}
          : { factsSink: input.execution.factsSink }),
      },
    });
  } catch (error) {
    if (error instanceof InvalidAnthropicPiExecution) {
      throw new InvalidAnthropicSemanticExecution(error.message);
    }
    throw error;
  }
}
