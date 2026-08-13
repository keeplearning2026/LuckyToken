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
import { createResponseSessionState } from "../../src/protocols/openai-responses/session-state.js";
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
import type { OpenAIResponsesConfiguration } from "../../src/protocols/openai-responses/configuration.js";
import type { InvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";

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
  /** Reuse a fixed state file across compositions (restart simulation). */
  stateFile?: string;
  /** Reuse a fixed runtime directory (restart simulation). */
  directory?: string;
  configuration?: OpenAIResponsesConfiguration;
  invocationDiagnostics?: InvocationDiagnosticsFactory;
}

export interface OpenAIResponsesServingTestComposition {
  readonly runtime: LuckyTokenRuntime;
  readonly stateFile: string;
  readonly flushState: () => Promise<void>;
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
  const directory =
    options.directory ??
    (await mkdtemp(join(tmpdir(), "luckytoken-openai-responses-serving-")));
  const stateFile =
    options.stateFile ?? join(directory, "openai-responses.json");
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
  const sessionState = createResponseSessionState({
    stateFile,
    storeFalsePolicy:
      options.configuration === undefined
        ? "honor"
        : options.configuration.conversion.response.storeFalse,
  });
  const handler = createOpenAIResponsesHandler({
    models,
    auth,
    stateFile,
    sessionState,
    httpObserver,
    ...(options.createResponseId === undefined
      ? {}
      : { createResponseId: options.createResponseId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    maxRequestBytes: options.maxRequestBytes ?? 32 * 1024 * 1024,
    ...(options.configuration === undefined
      ? {}
      : { configuration: options.configuration }),
    ...(options.invocationDiagnostics === undefined
      ? {}
      : { invocationDiagnostics: options.invocationDiagnostics }),
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
    flushState: () => sessionState.flush(),
    // When the caller supplied a fixed directory (restart simulation), the
    // directory is shared and must not be removed here; the test owns it.
    close: () =>
      options.directory === undefined
        ? rm(directory, { recursive: true, force: true })
        : Promise.resolve(),
  });
}
