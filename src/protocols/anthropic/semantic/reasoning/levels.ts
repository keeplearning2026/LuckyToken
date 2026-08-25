import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

import type {
  AnthropicEffortIntent,
  AnthropicEffortPlan,
  AnthropicSelectedPiEffort,
} from "./contract.js";

function isSelectable(
  level: ModelThinkingLevel,
): level is AnthropicSelectedPiEffort {
  return level !== "off";
}

export function resolveAnthropicEffortPlan<TApi extends string>(
  model: Model<TApi>,
  intent: AnthropicEffortIntent,
): AnthropicEffortPlan {
  if (intent.kind !== "specified") {
    return Object.freeze({ kind: intent.kind });
  }

  let selection: Extract<AnthropicEffortPlan, { kind: "specified" }>["selection"];
  if (!model.reasoning) {
    selection = Object.freeze({ kind: "non-reasoning" });
  } else {
    const supported = getSupportedThinkingLevels(model).filter(isSelectable);
    if (supported.length === 0) {
      selection = Object.freeze({ kind: "no-selectable-level" });
    } else {
      const selected = clampThinkingLevel(model, intent.level);
      selection = isSelectable(selected) && supported.includes(selected)
        ? Object.freeze({ kind: "selected", level: selected })
        : Object.freeze({ kind: "no-selectable-level" });
    }
  }

  return Object.freeze({
    kind: "specified",
    requested: intent.level,
    selection,
  });
}
