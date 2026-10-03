import type { Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import { DEEPSEEK_RESPONSE_BASE_URL, DEEPSEEK_RESPONSE_PROVIDER_ID } from "./constants.js";

// Pi owns catalog facts. Token selects its supported ids and adapts the API.
const catalog = deepseekProvider().getModels();
export const DEEPSEEK_RESPONSE_MODELS: readonly Model<"openai-responses">[] = Object.freeze(
  ["deepseek-flash", "deepseek-v4-pro"].map((id): Model<"openai-responses"> => {
    const source = catalog.find((model) => model.id === id);
    if (!source) throw new Error(`Pi DeepSeek catalog is missing supported model: ${id}`);
    return {
      ...source,
      api: "openai-responses",
      provider: DEEPSEEK_RESPONSE_PROVIDER_ID,
      baseUrl: DEEPSEEK_RESPONSE_BASE_URL,
      compat: {
        supportsDeveloperRole: false,
        supportsLongCacheRetention: false,
        ...(source.compat?.supportsMidConvoSystemMessages === undefined
          ? {}
          : { supportsMidConvoSystemMessages: source.compat.supportsMidConvoSystemMessages }),
      },
    };
  }),
);
