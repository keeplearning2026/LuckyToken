import {
  createProvider,
  type FetchFunction,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import {
  COMMANDCODE_GOAT_API_ID,
  COMMANDCODE_GOAT_BASE_URL,
  COMMANDCODE_GOAT_PROVIDER_ID,
} from "./constants.js";
import { COMMANDCODE_GOAT_MODELS } from "./models.js";
import { bindUpstreamFailureDiagnostics } from "./stream-diagnostics.js";

export interface CommandCodeGoatProviderOptions {
  /** Optional deployment fallback. A Pi-stored login credential takes precedence. */
  readonly apiKey?: string;
  readonly fetch?: FetchFunction;
}

function bindFetch(
  streams: ProviderStreams,
  fetch: FetchFunction | undefined,
): ProviderStreams {
  if (fetch === undefined) return streams;
  const bound: ProviderStreams = {
    stream: (model, context, options) =>
      streams.stream(model, context, { ...options, fetch: options?.fetch ?? fetch }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, {
        ...options,
        fetch: options?.fetch ?? fetch,
      }),
  };
  return Object.freeze(bound);
}

export function createCommandCodeGoatProvider(
  options: CommandCodeGoatProviderOptions = {},
): Provider<typeof COMMANDCODE_GOAT_API_ID> {
  const configuredApiKey = options.apiKey?.trim();
  if (options.apiKey !== undefined && configuredApiKey?.length === 0) {
    throw new Error("CommandCode Goat API key must be non-empty");
  }

  return createProvider({
    id: COMMANDCODE_GOAT_PROVIDER_ID,
    name: "CommandCode Goat",
    baseUrl: COMMANDCODE_GOAT_BASE_URL,
    models: COMMANDCODE_GOAT_MODELS,
    auth: {
      apiKey: {
        name: "CommandCode Goat API key",
        login: async (interaction) => {
          interaction.signal.throwIfAborted();
          const key = (
            await interaction.prompt({
              type: "secret",
              message: "Enter the CommandCode Goat API key",
            })
          ).trim();
          interaction.signal.throwIfAborted();
          if (key.length === 0) {
            throw new Error("CommandCode Goat API key must be non-empty");
          }
          return { type: "api_key", key };
        },
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          const storedApiKey = credential?.key?.trim();
          if (storedApiKey !== undefined && storedApiKey.length > 0) {
            return {
              auth: { apiKey: storedApiKey },
              ...(credential?.env === undefined
                ? {}
                : { env: credential.env }),
              source: "stored credential",
            };
          }
          return configuredApiKey
            ? {
                auth: { apiKey: configuredApiKey },
                source: "configured CommandCode Goat API key",
              }
            : undefined;
        },
      },
    },
    api: bindUpstreamFailureDiagnostics(
      bindFetch(openAICompletionsApi(), options.fetch),
    ),
  });
}

export const commandCodeGoatProviderId = COMMANDCODE_GOAT_PROVIDER_ID;
export const commandCodeGoatApiId = COMMANDCODE_GOAT_API_ID;
