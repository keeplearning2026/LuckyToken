import type { Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export const codexPiProviderId = "openai-codex";
export const codexPiApiId = "openai-codex-responses";

export interface CodexNativeModelSource {
  has(modelId: string): boolean;
  models(): readonly Model<string>[];
}

/**
 * Codex-native identity is derived from Pi's bundled ChatGPT/Codex provider,
 * never from LuckyToken user overlays and never from a guessed GPT name pattern.
 * Only bare ids on the Codex Responses wire are eligible for client-owned auth
 * passthrough; namespaced ids remain ordinary LuckyToken aliases.
 */
export function createCodexNativeModelSource(
  providers: readonly Provider[] = builtinProviders(),
): CodexNativeModelSource {
  const byId = new Map<string, Model<string>>();
  for (const provider of providers) {
    if (provider.id !== codexPiProviderId) continue;
    for (const model of provider.getModels()) {
      if (
        model.api !== codexPiApiId ||
        model.provider !== codexPiProviderId ||
        model.id.length === 0 ||
        model.id.includes("/")
      ) {
        continue;
      }
      if (!byId.has(model.id)) byId.set(model.id, model as Model<string>);
    }
  }
  const models = Object.freeze([...byId.values()]);
  const ids = new Set(models.map((model) => model.id));
  return Object.freeze({
    has: (modelId: string) => ids.has(modelId),
    models: () => models,
  });
}
