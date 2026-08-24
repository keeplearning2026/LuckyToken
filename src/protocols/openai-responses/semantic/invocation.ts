import type {
  Context,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ConversionNotice } from "@luckytoken/provider-contract/diagnostics";

import type { ResponsesReasoningSemantics } from "./reasoning/contract.js";
import type { ResponsesProjectionSupplement } from "./supplement/contract.js";

export interface ResponsesSemanticInvocation {
  readonly pi: {
    readonly context: Context;
    readonly options: ModelsSimpleStreamOptions;
  };
  readonly reasoning: ResponsesReasoningSemantics;
  readonly supplement: ResponsesProjectionSupplement;
}

export interface ResponsesConversionResult<TRenderState> {
  readonly selector: string;
  readonly invocation: ResponsesSemanticInvocation;
  readonly client: {
    readonly renderState: TRenderState;
    readonly notices: readonly ConversionNotice[];
  };
}
