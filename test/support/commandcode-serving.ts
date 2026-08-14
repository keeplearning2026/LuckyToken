import {
  createModels,
  type FetchFunction,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { createAuth } from "../../src/auth.js";
import type { InvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";
import {
  certifyServingComposition,
  ServingCertificationFailure,
  type ServingCertificationManifest,
} from "./commandcode-serving-certification.js";
import type { RouterOptionDefaults } from "../../src/protocols/anthropic/options.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
  type CommandCodeCompatibilityPolicy,
} from "../../packages/provider-commandcode-private/src/provider.js";
import type { CommandCodeConfiguration } from "../../packages/provider-commandcode-private/src/configuration.js";
import {
  createNodeProjectSnapshot,
  type ProjectSnapshot,
} from "../../packages/provider-commandcode-private/src/project.js";
import type { AnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
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
  modelReasoning?: boolean;
  commandCodeCompatibility?: CommandCodeCompatibilityPolicy;
  commandCodeConfiguration?: CommandCodeConfiguration;
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
  invocationDiagnostics?: InvocationDiagnosticsFactory;
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
    reasoning: options.modelReasoning ?? false,
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
    clientAuthorityPolicy: "bound-injected-auth-v1",
    routerDefaults,
    clientAuthConfigured: options.clientApiKey.length > 0,
    providerApiKeyConfigured: options.commandCodeApiKey.length > 0,
    providerAuthPolicy: "fixed-api-key-header-v1",
    providerRegistrationPolicy: "startup-only-mutable-models-v1",
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
      ...(options.commandCodeConfiguration === undefined
        ? {}
        : { configuration: options.commandCodeConfiguration }),
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
  const anthropic = createAnthropicMessagesHandler({
    models,
    auth,
    passthroughFetch: options.fetch,
    ...(options.anthropicModelValidityPolicy === undefined
      ? {}
      : { modelValidityPolicy: options.anthropicModelValidityPolicy }),
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    maxRequestBytes,
    routerDefaults,
    now,
    ...(options.invocationDiagnostics === undefined
      ? {}
      : { invocationDiagnostics: options.invocationDiagnostics }),
  });
  const runtime = createLuckyTokenRuntime({
    clientProtocols: [anthropic],
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
  });
  return Object.freeze({ runtime, certification });
}

export function createCommandCodeTestRuntime(
  options: CommandCodeServingTestOptions,
): LuckyTokenRuntime {
  return createCommandCodeServingTestComposition(options).runtime;
}
