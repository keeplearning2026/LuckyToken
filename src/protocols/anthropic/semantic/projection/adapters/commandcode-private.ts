import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
} from "../contract.js";

function add(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  outcome: AnthropicProjectionDisposition,
): void {
  outcomes.push(Object.freeze({ control, outcome: Object.freeze(outcome) }));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exact(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  current: unknown,
  expected: unknown,
  assign: () => void,
): void {
  if (same(current, expected)) {
    add(outcomes, control, { kind: "pi-native" });
    return;
  }
  assign();
  add(outcomes, control, {
    kind: "payload-projected",
    projector: "anthropic-to-commandcode-private",
    warning: "pi-native-mapping-repaired",
  });
}

function omitted(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  warning: string,
): void {
  add(outcomes, control, { kind: "omitted", warning });
}

function degraded(
  outcomes: AnthropicProjectionOutcome[],
  control: string,
  warning: string,
): void {
  add(outcomes, control, { kind: "degraded", warning });
}

function expectedReasoningEffort(
  model: Model<string>,
  level: "low" | "medium" | "high" | "xhigh" | "max",
): string | undefined {
  const explicit = model.thinkingLevelMap?.[level];
  if (explicit === null) return undefined;
  if (typeof explicit === "string") return explicit;
  return level === "low" || level === "medium" || level === "high"
    ? level
    : undefined;
}

interface ProjectionInput {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
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
    const finalMaxTokens = Math.min(params.max_tokens, supplement.outputTokenCeiling);
    exact(outcomes, "maxTokens", params.max_tokens, finalMaxTokens, () => {
      params.max_tokens = finalMaxTokens;
    });
    if (supplement.sampling.temperature !== undefined) {
      if (same(params.temperature, supplement.sampling.temperature)) {
        add(outcomes, "sampling.temperature", { kind: "pi-native" });
      }
    }
    const choice = supplement.toolChoice;
    if (choice?.kind === "none") {
      params.tools = [];
      degraded(
        outcomes,
        "toolChoice",
        "CommandCode Private removed current-request tools; target-level disablement is not guaranteed",
      );
    } else if (choice?.kind === "auto") {
      add(outcomes, "toolChoice", { kind: "pi-native" });
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
    if (
      choice !== undefined &&
      choice.kind !== "none" &&
      choice.disableParallelToolUse
    ) {
      degraded(
        outcomes,
        "toolChoice.disableParallelToolUse",
        "CommandCode Private cannot guarantee serial tool execution",
      );
    }

    if (supplement.outputFormat.kind === "specified") {
      const schema = JSON.stringify(supplement.outputFormat.value.schema);
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
  } else if (reasoning.effort.kind === "specified") {
    if (!input.model.reasoning) {
      omitted(
        outcomes,
        "reasoning.effort",
        "CommandCode Private target model does not support reasoning effort",
      );
    } else {
      const expected = expectedReasoningEffort(input.model, reasoning.effort.level);
      if (expected === undefined) {
        delete params.reasoning_effort;
        omitted(
          outcomes,
          "reasoning.effort",
          `CommandCode Private has no certified ${reasoning.effort.level} effort mapping`,
        );
      } else if (same(params.reasoning_effort, expected)) {
        add(outcomes, "reasoning.effort", { kind: "pi-native" });
      } else {
        delete params.reasoning_effort;
        omitted(
          outcomes,
          "reasoning.effort",
          "Pi did not emit the certified CommandCode Private reasoning effort",
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
