import { enumerateAnthropicSupplementCandidates } from "../supplement/candidates.js";
import type {
  AnthropicCandidateId,
  AnthropicProjectionSupplement,
} from "../supplement/contract.js";
import type { AnthropicProjectionOutcome } from "./contract.js";

function omitted(
  candidateId: AnthropicCandidateId,
  warning: string,
): AnthropicProjectionOutcome {
  return Object.freeze({
    candidateId,
    outcome: Object.freeze({ kind: "omitted" as const, warning }),
  });
}

/** Resolves only candidate facts left unconsumed by the selected target Adapter. */
export function assessUnprojectedAnthropicSupplement(input: {
  readonly supplement: AnthropicProjectionSupplement;
  readonly target: string;
  readonly resolvedCandidateIds?: ReadonlySet<AnthropicCandidateId>;
}): readonly AnthropicProjectionOutcome[] {
  const resolved = input.resolvedCandidateIds ?? new Set<AnthropicCandidateId>();
  return Object.freeze(
    enumerateAnthropicSupplementCandidates(input.supplement)
      .filter((candidate) => !resolved.has(candidate.id))
      .map((candidate) => omitted(
        candidate.id,
        `${input.target} omitted ${candidate.description}`,
      )),
  );
}
