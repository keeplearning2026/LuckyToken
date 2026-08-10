import {
  createModels,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { handleHttpRequest } from "./http.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "./providers/commandcode-private/provider.js";

export interface LuckyTokenRuntime {
  handle(request: Request): Promise<Response>;
}

export interface LuckyTokenRuntimeOptions {
  clientApiKey: string;
  commandCodeApiKey: string;
  commandCodeBaseUrl: string;
  fetch: FetchFunction;
  modelId: string;
  createMessageId?: () => string;
  createSessionId?: () => string;
  now?: () => number;
}

export function createLuckyTokenRuntime(
  options: LuckyTokenRuntimeOptions,
): LuckyTokenRuntime {
  const now = options.now ?? Date.now;
  const model: Model<typeof commandCodePrivateApiId> = {
    id: options.modelId,
    name: options.modelId,
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: options.commandCodeBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };

  const models = createModels();
  models.setProvider(
    createCommandCodePrivateProvider({
      apiKey: options.commandCodeApiKey,
      fetch: options.fetch,
      model,
      now,
    }),
  );

  const dependencies = {
    models,
    providerId: commandCodePrivateProviderId,
    clientApiKey: options.clientApiKey,
    createMessageId: options.createMessageId ?? (() => `msg_${randomUUID()}`),
    createSessionId: options.createSessionId ?? randomUUID,
    now,
  };

  return {
    handle: (request) => handleHttpRequest(dependencies, request),
  };
}
