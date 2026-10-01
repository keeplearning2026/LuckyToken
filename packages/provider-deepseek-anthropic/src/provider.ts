import {
  createProvider,
  envApiKeyAuth,
  type FetchFunction,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_ANTHROPIC_PROVIDER_ID,
  DEEPSEEK_ANTHROPIC_PROVIDER_NAME,
} from "./constants.js";
import { DEEPSEEK_ANTHROPIC_MODELS } from "./models.js";

export interface CreateDeepSeekAnthropicProviderOptions {
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
 * Builds the `deepseek-anthropic` Provider in memory over the clean Pi
 * Anthropic Messages adapter. The wire model ids stay `deepseek-flash` /
 * `deepseek-v4-pro`; provider identity separates this lane from the Pi
 * built-in `deepseek` Chat Completions provider.
 */
export function createDeepSeekAnthropicProvider(
  options: CreateDeepSeekAnthropicProviderOptions = {},
): Provider<"anthropic-messages"> {
  return createProvider<"anthropic-messages">({
    id: DEEPSEEK_ANTHROPIC_PROVIDER_ID,
    name: DEEPSEEK_ANTHROPIC_PROVIDER_NAME,
    baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]),
    },
    models: DEEPSEEK_ANTHROPIC_MODELS,
    api: bindFetch(anthropicMessagesApi(), options.fetch),
  });
}
