import type { Model } from "@earendil-works/pi-ai";
import type { ExecutionFactsSink } from "@luckytoken/provider-contract/diagnostics";

import type { AnthropicSemanticInvocation } from "../invocation.js";
import { enumerateAnthropicSupplementCandidates } from "../supplement/candidates.js";
import type {
  AnthropicPayloadProjectionOperation,
  AnthropicPayloadProjectionResult,
  AnthropicProjectionOutcome,
} from "./contract.js";
import { selectAnthropicTargetAdapter } from "./registry.js";
import { assessUnprojectedAnthropicSupplement } from "./supplement-disposition.js";

function unresolvedReasoningOutcomes(
  model: Model<string>,
  invocation: AnthropicSemanticInvocation,
): readonly AnthropicProjectionOutcome[] {
  const outcomes: AnthropicProjectionOutcome[] = [];
  const activation = invocation.reasoning.activation;
  if (activation.kind === "disabled") {
    outcomes.push(Object.freeze({
      control: "reasoning.activation",
      outcome: Object.freeze(
        model.reasoning
          ? {
              kind: "degraded" as const,
              warning:
                "the target has no certified reasoning Adapter; known Pi controls were left unchanged and exact disablement is not proved",
            }
          : { kind: "pi-native" as const },
      ),
    }));
  } else if (activation.kind === "enabled" || activation.kind === "adaptive") {
    outcomes.push(Object.freeze({
      control: "reasoning.activation",
      outcome: Object.freeze({
        kind: "degraded" as const,
        warning: model.reasoning
          ? `the target has no certified ${activation.kind} reasoning mapping; Pi target defaults were retained`
          : "the target model does not support reasoning; ordinary generation was retained",
      }),
    }));
  }
  if (invocation.reasoning.effort.kind === "specified") {
    outcomes.push(Object.freeze({
      control: "reasoning.effort",
      outcome: Object.freeze({
        kind: "omitted" as const,
        warning: "the target has no certified reasoning-effort verifier",
      }),
    }));
  }
  return Object.freeze(outcomes);
}

export function publishAnthropicProjectionWarnings(
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
          : disposition.kind === "degraded"
            ? {
                adapter: "anthropic-messages",
                code: "anthropic_semantic_projection_degraded",
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

function finalizeProjection(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly result: AnthropicPayloadProjectionResult;
  readonly factsSink?: ExecutionFactsSink;
}): AnthropicPayloadProjectionResult {
  const candidates = enumerateAnthropicSupplementCandidates(
    input.invocation.supplement,
  );
  const candidateControls = new Set(
    candidates.map((candidate) => candidate.control),
  );
  const outcomeByControl = new Map<string, AnthropicProjectionOutcome>();
  for (const outcome of input.result.outcomes) {
    if (outcomeByControl.has(outcome.control)) {
      throw new Error(
        `Anthropic target Adapter produced duplicate outcome ownership for ${outcome.control}`,
      );
    }
    outcomeByControl.set(outcome.control, outcome);
  }

  const omitted = assessUnprojectedAnthropicSupplement({
    supplement: input.invocation.supplement,
    target: `${input.model.provider}/${input.model.api}/${input.model.id}`,
    resolvedControls: new Set(outcomeByControl.keys()),
  });
  const omittedByControl = new Map(
    omitted.map((outcome) => [outcome.control, outcome]),
  );
  const outcomes = Object.freeze([
    ...candidates.map((candidate) =>
      outcomeByControl.get(candidate.control) ??
      omittedByControl.get(candidate.control)!,
    ),
    ...input.result.outcomes.filter(
      (outcome) => !candidateControls.has(outcome.control),
    ),
  ]);
  publishAnthropicProjectionWarnings(outcomes, input.factsSink);
  return Object.freeze({
    payload: input.result.payload,
    outcomes,
  });
}

export function prepareAnthropicPayloadProjection(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly factsSink?: ExecutionFactsSink;
}): AnthropicPayloadProjectionOperation {
  const adapter = selectAnthropicTargetAdapter(input.model);

  return Object.freeze({
    initialOutcomes: Object.freeze([]),
    async project(payload: unknown, model: Model<string>) {
      let currentPayload = payload;
      const outcomes: AnthropicProjectionOutcome[] = adapter === undefined
        ? [...unresolvedReasoningOutcomes(model, input.invocation)]
        : [];
      const candidateControls = new Set(
        enumerateAnthropicSupplementCandidates(input.invocation.supplement)
          .map((candidate) => candidate.control),
      );

      for (const phase of [
        { kind: "supplement" as const, project: adapter?.projectSupplement },
        { kind: "reasoning" as const, project: adapter?.projectReasoning },
      ]) {
        if (phase.project === undefined) continue;
        const result = await phase.project({
          model,
          invocation: input.invocation,
          payload: currentPayload,
        });
        for (const outcome of result.outcomes) {
          const valid = phase.kind === "supplement"
            ? candidateControls.has(outcome.control)
            : outcome.control.startsWith("reasoning.");
          if (!valid) {
            throw new Error(
              `Anthropic ${adapter?.id ?? "unknown"} ${phase.kind} projector claimed an unowned control: ${outcome.control}`,
            );
          }
        }
        currentPayload = result.payload;
        outcomes.push(...result.outcomes);
      }

      return finalizeProjection({
        model,
        invocation: input.invocation,
        result: {
          payload: currentPayload,
          outcomes: Object.freeze(outcomes),
        },
        ...(input.factsSink === undefined ? {} : { factsSink: input.factsSink }),
      });
    },
  });
}
