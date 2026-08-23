import type {
  Context,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ConversionNotice } from "@luckytoken/provider-contract/diagnostics";

import type { ReasoningSemantics } from "./reasoning/contract.js";
import type { ProjectionSupplement } from "./supplement/contract.js";

export interface SemanticConversionInvocation {
  readonly pi: {
    readonly context: Context;
    readonly options: ModelsSimpleStreamOptions;
  };
  readonly reasoning: ReasoningSemantics;
  readonly supplement: ProjectionSupplement;
}

export interface ClientConversionResult<TRenderState> {
  readonly selector: string;
  readonly invocation: SemanticConversionInvocation;
  readonly client: {
    readonly renderState: TRenderState;
    readonly notices: readonly ConversionNotice[];
  };
}
