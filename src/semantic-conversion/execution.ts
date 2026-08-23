import type {
  AssistantMessage,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@luckytoken/provider-contract/diagnostics";

import {
  execute,
  freezePiInvocation,
  type ExecutionOperation,
} from "../execution.js";
import type { SemanticConversionInvocation } from "./contract.js";
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

function assertNoFailedProjection(
  outcomes: readonly { readonly outcome: ProjectionOutcome }[],
): void {
  const failed = outcomes.find((entry) => entry.outcome.kind === "failed");
  if (failed?.outcome.kind === "failed") {
    throw new InvalidSemanticExecution(failed.outcome.error);
  }
}

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
  let reasoningOutcomes: readonly ReasoningOutcome[] = prepared.outcomes;
  let supplementOutcomes: readonly SupplementProjectionOutcome[] = [];
  let payloadProjected = false;
  const emittedProjectionWarnings = new Set<string>();
  const options: ModelsSimpleStreamOptions = {
    ...prepared.options,
    onPayload(payload) {
      payloadProjected = true;
      const reasoning = projectReasoningPayload({
        model: input.model,
        prepared,
        payload,
      });
      reasoningOutcomes = reasoning.outcomes;
      publishProjectionWarnings(
        "reasoning",
        reasoning.outcomes,
        input.infrastructure.factsSink,
        emittedProjectionWarnings,
      );
      assertNoFailedProjection(reasoning.outcomes);
      const supplement = projectSupplementPayload({
        model: input.model,
        payload: reasoning.payload,
        supplement: input.invocation.supplement,
        reasoning: input.invocation.reasoning.request,
      });
      supplementOutcomes = supplement.outcomes;
      publishProjectionWarnings(
        "supplement",
        supplement.outcomes,
        input.infrastructure.factsSink,
        emittedProjectionWarnings,
      );
      assertNoFailedProjection(supplement.outcomes);
      return supplement.payload;
    },
  };
  freezePiInvocation(input.model, prepared.context, options);
  const operation = input.infrastructure.executeOperation ?? execute;
  const message = await operation(
    input.models,
    input.model,
    prepared.context,
    options,
    input.infrastructure.factsSink,
  );
  if (!payloadProjected) {
    throw new InvalidSemanticExecution(
      `Pi API ${input.model.api} completed without invoking the wrapper-owned onPayload seam`,
    );
  }
  return Object.freeze({
    message,
    reasoningOutcomes: Object.freeze([...reasoningOutcomes]),
    supplementOutcomes: Object.freeze([...supplementOutcomes]),
  });
}
