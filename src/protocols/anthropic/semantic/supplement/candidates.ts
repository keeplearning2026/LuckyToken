import type { AnthropicProjectionSupplement } from "./contract.js";

export interface AnthropicSupplementCandidate {
  readonly control: string;
  readonly description: string;
}

function candidate(
  control: string,
  description: string,
): AnthropicSupplementCandidate {
  return Object.freeze({ control, description });
}

function owns(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(value, key);
}

/**
 * Enumerates only facts actually carried by the candidate-only Supplement.
 * Target Adapters never use this list to decide mappings; the coordinator uses
 * it only to account for candidates left unconsumed after projection.
 */
export function enumerateAnthropicSupplementCandidates(
  supplement: AnthropicProjectionSupplement,
): readonly AnthropicSupplementCandidate[] {
  const candidates: AnthropicSupplementCandidate[] = [
    candidate("maxTokens", "the final output-token ceiling"),
  ];

  if (supplement.sampling.temperature !== undefined) {
    candidates.push(candidate("sampling.temperature", "the temperature preference"));
  }
  if (supplement.sampling.topP !== undefined) {
    candidates.push(candidate("sampling.topP", "the top-p preference"));
  }
  if (supplement.sampling.topK !== undefined) {
    candidates.push(candidate("sampling.topK", "the top-k preference"));
  }
  if (supplement.stopSequences !== undefined) {
    candidates.push(candidate("stopSequences", "the stop-sequence preference"));
  }
  if (supplement.toolChoice !== undefined) {
    candidates.push(candidate("toolChoice", "the tool-choice control"));
    if (
      supplement.toolChoice.kind !== "none" &&
      supplement.toolChoice.disableParallelToolUse
    ) {
      candidates.push(candidate(
        "toolChoice.disableParallelToolUse",
        "the serial-tool-use preference",
      ));
    }
  }
  if (supplement.outputFormat.kind !== "omitted") {
    candidates.push(candidate("outputFormat", "the structured-output preference"));
  }
  if (supplement.metadataUserId.kind !== "omitted") {
    candidates.push(candidate("metadataUserId", "the end-user identity metadata"));
  }
  if (supplement.serviceTier.kind !== "omitted") {
    candidates.push(candidate("serviceTier", "the service-tier preference"));
  }
  if (supplement.inferenceGeo.kind !== "omitted") {
    candidates.push(candidate("inferenceGeo", "the inference-geography preference"));
  }
  if (supplement.container.kind !== "omitted") {
    candidates.push(candidate("container", "the container-affinity preference"));
  }
  if (supplement.cacheControl.kind !== "omitted") {
    candidates.push(candidate("cacheControl", "the top-level cache-control preference"));
  }
  if (supplement.system?.kind === "blocks") {
    candidates.push(candidate("system", "the structured system blocks"));
    if (supplement.system.blocks.some((block) => owns(block, "cache_control"))) {
      candidates.push(candidate(
        "system.cacheControl",
        "the system-block cache-control attachment points",
      ));
    }
  }
  if (supplement.finalAssistantPrefill === true) {
    candidates.push(candidate(
      "finalAssistantPrefill",
      "the final-assistant continuation preference",
    ));
  }
  for (const entry of supplement.content) {
    const fields = Object.keys(entry.value).join(", ");
    candidates.push(candidate(
      `content[${entry.sourceMessageIndex}:${entry.sourceContentIndex}]`,
      `the ${entry.kind} content candidate (${fields}) at messages[${entry.sourceMessageIndex}].content[${entry.sourceContentIndex}]`,
    ));
  }
  for (const entry of supplement.tools) {
    const fields = Object.keys(entry.value).join(", ");
    candidates.push(candidate(
      `tools[${entry.sourceToolIndex}]`,
      `the ${entry.kind} tool candidate (${fields}) at tools[${entry.sourceToolIndex}]`,
    ));
  }

  return Object.freeze(candidates);
}
