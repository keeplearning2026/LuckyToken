import {
  createProvider,
  envApiKeyAuth,
  type FetchFunction,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

import {
  DEEPSEEK_RESPONSE_BASE_URL,
  DEEPSEEK_RESPONSE_PROVIDER_ID,
  DEEPSEEK_RESPONSE_PROVIDER_NAME,
} from "./constants.js";
import { DEEPSEEK_RESPONSE_MODELS } from "./models.js";

export interface CreateDeepSeekResponseProviderOptions {
  /** Host fetch fallback; a per-request `fetch` still wins. */
  readonly fetch?: FetchFunction;
}

function bindFetch(
  streams: ProviderStreams,
  fetch: FetchFunction | undefined,
): ProviderStreams {
  if (fetch === undefined) return streams;
  const bound: ProviderStreams = {
    stream: (model, context, options) =>
      streams.stream(model, context, {
        ...options,
        fetch: options?.fetch ?? fetch,
      }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, {
        ...options,
        fetch: options?.fetch ?? fetch,
      }),
  };
  return Object.freeze(bound);
}

/**
 * Builds the `deepseek-response` Provider in memory over the clean Pi
 * Responses adapter. The wire model ids stay `deepseek-flash` /
 * `deepseek-v4-pro`; provider identity separates this lane from the Pi
 * built-in `deepseek` Chat Completions provider.
 */
export function createDeepSeekResponseProvider(
  options: CreateDeepSeekResponseProviderOptions = {},
): Provider<"openai-responses"> {
  return createProvider<"openai-responses">({
    id: DEEPSEEK_RESPONSE_PROVIDER_ID,
    name: DEEPSEEK_RESPONSE_PROVIDER_NAME,
    baseUrl: DEEPSEEK_RESPONSE_BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]),
    },
    models: DEEPSEEK_RESPONSE_MODELS,
    api: bindFetch(openAIResponsesApi(), options.fetch),
  });
}
