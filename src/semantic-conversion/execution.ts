import type {
  AssistantMessage,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@luckytoken/provider-contract/diagnostics";

import type { ExecutionOperation } from "../execution.js";
import type { SemanticConversionInvocation } from "./contract.js";
import {
  executeWithPiKernel,
  InvalidPiKernelExecution,
} from "./kernel/execution.js";
import type { PayloadProjectionOperation } from "./kernel/contract.js";
import type { ProjectionOutcome } from "./projection-outcome.js";
import {
  prepareReasoning,
  projectReasoningPayload,
} from "./reasoning/request.js";
import type { ReasoningOutcome } from "./reasoning/contract.js";
import { projectSupplementPayload } from "./supplement/request.js";
import type { SupplementProjectionOutcome } from "./supplement/contract.js";

export interface SemanticExecutionInfrastructure {
  readonly executeOperation?: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
}

export interface SemanticConversionResult {
  readonly message: AssistantMessage;
  readonly reasoningOutcomes: readonly ReasoningOutcome[];
  readonly supplementOutcomes: readonly SupplementProjectionOutcome[];
}

export class InvalidSemanticExecution extends Error {
  readonly kind = "InvalidSemanticExecution";

  constructor(message: string) {
    super(message);
    this.name = "InvalidSemanticExecution";
  }
}

function publishProjectionWarnings(
  scope: "reasoning" | "supplement",
  outcomes: readonly {
    readonly outcome: ProjectionOutcome;
    readonly subject?: string;
    readonly control?: string;
  }[],
  factsSink: ExecutionFactsSink | undefined,
  emitted: Set<string>,
): void {
  for (const [index, entry] of outcomes.entries()) {
    const outcome = entry.outcome;
    const notice =
      outcome.kind === "payload-projected" &&
      outcome.warning === "pi-native-mapping-repaired"
        ? {
            adapter: outcome.projector,
            code:
              scope === "reasoning"
                ? "semantic_reasoning_pi_native_mapping_repaired"
                : "semantic_supplement_pi_native_mapping_repaired",
            action: "xrepair" as const,
          }
        : outcome.kind === "omitted"
          ? {
              adapter: "semantic-conversion",
              code: "semantic_projection_omitted",
              action: "degrade" as const,
            }
          : outcome.kind === "content-fallback"
            ? {
                adapter: "semantic-conversion",
                code: "semantic_reasoning_content_fallback",
                action: "degrade" as const,
              }
            : undefined;
    if (notice === undefined) continue;
    const identity = `${scope}:${entry.subject ?? entry.control ?? index}:${notice.code}`;
    if (emitted.has(identity)) continue;
    emitted.add(identity);
    try {
      factsSink?.notice?.({
        adapter: notice.adapter,
        direction: "request",
        code: notice.code,
        action: notice.action,
      });
    } catch {
      // Diagnostics are fail-open and cannot affect semantic execution.
    }
  }
}

function failedProjection(
  outcomes: readonly { readonly outcome: ProjectionOutcome }[],
): string | undefined {
  const failed = outcomes.find((entry) => entry.outcome.kind === "failed");
  if (failed?.outcome.kind === "failed") {
    return failed.outcome.error;
  }
  return undefined;
}

type SemanticKernelOutcome =
  | { readonly scope: "reasoning"; readonly value: ReasoningOutcome }
  | {
      readonly scope: "supplement";
      readonly value: SupplementProjectionOutcome;
    };

export async function executeSemanticConversion(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly invocation: SemanticConversionInvocation;
  readonly infrastructure: SemanticExecutionInfrastructure;
}): Promise<SemanticConversionResult> {
  if (input.invocation.pi.options.onPayload !== undefined) {
    throw new InvalidSemanticExecution(
      "Semantic Conversion invocation must not supply onPayload",
    );
  }
  const prepared = prepareReasoning({
    model: input.model,
    context: input.invocation.pi.context,
    options: input.invocation.pi.options,
    semantics: input.invocation.reasoning,
  });
  const emittedProjectionWarnings = new Set<string>();
  const initialOutcomes: readonly SemanticKernelOutcome[] = prepared.outcomes.map(
    (value) => ({ scope: "reasoning", value }),
  );
  const initialFailure = failedProjection(prepared.outcomes);
  const projection: PayloadProjectionOperation<SemanticKernelOutcome> = {
    initialOutcomes,
    ...(initialFailure === undefined ? {} : { initialFailure }),
    project(payload) {
      const reasoning = projectReasoningPayload({
        model: input.model,
        prepared,
        payload,
      });
      publishProjectionWarnings(
        "reasoning",
        reasoning.outcomes,
        input.infrastructure.factsSink,
        emittedProjectionWarnings,
      );
      const reasoningFailure = failedProjection(reasoning.outcomes);
      if (reasoningFailure !== undefined) {
        return {
          payload: reasoning.payload,
          outcomes: reasoning.outcomes.map((value) => ({
            scope: "reasoning" as const,
            value,
          })),
          failure: reasoningFailure,
        };
      }
      const supplement = projectSupplementPayload({
        model: input.model,
        payload: reasoning.payload,
        supplement: input.invocation.supplement,
        reasoning: input.invocation.reasoning.request,
      });
      publishProjectionWarnings(
        "supplement",
        supplement.outcomes,
        input.infrastructure.factsSink,
        emittedProjectionWarnings,
      );
      const supplementFailure = failedProjection(supplement.outcomes);
      return {
        payload: supplement.payload,
        outcomes: [
          ...reasoning.outcomes.map((value) => ({
            scope: "reasoning" as const,
            value,
          })),
          ...supplement.outcomes.map((value) => ({
            scope: "supplement" as const,
            value,
          })),
        ],
        ...(supplementFailure === undefined
          ? {}
          : { failure: supplementFailure }),
      };
    },
  };
  let result;
  try {
    result = await executeWithPiKernel({
      models: input.models,
      model: input.model,
      pi: { context: prepared.context, options: prepared.options },
      projection,
      infrastructure: input.infrastructure,
    });
  } catch (error) {
    if (error instanceof InvalidPiKernelExecution) {
      throw new InvalidSemanticExecution(error.message);
    }
    throw error;
  }
  return Object.freeze({
    message: result.message,
    reasoningOutcomes: Object.freeze(
      result.outcomes
        .filter((entry) => entry.scope === "reasoning")
        .map((entry) => entry.value),
    ),
    supplementOutcomes: Object.freeze(
      result.outcomes
        .filter((entry) => entry.scope === "supplement")
        .map((entry) => entry.value),
    ),
  });
}
