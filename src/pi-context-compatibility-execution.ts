import type { ExecutionFactsSink } from "@token/provider-contract/diagnostics";

import {
  freezePiInvocation,
  type ExecutionOperation,
} from "./execution.js";
import { preparePiContextForModel } from "./pi-context-compatibility.js";

function publishCompatibilityWarnings(
  outcomes: readonly { readonly code: "pi_mid_system_degraded_to_user" }[],
  factsSink: ExecutionFactsSink | undefined,
): void {
  for (const outcome of outcomes) {
    try {
      factsSink?.notice({
        adapter: "pi-context-compatibility",
        direction: "request",
        code: outcome.code,
        action: "degrade",
      });
    } catch {
      // Diagnostics are fail-open and cannot affect semantic execution.
    }
  }
}

/**
 * The single Semantic Conversion execution seam that adapts public Pi Context
 * to the resolved model before any credential-bound Provider attempts begin.
 */
export function createPiContextCompatibleExecution(
  next: ExecutionOperation,
): ExecutionOperation {
  return async (
    models,
    model,
    context,
    options,
    factsSink,
    observation,
  ) => {
    const compatible = preparePiContextForModel(model, context);
    publishCompatibilityWarnings(compatible.outcomes, factsSink);
    freezePiInvocation(model, compatible.context, options);
    return next(
      models,
      model,
      compatible.context,
      options,
      factsSink,
      observation,
    );
  };
}
