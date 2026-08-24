import type { Model } from "@earendil-works/pi-ai";

import type { ResponsesToolChoice } from "../supplement/contract.js";

const FORCED_TOOL_CHOICE_RESTRICTIONS = new Map<string, string>([
  [
    "commandcode-goat\u0000openai-completions\u0000deepseek/deepseek-v4-flash",
    "CommandCode Goat deepseek-v4-flash thinking mode does not support forced tool_choice",
  ],
]);

function modelKey(model: Model<string>): string {
  return `${model.provider}\u0000${model.api}\u0000${model.id}`;
}

/** Return an exact online-certified target restriction, never an inferred one. */
export function forcedToolChoiceRestriction(
  model: Model<string>,
  choice: ResponsesToolChoice,
): string | undefined {
  if (choice.kind !== "required" && choice.kind !== "named") return undefined;
  return FORCED_TOOL_CHOICE_RESTRICTIONS.get(modelKey(model));
}
