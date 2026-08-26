import type {
  AnthropicCandidateBase,
  AnthropicCandidateId,
  AnthropicProjectionSupplement,
} from "./contract.js";

export interface AnthropicSupplementCandidate {
  readonly id: AnthropicCandidateId;
  readonly description: string;
}

function candidate(
  value: AnthropicCandidateBase & { readonly kind: string },
): AnthropicSupplementCandidate {
  return Object.freeze({
    id: value.id,
    description: `${value.kind} from ${value.source.kind}`,
  });
}

/**
 * Enumerates the fixed, target-independent candidate set. The coordinator uses
 * this only to settle candidates left unconsumed by a positive-only Adapter.
 */
export function enumerateAnthropicSupplementCandidates(
  supplement: AnthropicProjectionSupplement,
): readonly AnthropicSupplementCandidate[] {
  const candidates: AnthropicSupplementCandidate[] = [
    ...Object.values(supplement.controls).map(candidate),
    ...supplement.system.map(candidate),
    ...supplement.content.map(candidate),
    ...supplement.tools.map(candidate),
    ...supplement.cache.map(candidate),
  ];
  const ids = new Set<AnthropicCandidateId>();
  for (const entry of candidates) {
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate Anthropic Supplement Candidate ID: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return Object.freeze(candidates);
}
