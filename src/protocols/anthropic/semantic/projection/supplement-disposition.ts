import { enumerateAnthropicSupplementCandidates } from "../supplement/candidates.js";
import type { AnthropicProjectionSupplement } from "../supplement/contract.js";
import type { AnthropicProjectionOutcome } from "./contract.js";

function omitted(control: string, warning: string): AnthropicProjectionOutcome {
  return Object.freeze({
    control,
    outcome: Object.freeze({ kind: "omitted" as const, warning }),
  });
}

/** Resolves only candidate facts left unconsumed by the selected target Adapter. */
export function assessUnprojectedAnthropicSupplement(input: {
  readonly supplement: AnthropicProjectionSupplement;
  readonly target: string;
  readonly resolvedControls?: ReadonlySet<string>;
}): readonly AnthropicProjectionOutcome[] {
  const resolved = input.resolvedControls ?? new Set<string>();
  return Object.freeze(
    enumerateAnthropicSupplementCandidates(input.supplement)
      .filter((candidate) => !resolved.has(candidate.control))
      .map((candidate) => omitted(
        candidate.control,
        `${input.target} omitted ${candidate.description}`,
      )),
  );
}
