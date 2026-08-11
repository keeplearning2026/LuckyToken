import {
  createModels,
  type FetchFunction,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { createAuth } from "../../src/auth.js";
import {
  certifyServingComposition,
  ServingCertificationFailure,
  type ServingCertificationManifest,
} from "../../src/commandcode-serving-certification.js";
import type { RouterOptionDefaults } from "../../src/options.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
  type CommandCodeCompatibilityPolicy,
} from "../../src/providers/commandcode-private/provider.js";
import {
  createNodeProjectSnapshot,
  type ProjectSnapshot,
} from "../../src/providers/commandcode-private/project.js";
import type { AnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import {
  SYNTHETIC_CLIENT_HISTORY_API,
  SYNTHETIC_CLIENT_HISTORY_PROVIDER,
} from "../../src/protocols/anthropic/request.js";
import {
  createLuckyTokenRuntime,
  type LuckyTokenRuntime,
} from "../../src/runtime.js";

export interface CommandCodeServingTestOptions {
  clientApiKey: string;
  commandCodeApiKey: string;
  commandCodeBaseUrl: string;
  fetch: FetchFunction;
  modelId: string;
  modelInput?: Array<"text" | "image">;
  commandCodeCompatibility?: CommandCodeCompatibilityPolicy;
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

export interface CommandCodeServingTestComposition {
  readonly runtime: LuckyTokenRuntime;
  readonly certification: ServingCertificationManifest;
}

function createModel(
  options: CommandCodeServingTestOptions,
): Model<typeof commandCodePrivateApiId> {
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
  Object.freeze(model.input);
  Object.freeze(model.cost);
  return Object.freeze(model);
}

export function createCommandCodeServingTestComposition(
  options: CommandCodeServingTestOptions,
): CommandCodeServingTestComposition {
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? randomUUID;
  const compatibilitySource = options.commandCodeCompatibility ?? {};
  const projectSnapshot = options.projectSnapshot ?? createNodeProjectSnapshot();
  const routerDefaults = Object.freeze({ ...(options.routerDefaults ?? {}) });
  const model = createModel(options);
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const certification = certifyServingComposition({
    model,
    modelValidityPolicyRevision:
      options.anthropicModelValidityPolicy?.revision ??
      defaultAnthropicModelValidityPolicy.revision,
    compatibility: compatibilitySource,
    fetchBound: typeof options.fetch === "function",
    projectSnapshotPolicy:
      options.projectSnapshot === undefined
        ? "node-project-snapshot-v1"
        : "bound-injected-project-snapshot-v1",
    projectAuthorizationPolicy:
      options.projectDir === undefined
        ? "project-dir-absent-v1"
        : "fixed-authorized-project-dir-v1",
    routerDefaults,
    clientApiKeyConfigured: options.clientApiKey.length > 0,
    providerApiKeyConfigured: options.commandCodeApiKey.length > 0,
    maxRequestBytes,
    requestTimeoutMs: options.requestTimeoutMs ?? null,
    shutdownSignalBound: options.shutdownSignal !== undefined,
    messageIdPolicy:
      options.createMessageId === undefined
        ? "node-random-uuid-v1"
        : "bound-injected-message-id-v1",
    sessionIdPolicy:
      options.createSessionId === undefined
        ? "node-random-uuid-v1"
        : "bound-injected-session-id-v1",
    clockPolicy:
      options.now === undefined ? "system-clock-v1" : "bound-injected-clock-v1",
    syntheticHistoryIdentity: {
      provider: SYNTHETIC_CLIENT_HISTORY_PROVIDER,
      api: SYNTHETIC_CLIENT_HISTORY_API,
    },
  });
  if (certification.result !== "CERTIFIED") {
    throw new ServingCertificationFailure(certification);
  }

  const mutableModels = createModels();
  mutableModels.setProvider(
    createCommandCodePrivateProvider({
      apiKey: options.commandCodeApiKey,
      fetch: options.fetch,
      model,
      now,
      projectSnapshot,
      compatibility: compatibilitySource,
      createSessionId,
    }),
  );
  const models: Models = mutableModels;
  const clientApiKey = options.clientApiKey;
  const projectDir = options.projectDir;
  const auth = createAuth({
    authorizeToken: async (token) => {
      if (token !== clientApiKey) return undefined;
      return projectDir === undefined ? {} : { projectDir };
    },
    createFallbackSessionId: createSessionId,
  });
  const runtime = createLuckyTokenRuntime({
    models,
    auth,
    ...(options.anthropicModelValidityPolicy === undefined
      ? {}
      : { anthropicModelValidityPolicy: options.anthropicModelValidityPolicy }),
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    maxRequestBytes,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
    routerDefaults,
    now,
  });
  return Object.freeze({ runtime, certification });
}

export function createCommandCodeTestRuntime(
  options: CommandCodeServingTestOptions,
): LuckyTokenRuntime {
  return createCommandCodeServingTestComposition(options).runtime;
}
