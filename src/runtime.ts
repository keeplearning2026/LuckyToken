import {
  createModels,
  type FetchFunction,
  type Model,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { createAuth } from "./auth.js";
import { handleHttpRequest } from "./http.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "./providers/commandcode-private/provider.js";
import {
  createNodeProjectSnapshot,
  type ProjectSnapshot,
} from "./providers/commandcode-private/project.js";
import {
  defaultAnthropicModelValidityPolicy,
  type AnthropicModelValidityPolicy,
} from "./protocols/anthropic/representability.js";
import type { RouterOptionDefaults } from "./options.js";

export interface LuckyTokenRuntime {
  handle(request: Request): Promise<Response>;
}

export interface LuckyTokenRuntimeOptions {
  clientApiKey: string;
  commandCodeApiKey: string;
  commandCodeBaseUrl: string;
  fetch: FetchFunction;
  modelId: string;
  modelInput?: Array<"text" | "image">;
  createMessageId?: () => string;
  createSessionId?: () => string;
  projectDir?: string;
  projectSnapshot?: ProjectSnapshot;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  shutdownSignal?: AbortSignal;
  routerDefaults?: RouterOptionDefaults;
  anthropicModelValidityPolicy?: AnthropicModelValidityPolicy;
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
    input: [...(options.modelInput ?? ["text"])],
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
      projectSnapshot: options.projectSnapshot ?? createNodeProjectSnapshot(),
    }),
  );

  const auth = createAuth({
    authorizeToken: async (token) => {
      if (token !== options.clientApiKey) return undefined;
      return options.projectDir === undefined
        ? {}
        : { projectDir: options.projectDir };
    },
    createFallbackSessionId: options.createSessionId ?? randomUUID,
  });

  const dependencies = {
    models,
    auth,
    modelValidityPolicy:
      options.anthropicModelValidityPolicy ??
      defaultAnthropicModelValidityPolicy,
    createMessageId: options.createMessageId ?? (() => `msg_${randomUUID()}`),
    maxRequestBytes: options.maxRequestBytes ?? 1_048_576,
    requestTimeoutMs: options.requestTimeoutMs,
    shutdownSignal: options.shutdownSignal,
    routerDefaults: options.routerDefaults ?? {},
    now,
  };

  return {
    handle: (request) => handleHttpRequest(dependencies, request),
  };
}
