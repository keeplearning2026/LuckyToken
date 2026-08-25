import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

import type {
  ResponsesEffortPlan,
  ResponsesReasoningEffortIntent,
  ResponsesReasoningEffortLevel,
} from "./contract.js";

function isEnabledLevel(
  level: ModelThinkingLevel,
): level is ResponsesReasoningEffortLevel {
  return level !== "off";
}

export function resolveResponsesEffortPlan<TApi extends string>(
  model: Model<TApi>,
  intent: ResponsesReasoningEffortIntent,
): ResponsesEffortPlan {
  if (intent.kind !== "enabled") {
    return Object.freeze({ kind: intent.kind });
  }

  let selection: Extract<ResponsesEffortPlan, { kind: "enabled" }>["selection"];
  if (!model.reasoning) {
    selection = Object.freeze({ kind: "non-reasoning" });
  } else {
    const supported = getSupportedThinkingLevels(model).filter(isEnabledLevel);
    if (supported.length === 0) {
      selection = Object.freeze({ kind: "no-selectable-level" });
    } else {
      const selected = clampThinkingLevel(model, intent.level);
      selection = isEnabledLevel(selected) && supported.includes(selected)
        ? Object.freeze({ kind: "selected", level: selected })
        : Object.freeze({ kind: "no-selectable-level" });
    }
  }

  return Object.freeze({
    kind: "enabled",
    requested: intent.level,
    selection,
  });
}
