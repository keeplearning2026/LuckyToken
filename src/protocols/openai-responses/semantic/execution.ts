import type {
  AssistantMessage,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@token/provider-contract/diagnostics";

import type { ResponsesSemanticInvocation } from "./invocation.js";
import {
  executeWithResponsesPi,
  InvalidResponsesPiExecution,
  type ResponsesPiExecutionCapabilities,
} from "./pi-execution.js";
import type { ResponsesPayloadProjectionOperation } from "./projection/operation.js";
import type { ResponsesProjectionOutcome } from "./projection/outcome.js";
import {
  prepareResponsesReasoning,
  projectResponsesReasoningPayload,
} from "./reasoning/request.js";
import type { ResponsesReasoningOutcome } from "./reasoning/contract.js";
import { projectResponsesPayload } from "./projection/request.js";
import type { ResponsesProjectionRecord } from "./supplement/contract.js";

export type ResponsesSemanticExecutionCapabilities =
  ResponsesPiExecutionCapabilities;

export interface ResponsesSemanticExecutionResult {
  readonly message: AssistantMessage;
  readonly reasoningOutcomes: readonly ResponsesReasoningOutcome[];
  readonly supplementOutcomes: readonly ResponsesProjectionRecord[];
}

export class InvalidResponsesSemanticExecution extends Error {
  readonly kind = "InvalidResponsesSemanticExecution";

  constructor(message: string) {
    super(message);
    this.name = "InvalidResponsesSemanticExecution";
  }
}

function publishProjectionWarnings(
  scope: "reasoning" | "supplement",
  outcomes: readonly {
    readonly outcome: ResponsesProjectionOutcome;
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
              adapter: "openai-responses",
              code: "semantic_projection_omitted",
              action: "degrade" as const,
            }
          : outcome.kind === "degraded"
            ? {
                adapter: outcome.projector,
                code: "semantic_projection_degraded",
                action: "degrade" as const,
              }
          : outcome.kind === "content-fallback"
            ? {
                adapter: "openai-responses",
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
  outcomes: readonly { readonly outcome: ResponsesProjectionOutcome }[],
): string | undefined {
  const failed = outcomes.find((entry) => entry.outcome.kind === "failed");
  if (failed?.outcome.kind === "failed") {
    return failed.outcome.error;
  }
  return undefined;
}

type ResponsesExecutionOutcome =
  | { readonly scope: "reasoning"; readonly value: ResponsesReasoningOutcome }
  | {
      readonly scope: "supplement";
      readonly value: ResponsesProjectionRecord;
    };

export async function executeOpenAIResponsesSemanticInvocation(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly invocation: ResponsesSemanticInvocation;
  readonly infrastructure: ResponsesSemanticExecutionCapabilities;
}): Promise<ResponsesSemanticExecutionResult> {
  if (input.invocation.pi.options.onPayload !== undefined) {
    throw new InvalidResponsesSemanticExecution(
      "Semantic Conversion invocation must not supply onPayload",
    );
  }
  const prepared = prepareResponsesReasoning({
    model: input.model,
    context: input.invocation.pi.context,
    options: input.invocation.pi.options,
    semantics: input.invocation.reasoning,
  });
  const emittedProjectionWarnings = new Set<string>();
  const initialOutcomes: readonly ResponsesExecutionOutcome[] = prepared.outcomes.map(
    (value) => ({ scope: "reasoning", value }),
  );
  const initialFailure = failedProjection(prepared.outcomes);
  const projection: ResponsesPayloadProjectionOperation<ResponsesExecutionOutcome> = {
    initialOutcomes,
    ...(initialFailure === undefined ? {} : { initialFailure }),
    project(payload) {
      const reasoning = projectResponsesReasoningPayload({
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
      const supplement = projectResponsesPayload({
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
      };
    },
  };
  let result;
  try {
    result = await executeWithResponsesPi({
      models: input.models,
      model: input.model,
      pi: { context: prepared.context, options: prepared.options },
      projection,
      infrastructure: input.infrastructure,
    });
  } catch (error) {
    if (error instanceof InvalidResponsesPiExecution) {
      throw new InvalidResponsesSemanticExecution(error.message);
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
