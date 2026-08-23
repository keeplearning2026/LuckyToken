import type { AnthropicSemanticInvocation } from "../invocation.js";
import type { AnthropicProjectionOutcome } from "./contract.js";

function omitted(control: string, warning: string): AnthropicProjectionOutcome {
  return Object.freeze({
    control,
    outcome: Object.freeze({ kind: "omitted" as const, warning }),
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
  if (owns(value, "citations") && value.citations !== null) {
    return "citation provenance has no certified target representation";
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
  if (value.defer_loading === true) {
    return "defer_loading changes whether the tool is initially visible";
  }
  if (owns(value, "type")) {
    return "custom tool type has no certified target representation";
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

/**
 * Resolves Anthropic-owned supplement facts that a non-Anthropic target
 * projector has not certified. It never inspects or mutates Provider payloads.
 */
export function assessUnprojectedAnthropicSupplement(input: {
  readonly invocation: AnthropicSemanticInvocation;
  readonly target: string;
}): AnthropicSupplementDisposition {
  const supplement = input.invocation.supplement;
  if (supplement.finalAssistantPrefill === true) {
    return Object.freeze({
      outcomes: Object.freeze([]),
      failure: `${input.target} has no certified final-assistant prefill continuation mapping`,
    });
  }

  for (const entry of supplement.content) {
    const identity = `content[${entry.sourceMessageIndex}:${entry.sourceContentIndex}]`;
    if (entry.piRepresentation === "none") {
      return Object.freeze({
        outcomes: Object.freeze([]),
        failure: `${input.target} cannot consume Anthropic supplement ${identity} (${entry.kind}); no model-visible Pi representation exists`,
      });
    }
    const hardReason = hardPartialContentReason(entry.value);
    if (hardReason !== undefined) {
      return Object.freeze({
        outcomes: Object.freeze([]),
        failure: `${input.target} cannot preserve Anthropic ${identity}: ${hardReason}`,
      });
    }
  }

  for (const entry of supplement.tools) {
    const identity = `tools[${entry.sourceToolIndex}]`;
    if (entry.piRepresentation === "none") {
      return Object.freeze({
        outcomes: Object.freeze([]),
        failure: `${input.target} has no certified Anthropic server tool mapping for ${identity} (${entry.name})`,
      });
    }
    const hardReason = hardPartialToolReason(entry.value);
    if (hardReason !== undefined) {
      return Object.freeze({
        outcomes: Object.freeze([]),
        failure: `${input.target} cannot preserve Anthropic ${identity}: ${hardReason}`,
      });
    }
  }

  const outcomes: AnthropicProjectionOutcome[] = [];
  for (const entry of supplement.content) {
    outcomes.push(
      omitted(
        `content[${entry.sourceMessageIndex}:${entry.sourceContentIndex}]`,
        `${input.target} retained the Pi-visible ${entry.kind} fallback but omitted Anthropic ${partialContentFields(entry.value).join(", ")}`,
      ),
    );
  }
  for (const entry of supplement.tools) {
    outcomes.push(
      omitted(
        `tools[${entry.sourceToolIndex}]`,
        `${input.target} retained the Pi-visible tool but omitted Anthropic ${partialToolFields(entry.value).join(", ")}`,
      ),
    );
  }
  if (
    supplement.system?.kind === "blocks" &&
    supplement.system.blocks.some((block) => owns(block, "cache_control"))
  ) {
    outcomes.push(
      omitted(
        "system.cacheControl",
        `${input.target} retained system text but omitted Anthropic system cache_control attachment points`,
      ),
    );
  }
  return Object.freeze({ outcomes: Object.freeze(outcomes) });
}
