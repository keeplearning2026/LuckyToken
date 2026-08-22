import type { Api, Model } from "@earendil-works/pi-ai";

import type { CommandCodeModelFacts } from "./models.js";

export interface CommandCodeModelProjection<TApi extends Api> {
  readonly provider: string;
  readonly api: TApi;
  readonly baseUrl: string;
}

const UNTRACKED_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

function projectThinkingLevels(
  facts: CommandCodeModelFacts,
): Readonly<Record<string, string | null>> | undefined {
  if (!facts.reasoning) return undefined;
  const result: Record<string, string | null> = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  for (const effort of facts.reasoningEfforts ?? []) result[effort] = effort;
  return Object.freeze(result);
}

/** Project one provider-independent CommandCode fact into a Pi Model. */
export function projectCommandCodeModel<TApi extends Api>(
  facts: CommandCodeModelFacts,
  projection: CommandCodeModelProjection<TApi>,
): Model<TApi> {
  const thinkingLevelMap = projectThinkingLevels(facts);
  const input: Array<"text" | "image"> = [...facts.input];
  Object.freeze(input);
  return Object.freeze({
    id: facts.id,
    name: facts.name,
    api: projection.api,
    provider: projection.provider,
    baseUrl: projection.baseUrl,
    reasoning: facts.reasoning,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    input,
    cost: UNTRACKED_COST,
    contextWindow: facts.contextWindow,
    maxTokens: facts.maxOutputTokens ?? 64_000,
  });
}
