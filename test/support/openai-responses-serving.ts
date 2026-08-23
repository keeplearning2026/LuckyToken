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

import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";
import type { RequestJourneyObservationAuthority } from "../../src/diagnostics/contract.js";
import { createModelsDiscoveryHandler } from "../../src/models-discovery.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createResponseSessionState } from "../../src/protocols/openai-responses/session-state.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
} from "../../packages/provider-commandcode-private/src/provider.js";
import {
  createLuckyTokenRuntime,
  type LuckyTokenRuntime,
} from "../../src/runtime.js";
import type { OpenAIResponsesConfiguration } from "../../src/protocols/openai-responses/configuration.js";
import type {
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "../../src/codex-native-seam.js";
import { createCodexLocalResponsesLane } from "../../src/integrations/codex/local-responses.js";

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
  diagnostics?: RequestJourneyObservationAuthority;
  /** Codex-native request test seam. Production composition wires the same
   *  authority into Client Auth and the native passthrough branch. */
  codexLocalAuth?: CodexLocalCredentialAuthority;
  codexNativeModels?: CodexNativeModelSource;
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

  const mutableModels = createModels();
  mutableModels.setProvider(
    createCommandCodePrivateProvider({
      apiKey: options.commandCodeApiKey,
      fetch: options.fetch,
      model,
      now,
      createSessionId,
    }),
  );
  const models: Models = mutableModels;

  const sessionState = createResponseSessionState({
    stateFile,
    storeFalsePolicy:
      options.configuration === undefined
        ? "honor"
        : options.configuration.conversion.response.storeFalse,
  });
  const localNativeLane =
    options.codexLocalAuth === undefined || options.codexNativeModels === undefined
      ? undefined
      : createCodexLocalResponsesLane({
          credentials: options.codexLocalAuth,
          models: options.codexNativeModels,
          fetch: options.fetch,
        });
  const handler = createOpenAIResponsesHandler({
    models,
    createSessionId,
    stateFile,
    sessionState,
    ...(options.createResponseId === undefined
      ? {}
      : { createResponseId: options.createResponseId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    maxRequestBytes: options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    ...(options.configuration === undefined
      ? {}
      : { configuration: options.configuration }),
    ...(localNativeLane === undefined ? {} : { localNativeLane }),
  });
  const modelsHandler = createModelsDiscoveryHandler({
    models,
    providerIds: [commandCodePrivateProviderId],
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const runtime = createLuckyTokenRuntime({
    clientProtocols: [handler, modelsHandler],
    ...(options.diagnostics === undefined
      ? {}
      : { diagnostics: options.diagnostics }),
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
