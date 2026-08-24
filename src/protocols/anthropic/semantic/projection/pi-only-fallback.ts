import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../invocation.js";
import { selectAnthropicPayloadProjector } from "./registry.js";

export interface PreparedAnthropicPiOnlyFallback {
  readonly invocation: AnthropicSemanticInvocation;
}

function schemaInstruction(schema: Readonly<Record<string, unknown>>): string {
  return `Return one JSON value matching this schema. Conformance is best effort: ${JSON.stringify(schema)}`;
}

/**
 * Applies only model-visible fallbacks that must happen before Pi builds an
 * unaudited target payload. A selected Adapter owns its own target fallback.
 */
export function prepareAnthropicPiOnlyFallback(input: {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
}): PreparedAnthropicPiOnlyFallback {
  if (selectAnthropicPayloadProjector(input.model) !== undefined) {
    return Object.freeze({ invocation: input.invocation });
  }

  const context = structuredClone(input.invocation.pi.context);
  const options = { ...input.invocation.pi.options };
  const choice = input.invocation.supplement.toolChoice;
  if (choice?.kind === "any" || choice?.kind === "named") {
    if (choice.kind === "named" && context.tools !== undefined) {
      context.tools = context.tools.filter((tool) => tool.name === choice.name);
    }
  } else if (choice?.kind === "none") {
    delete context.tools;
  }

  const format = input.invocation.supplement.outputFormat;
  if (format.kind === "specified") {
    const instruction = schemaInstruction(format.value.schema);
    context.systemPrompt = context.systemPrompt === undefined || context.systemPrompt.length === 0
      ? instruction
      : `${context.systemPrompt}\n\n${instruction}`;
  }

  const activation = input.invocation.reasoning.activation;
  if (activation.kind === "disabled") {
    delete options.reasoning;
    delete options.thinkingBudgets;
  } else if (activation.kind === "enabled" || activation.kind === "adaptive") {
    if (!input.model.reasoning) {
      delete options.reasoning;
      delete options.thinkingBudgets;
    }
  }

  return Object.freeze({
    invocation: Object.freeze({
      pi: Object.freeze({ context, options: Object.freeze(options) }),
      reasoning: input.invocation.reasoning,
      supplement: input.invocation.supplement,
    }),
  });
}
