import {
  createModels,
  type FetchFunction,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth } from "../../src/auth.js";
import { HttpObserver } from "../../src/http-observer.js";
import { createModelsDiscoveryHandler } from "../../src/models-discovery.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "../../src/providers/commandcode-private/provider.js";
import {
  createEmptyServerConfig,
} from "../../src/providers/commandcode-private/project.js";
import {
  createLuckyTokenRuntime,
  type LuckyTokenRuntime,
} from "../../src/runtime.js";

export interface OpenAIResponsesServingTestOptions {
  clientApiKey: string;
  commandCodeApiKey: string;
  commandCodeBaseUrl: string;
  fetch: FetchFunction;
  modelId: string;
  createResponseId?: () => string;
  createSessionId?: () => string;
  now?: () => number;
  maxRequestBytes?: number;
}

export interface OpenAIResponsesServingTestComposition {
  readonly runtime: LuckyTokenRuntime;
  readonly stateFile: string;
  readonly close: () => Promise<void>;
}

function createModel(
  options: OpenAIResponsesServingTestOptions,
): Model<typeof commandCodePrivateApiId> {
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
  Object.freeze(model.input);
  Object.freeze(model.cost);
  return Object.freeze(model);
}

export async function createOpenAIResponsesServingTestComposition(
  options: OpenAIResponsesServingTestOptions,
): Promise<OpenAIResponsesServingTestComposition> {
  const directory = await mkdtemp(
    join(tmpdir(), "luckytoken-openai-responses-serving-"),
  );
  const stateFile = join(directory, "openai-responses.json");
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? randomUUID;
  const model = createModel(options);
  const httpObserver = new HttpObserver(options.fetch);

  const mutableModels = createModels();
  mutableModels.setProvider(
    createCommandCodePrivateProvider({
      apiKey: options.commandCodeApiKey,
      fetch: httpObserver.observedFetch,
      model,
      now,
      projectSnapshot: {
        snapshot: async () => createEmptyServerConfig(),
      },
      createSessionId,
    }),
  );
  const models: Models = mutableModels;

  const auth = createAuth({
    authorizeToken: async (token) =>
      token === options.clientApiKey ? {} : undefined,
    createFallbackSessionId: createSessionId,
  });
  const handler = createOpenAIResponsesHandler({
    models,
    auth,
    stateFile,
    httpObserver,
    ...(options.createResponseId === undefined
      ? {}
      : { createResponseId: options.createResponseId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxRequestBytes === undefined
      ? {}
      : { maxRequestBytes: options.maxRequestBytes }),
  });
  const modelsHandler = createModelsDiscoveryHandler({
    models,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const runtime = createLuckyTokenRuntime({
    clientProtocols: [handler, modelsHandler],
  });
  return Object.freeze({
    runtime,
    stateFile,
    close: () => rm(directory, { recursive: true, force: true }),
  });
}
