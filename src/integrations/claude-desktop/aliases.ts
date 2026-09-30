import type { AgentInjectionModel } from "../agents/snapshot.js";
import { markAnthropicModelId } from "../../protocols/anthropic/marked-model-id.js";

export function projectClaudeDesktopModels(models: readonly AgentInjectionModel[]): {
  readonly inferenceModels: readonly Record<string, unknown>[];
} {
  const inferenceModels = models.map((model) => {
    const name = markAnthropicModelId(model.alias);
    return Object.freeze({
      name,
      labelOverride: model.alias,
    });
  });
  return Object.freeze({
    inferenceModels: Object.freeze(inferenceModels),
  });
}

