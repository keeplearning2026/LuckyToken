import {
  createModels,
  type FetchFunction,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { createAuth } from "./auth.js";
import {
  certifyServingComposition,
  ServingCertificationFailure,
  type ServingCertificationManifest,
} from "./certification.js";
import {
  handleHttpRequest,
  type HttpBoundaryDependencies,
} from "./http.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  createCommandCodePrivateProvider,
  type CommandCodeCompatibilityPolicy,
} from "./providers/commandcode-private/provider.js";
import {
  createNodeProjectSnapshot,
  type ProjectSnapshot,
} from "./providers/commandcode-private/project.js";
import {
  defaultAnthropicModelValidityPolicy,
  type AnthropicModelValidityPolicy,
} from "./protocols/anthropic/representability.js";
import {
  SYNTHETIC_CLIENT_HISTORY_API,
  SYNTHETIC_CLIENT_HISTORY_PROVIDER,
} from "./protocols/anthropic/request.js";
import type { RouterOptionDefaults } from "./options.js";

export interface LuckyTokenRuntime {
  readonly certification: ServingCertificationManifest;
  handle(request: Request): Promise<Response>;
}

export interface LuckyTokenRuntimeOptions {
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

export function createLuckyTokenRuntime(
  options: LuckyTokenRuntimeOptions,
): LuckyTokenRuntime {
  const now = options.now ?? Date.now;
  const clientApiKey = options.clientApiKey;
  const commandCodeApiKey = options.commandCodeApiKey;
  const projectDir = options.projectDir;
  const fetch = options.fetch;
  const compatibilitySource = options.commandCodeCompatibility ?? {};
  const compatibility = Object.freeze({
    ...(compatibilitySource.cliEnvironment === undefined
      ? {}
      : { cliEnvironment: compatibilitySource.cliEnvironment }),
    ...(compatibilitySource.ossPrimaryProvider === undefined
      ? {}
      : { ossPrimaryProvider: compatibilitySource.ossPrimaryProvider }),
    ...(compatibilitySource.permissionMode === undefined
      ? {}
      : { permissionMode: compatibilitySource.permissionMode }),
  });
  const projectSnapshotSource =
    options.projectSnapshot ?? createNodeProjectSnapshot();
  const snapshotProject = projectSnapshotSource.snapshot;
  const projectSnapshot: ProjectSnapshot = Object.freeze({
    snapshot: (input: Parameters<ProjectSnapshot["snapshot"]>[0]) =>
      snapshotProject.call(projectSnapshotSource, input),
  });
  const validityPolicySource =
    options.anthropicModelValidityPolicy ?? defaultAnthropicModelValidityPolicy;
  const classifyFinalAssistantPrefill =
    validityPolicySource.classifyFinalAssistantPrefill;
  const hasCertifiedImageFidelity =
    validityPolicySource.hasCertifiedImageFidelity;
  const modelValidityPolicySnapshot: AnthropicModelValidityPolicy = {
    revision: validityPolicySource.revision,
    classifyFinalAssistantPrefill: (model, profile) =>
      classifyFinalAssistantPrefill(model, profile),
    hasCertifiedImageFidelity: (model) => hasCertifiedImageFidelity(model),
  };
  const modelValidityPolicy = Object.freeze(modelValidityPolicySnapshot);
  const createMessageId = options.createMessageId ?? (() => `msg_${randomUUID()}`);
  const createSessionId = options.createSessionId ?? randomUUID;
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const requestTimeoutMs = options.requestTimeoutMs;
  const shutdownSignal = options.shutdownSignal;
  const routerDefaults = options.routerDefaults ?? {};
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
  Object.freeze(model);

  const certification = certifyServingComposition({
    model,
    modelValidityPolicyRevision: modelValidityPolicy.revision,
    compatibility: compatibilitySource,
    fetchBound: typeof fetch === "function",
    projectSnapshotPolicy:
      options.projectSnapshot === undefined
        ? "node-project-snapshot-v1"
        : "bound-injected-project-snapshot-v1",
    projectAuthorizationPolicy:
      projectDir === undefined
        ? "project-dir-absent-v1"
        : "fixed-authorized-project-dir-v1",
    routerDefaults,
    clientApiKeyConfigured: clientApiKey.length > 0,
    providerApiKeyConfigured: commandCodeApiKey.length > 0,
    maxRequestBytes,
    requestTimeoutMs: requestTimeoutMs ?? null,
    shutdownSignalBound: shutdownSignal !== undefined,
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
      apiKey: commandCodeApiKey,
      fetch,
      model,
      now,
      projectSnapshot,
      compatibility,
      createSessionId,
    }),
  );
  const models: Models = mutableModels;

  const auth = createAuth({
    authorizeToken: async (token) => {
      if (token !== clientApiKey) return undefined;
      return projectDir === undefined ? {} : { projectDir };
    },
    createFallbackSessionId: createSessionId,
  });

  const dependencies: HttpBoundaryDependencies = {
    models,
    auth,
    modelValidityPolicy,
    createMessageId,
    maxRequestBytes,
    requestTimeoutMs,
    shutdownSignal,
    routerDefaults: Object.freeze({ ...routerDefaults }),
    now,
  };

  const runtime: LuckyTokenRuntime = {
    certification,
    handle: (request) => handleHttpRequest(dependencies, request),
  };
  return Object.freeze(runtime);
}
