import type {
  Context,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ConversionNotice } from "@token/provider-contract/diagnostics";

import type { AnthropicRequestRenderState } from "../request.js";
import type { AnthropicReasoningSemantics } from "./reasoning/contract.js";
import type { AnthropicProjectionSupplement } from "./supplement/contract.js";

export interface AnthropicSemanticInvocation {
  readonly pi: {
    readonly context: Context;
    readonly options: ModelsSimpleStreamOptions;
  };
  readonly reasoning: AnthropicReasoningSemantics;
  readonly supplement: AnthropicProjectionSupplement;
}

export interface AnthropicConversionResult {
  readonly selector: string;
  readonly invocation: AnthropicSemanticInvocation;
  readonly client: {
    readonly renderState: AnthropicRequestRenderState;
    readonly notices: readonly ConversionNotice[];
  };
}
