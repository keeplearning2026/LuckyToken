import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { LuckyTokenAnthropicContinuityEnvelopeV1 } from "../reasoning/continuity.js";

export interface AnthropicInterpretedResponse {
  readonly message: AssistantMessage;
  readonly continuityByContentIndex: ReadonlyMap<
    number,
    LuckyTokenAnthropicContinuityEnvelopeV1
  >;
  readonly nativeThinkingIndexes: ReadonlySet<number>;
  readonly stop: {
    readonly reason: "end_turn" | "max_tokens" | "tool_use";
    readonly normalized: boolean;
  };
  readonly unavailable: {
    readonly textCitations: boolean;
    readonly responsePaths: readonly string[];
  };
  readonly interpreter: string;
}
