import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicEffortPlan,
  AnthropicSelectedPiEffort,
} from "../../reasoning/contract.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
  AnthropicProjectionOutcomeId,
} from "../contract.js";

function add(
  outcomes: AnthropicProjectionOutcome[],
  candidateId: AnthropicProjectionOutcomeId,
  outcome: AnthropicProjectionDisposition,
): void {
  outcomes.push(Object.freeze({ candidateId, outcome: Object.freeze(outcome) }));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exact(
  outcomes: AnthropicProjectionOutcome[],
  candidateId: AnthropicProjectionOutcomeId,
  current: unknown,
  expected: unknown,
  assign: () => void,
): void {
  if (same(current, expected)) {
    add(outcomes, candidateId, { kind: "pi-native" });
    return;
  }
  assign();
  add(outcomes, candidateId, {
    kind: "payload-projected",
    projector: "anthropic-to-commandcode-private",
    warning: "pi-native-mapping-repaired",
  });
}

function degraded(
  outcomes: AnthropicProjectionOutcome[],
  candidateId: AnthropicProjectionOutcomeId,
  warning: string,
): void {
  add(outcomes, candidateId, { kind: "degraded", warning });
}

function expectedReasoningEffort(
  model: Model<string>,
  level: AnthropicSelectedPiEffort,
): string | undefined {
  const explicit = model.thinkingLevelMap?.[level];
  return typeof explicit === "string" ? explicit : undefined;
}

interface ProjectionInput {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly effortPlan: AnthropicEffortPlan;
  readonly payload: unknown;
}

function projectAnthropicToCommandCodePrivate(
  input: ProjectionInput,
  phase: "reasoning" | "supplement",
): {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
} {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw new Error("commandcode-private payload must be an object");
  }
  const payload = structuredClone(input.payload) as Record<string, unknown>;
  if (
    typeof payload.params !== "object" ||
    payload.params === null ||
    Array.isArray(payload.params)
  ) {
    throw new Error("commandcode-private payload shape mismatch at params");
  }
  const params = { ...(payload.params as Record<string, unknown>) };
  if (
    typeof params.model !== "string" ||
    !Array.isArray(params.messages) ||
    !Array.isArray(params.tools) ||
    params.stream !== true ||
    typeof params.max_tokens !== "number"
  ) {
    throw new Error("commandcode-private params shape mismatch");
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const { reasoning, supplement } = input.invocation;

  if (phase === "supplement") {
    const finalMaxTokens = Math.min(params.max_tokens, supplement.controls.outputTokenCeiling.value);
    exact(outcomes, "maxTokens", params.max_tokens, finalMaxTokens, () => {
      params.max_tokens = finalMaxTokens;
    });
    if (supplement.controls.temperature !== undefined) {
      if (same(params.temperature, supplement.controls.temperature.value)) {
        add(outcomes, "sampling.temperature", { kind: "pi-native" });
      }
    }
    const choice = supplement.controls.toolChoice?.value;
    if (choice?.kind === "none") {
      params.tools = [];
      degraded(
        outcomes,
        "toolChoice",
        "CommandCode Private removed current-request tools; target-level disablement is not guaranteed",
      );
    } else if (choice?.kind === "auto") {
      if (choice.disableParallelToolUse) {
        degraded(
          outcomes,
          "toolChoice",
          "CommandCode Private used automatic selection but cannot guarantee serial tool execution",
        );
      } else {
        add(outcomes, "toolChoice", { kind: "pi-native" });
      }
    } else if (choice?.kind === "any") {
      degraded(
        outcomes,
        "toolChoice",
        "CommandCode Private used automatic selection for required tool choice",
      );
    } else if (choice?.kind === "named") {
      params.tools = (params.tools as Array<Record<string, unknown>>).filter(
        (tool) => tool.name === choice.name,
      );
      degraded(
        outcomes,
        "toolChoice",
        "CommandCode Private exposed only the named tool but cannot guarantee a tool call",
      );
    }
    if (supplement.controls.outputFormat?.value?.kind === "json-schema") {
      const schema = JSON.stringify(supplement.controls.outputFormat.value.schema);
      const instruction = `Return one JSON value matching this schema. Conformance is best effort: ${schema}`;
      params.system = typeof params.system === "string" && params.system.length > 0
        ? `${params.system}\n\n${instruction}`
        : instruction;
      degraded(
        outcomes,
        "outputFormat",
        "CommandCode Private received schema guidance only; conformance is not guaranteed",
      );
    }
  } else if (input.effortPlan.kind === "specified") {
    if (input.effortPlan.selection.kind !== "selected") {
      delete params.reasoning_effort;
      degraded(
        outcomes,
        "reasoning.effort",
        input.effortPlan.selection.kind === "non-reasoning"
          ? "CommandCode Private target does not support reasoning; ordinary generation was retained"
          : "CommandCode Private target exposes no selectable reasoning level; Provider default was retained",
      );
    } else {
      const expected = expectedReasoningEffort(
        input.model,
        input.effortPlan.selection.level,
      );
      if (expected === undefined) {
        delete params.reasoning_effort;
        degraded(
          outcomes,
          "reasoning.effort",
          `CommandCode Private has no certified ${input.effortPlan.selection.level} effort mapping; Provider default was retained`,
        );
      } else if (same(params.reasoning_effort, expected)) {
        add(
          outcomes,
          "reasoning.effort",
          input.effortPlan.requested === input.effortPlan.selection.level
            ? { kind: "pi-native" }
            : {
                kind: "degraded",
                warning: `requested reasoning level ${input.effortPlan.requested} mapped to supported Pi level ${input.effortPlan.selection.level}`,
              },
        );
      } else {
        delete params.reasoning_effort;
        degraded(
          outcomes,
          "reasoning.effort",
          "Pi did not emit the selected CommandCode Private reasoning effort; Provider default was retained",
        );
      }
    }
  } else if (reasoning.effort.kind === "explicit-null" || reasoning.effort.kind === "omitted") {
    const repaired = Object.hasOwn(params, "reasoning_effort");
    delete params.reasoning_effort;
    add(outcomes, "reasoning.effort", repaired
      ? {
          kind: "payload-projected",
          projector: "anthropic-to-commandcode-private",
          warning: "pi-native-mapping-repaired",
        }
      : { kind: "pi-native" });
  }

  payload.params = params;
  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}

export function projectAnthropicToCommandCodePrivateReasoning(
  input: ProjectionInput,
) {
  return projectAnthropicToCommandCodePrivate(input, "reasoning");
}

export function projectAnthropicToCommandCodePrivateSupplement(
  input: ProjectionInput,
) {
  return projectAnthropicToCommandCodePrivate(input, "supplement");
}
