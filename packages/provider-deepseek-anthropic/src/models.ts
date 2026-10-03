import type { Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_ANTHROPIC_PROVIDER_ID } from "./constants.js";

// Pi owns catalog facts. Token selects its supported ids and adapts the API.
const catalog = deepseekProvider().getModels();
export const DEEPSEEK_ANTHROPIC_MODELS: readonly Model<"anthropic-messages">[] = Object.freeze(
  ["deepseek-flash", "deepseek-v4-pro"].map((id): Model<"anthropic-messages"> => {
    const source = catalog.find((model) => model.id === id);
    if (!source) throw new Error(`Pi DeepSeek catalog is missing supported model: ${id}`);
    return {
      ...source,
      api: "anthropic-messages",
      provider: DEEPSEEK_ANTHROPIC_PROVIDER_ID,
      baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
      compat: {
        forceAdaptiveThinking: true,
        supportsLongCacheRetention: false,
      },
    };
  }),
);
