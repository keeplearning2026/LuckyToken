import type { AnthropicSemanticInvocation } from "../invocation.js";
import type { AnthropicProjectionOutcome } from "./contract.js";

function omitted(control: string, warning: string): AnthropicProjectionOutcome {
  return Object.freeze({
    control,
    outcome: Object.freeze({ kind: "omitted" as const, warning }),
  });
}

function degraded(control: string, warning: string): AnthropicProjectionOutcome {
  return Object.freeze({
    control,
    outcome: Object.freeze({ kind: "degraded" as const, warning }),
  });
}

function piNative(control: string): AnthropicProjectionOutcome {
  return Object.freeze({
    control,
    outcome: Object.freeze({ kind: "pi-native" as const }),
  });
}

function owns(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function nestedBlocks(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Readonly<Record<string, unknown>> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function hardPartialContentReason(
  value: Readonly<Record<string, unknown>>,
): string | undefined {
  const caller = value.caller;
  const directCaller =
    typeof caller === "object" &&
    caller !== null &&
    !Array.isArray(caller) &&
    (caller as Readonly<Record<string, unknown>>).type === "direct";
  if (value.type === "tool_use" && owns(value, "caller") && !directCaller) {
    return "tool-use caller identity changes permissions or tool relationships";
  }
  if (value.type !== "tool_result") return undefined;
  for (const nested of nestedBlocks(value.content)) {
    if (nested.type === "tool_reference") {
      return "tool_reference changes the available tool relationship";
    }
    if (nested.type === "image") {
      const source = nested.source;
      if (
        typeof source === "object" &&
        source !== null &&
        !Array.isArray(source) &&
        (source as Readonly<Record<string, unknown>>).type === "url"
      ) {
        return "URL image bytes are absent from Pi IR";
      }
    }
    if (nested.type === "document") {
      const source = nested.source;
      if (
        typeof source === "object" &&
        source !== null &&
        !Array.isArray(source) &&
        ["url", "base64"].includes(
          String((source as Readonly<Record<string, unknown>>).type),
        )
      ) {
        return "document bytes are absent from Pi IR";
      }
    }
  }
  return undefined;
}

function partialContentFields(
  value: Readonly<Record<string, unknown>>,
): readonly string[] {
  const baseline: Readonly<Record<string, readonly string[]>> = {
    text: ["type", "text"],
    thinking: ["type", "thinking", "signature"],
    redacted_thinking: ["type", "data"],
    image: ["type", "source"],
    tool_use: ["type", "id", "name", "input", "caller"],
    tool_result: ["type", "tool_use_id", "content", "is_error"],
  };
  const allowed = new Set(baseline[String(value.type)] ?? ["type"]);
  const fields = Object.keys(value).filter((key) => !allowed.has(key));
  return fields.length === 0 ? [String(value.type)] : fields;
}

function hardPartialToolReason(
  value: Readonly<Record<string, unknown>>,
): string | undefined {
  if (owns(value, "allowed_callers")) {
    return "allowed_callers changes tool permissions";
  }
  return undefined;
}

function partialToolFields(
  value: Readonly<Record<string, unknown>>,
): readonly string[] {
  const allowed = new Set(["name", "description", "input_schema", "strict"]);
  return Object.keys(value).filter((key) => !allowed.has(key));
}

export interface AnthropicSupplementDisposition {
  readonly outcomes: readonly AnthropicProjectionOutcome[];
  readonly failure?: string;
}

/** Resolves only facts left unconsumed after the selected target Adapter. */
export function assessUnprojectedAnthropicSupplement(input: {
  readonly invocation: AnthropicSemanticInvocation;
  readonly target: string;
  readonly targetSupportsReasoning: boolean;
  readonly resolvedControls?: ReadonlySet<string>;
}): AnthropicSupplementDisposition {
  const supplement = input.invocation.supplement;
  const resolved = input.resolvedControls ?? new Set<string>();
  const outcomes: AnthropicProjectionOutcome[] = [];
  const fail = (failure: string): AnthropicSupplementDisposition =>
    Object.freeze({ outcomes: Object.freeze(outcomes), failure });

  if (
    supplement.finalAssistantPrefill === true &&
    !resolved.has("finalAssistantPrefill")
  ) {
    outcomes.push(degraded(
      "finalAssistantPrefill",
      `${input.target} retained the prefix as ordinary assistant history; exact continuation is not guaranteed`,
    ));
  }

  for (const entry of supplement.content) {
    const identity = `content[${entry.sourceMessageIndex}:${entry.sourceContentIndex}]`;
    if (resolved.has(identity)) continue;
    if (entry.piRepresentation === "none") {
      return fail(
        `${input.target} cannot consume Anthropic supplement ${identity} (${entry.kind}); no model-visible Pi representation exists`,
      );
    }
    const hardReason = hardPartialContentReason(entry.value);
    if (hardReason !== undefined) {
      return fail(`${input.target} cannot preserve Anthropic ${identity}: ${hardReason}`);
    }
  }

  for (const entry of supplement.tools) {
    const identity = `tools[${entry.sourceToolIndex}]`;
    if (resolved.has(identity)) continue;
    if (entry.piRepresentation === "none") {
      return fail(
        `${input.target} has no certified Anthropic server tool mapping for ${identity} (${entry.name})`,
      );
    }
    const hardReason = hardPartialToolReason(entry.value);
    if (hardReason !== undefined) {
      return fail(`${input.target} cannot preserve Anthropic ${identity}: ${hardReason}`);
    }
  }

  for (const entry of supplement.content) {
    const control = `content[${entry.sourceMessageIndex}:${entry.sourceContentIndex}]`;
    if (resolved.has(control)) continue;
    outcomes.push(omitted(
      control,
      `${input.target} retained the Pi-visible ${entry.kind} fallback but omitted Anthropic ${partialContentFields(entry.value).join(", ")}`,
    ));
  }
  for (const entry of supplement.tools) {
    const control = `tools[${entry.sourceToolIndex}]`;
    if (resolved.has(control)) continue;
    outcomes.push(omitted(
      control,
      `${input.target} retained the Pi-visible tool but omitted Anthropic ${partialToolFields(entry.value).join(", ")}`,
    ));
  }
  if (
    supplement.system?.kind === "blocks" &&
    !resolved.has("system.cacheControl") &&
    supplement.system.blocks.some((block) => owns(block, "cache_control"))
  ) {
    outcomes.push(omitted(
      "system.cacheControl",
      `${input.target} retained system text but omitted Anthropic system cache_control attachment points`,
    ));
  }

  if (supplement.stopSequences !== undefined && !resolved.has("stopSequences")) {
    outcomes.push(omitted(
      "stopSequences",
      `${input.target} has no proven stop-sequence request field; the control was omitted`,
    ));
  }

  const choice = supplement.toolChoice;
  if (choice !== undefined && !resolved.has("toolChoice")) {
    if (choice.kind === "any" || choice.kind === "named") {
      outcomes.push(degraded(
        "toolChoice",
        `${input.target} used automatic tool selection; the requested forced choice is not guaranteed`,
      ));
    } else if (choice.kind === "none") {
      outcomes.push(degraded(
        "toolChoice",
        `${input.target} removed controllable current-request tools; target-level disablement is not guaranteed`,
      ));
    } else {
      outcomes.push(piNative("toolChoice"));
    }
  }
  if (
    choice !== undefined &&
    choice.kind !== "none" &&
    choice.disableParallelToolUse &&
    !resolved.has("toolChoice.disableParallelToolUse")
  ) {
    outcomes.push(degraded(
      "toolChoice.disableParallelToolUse",
      `${input.target} may execute tools in parallel`,
    ));
  }

  if (
    supplement.outputFormat.kind === "specified" &&
    !resolved.has("outputFormat")
  ) {
    outcomes.push(degraded(
      "outputFormat",
      `${input.target} received only best-effort JSON/schema guidance; schema conformance is not guaranteed`,
    ));
  }

  for (const [control, intent, warning] of [
    ["metadataUserId", supplement.metadataUserId, `${input.target} omitted end-user identity metadata`],
    ["serviceTier", supplement.serviceTier, `${input.target} omitted service-tier preference`],
    ["container", supplement.container, `${input.target} omitted container affinity`],
    ["cacheControl", supplement.cacheControl, `${input.target} omitted cache-control preference`],
  ] as const) {
    if (intent.kind === "specified" && !resolved.has(control)) {
      outcomes.push(omitted(control, warning));
    }
  }
  for (const [control, value, warning] of [
    ["sampling.topP", supplement.sampling.topP, `${input.target} omitted top-p preference`],
    ["sampling.topK", supplement.sampling.topK, `${input.target} omitted top-k preference`],
  ] as const) {
    if (value !== undefined && !resolved.has(control)) {
      outcomes.push(omitted(control, warning));
    }
  }

  if (
    supplement.inferenceGeo.kind === "specified" &&
    !resolved.has("inferenceGeo")
  ) {
    return fail(`${input.target} has no certified inference geography control`);
  }

  const activation = input.invocation.reasoning.activation;
  if (activation.kind !== "omitted" && !resolved.has("reasoning.activation")) {
    if (activation.kind === "disabled" && !input.targetSupportsReasoning) {
      outcomes.push(piNative("reasoning.activation"));
    } else if (activation.kind === "disabled") {
      outcomes.push(degraded(
        "reasoning.activation",
        `${input.target} used its reasoning default after LuckyToken removed known enabling controls`,
      ));
    } else {
      outcomes.push(degraded(
        "reasoning.activation",
        input.targetSupportsReasoning
          ? `${input.target} used the nearest Pi-supported reasoning mode; the exact Anthropic ${activation.kind} mode is not guaranteed`
          : `${input.target} does not support reasoning and used ordinary generation`,
      ));
    }
  }

  const effort = input.invocation.reasoning.effort;
  if (effort.kind === "specified" && !resolved.has("reasoning.effort")) {
    outcomes.push(omitted(
      "reasoning.effort",
      input.targetSupportsReasoning
        ? `${input.target} has no certified reasoning-effort mapping`
        : `${input.target} does not support reasoning effort`,
    ));
  }
  return Object.freeze({ outcomes: Object.freeze(outcomes) });
}
