import {
  createModels,
  type CredentialStore,
  type FetchFunction,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createAuth } from "./auth.js";
import { loadFileClientTokenAuthority } from "./client-auth/file-token-store.js";
import type { LuckyTokenCliConfig } from "./cli-config.js";
import {
  certifyServingComposition,
  ServingCertificationFailure,
  type ServingCertificationManifest,
} from "./commandcode-serving-certification.js";
import { createFileCredentialStore } from "./pi/file-credential-store.js";
import {
  loadPiModelsConfig,
  type PiModelDefinition,
  type PiProviderConfig,
} from "./pi/model-config.js";
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
  anthropicMessagesProtocolId,
  createAnthropicMessagesHandler,
} from "./protocols/anthropic/handler.js";
import { defaultAnthropicModelValidityPolicy } from "./protocols/anthropic/representability.js";
import {
  SYNTHETIC_CLIENT_HISTORY_API,
  SYNTHETIC_CLIENT_HISTORY_PROVIDER,
} from "./protocols/anthropic/request.js";
import {
  createLuckyTokenRuntime,
  type LuckyTokenRuntime,
} from "./runtime.js";

const COMMANDCODE_PROVIDER_FIELDS = new Set([
  "name",
  "baseUrl",
  "api",
  "models",
]);
const COMMANDCODE_MODEL_FIELDS = new Set([
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
]);
const COST_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite"]);

export interface ConfiguredPiModelsOptions {
  readonly piDirectory: string;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  readonly projectSnapshot?: ProjectSnapshot;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
}

export interface ConfiguredPiModels {
  readonly models: Models;
  readonly model: Model<typeof commandCodePrivateApiId>;
}

export interface ConfiguredLuckyTokenCompositionOptions {
  readonly config: LuckyTokenCliConfig;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  readonly projectSnapshot?: ProjectSnapshot;
  readonly createMessageId?: () => string;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
  readonly shutdownSignal?: AbortSignal;
}

export interface ConfiguredLuckyTokenComposition {
  readonly runtime: LuckyTokenRuntime;
  readonly certification: ServingCertificationManifest;
}

function assertOnlyFields(
  value: Readonly<Record<string, unknown>>,
  fields: ReadonlySet<string>,
  description: string,
): void {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) {
      throw new Error(`${description} has unsupported field: ${field}`);
    }
  }
}

function commandCodeCost(
  definition: PiModelDefinition,
): Model<typeof commandCodePrivateApiId>["cost"] {
  if (definition.cost === undefined) {
    return Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }
  assertOnlyFields(definition.cost, COST_FIELDS, `model ${definition.id}.cost`);
  const cost: Record<string, number> = {};
  for (const field of COST_FIELDS) {
    const value = definition.cost[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`model ${definition.id}.cost.${field} must be non-negative`);
    }
    cost[field] = value;
  }
  return Object.freeze({
    input: cost.input as number,
    output: cost.output as number,
    cacheRead: cost.cacheRead as number,
    cacheWrite: cost.cacheWrite as number,
  });
}

function commandCodeModel(
  provider: PiProviderConfig,
): Model<typeof commandCodePrivateApiId> {
  if (provider.api !== undefined && provider.api !== commandCodePrivateApiId) {
    throw new Error(
      `models.json commandcode-private API must be ${commandCodePrivateApiId}`,
    );
  }
  assertOnlyFields(
    provider,
    COMMANDCODE_PROVIDER_FIELDS,
    "models.json commandcode-private provider",
  );
  if (provider.models?.length !== 1) {
    throw new Error(
      "models.json commandcode-private provider requires exactly one certified model",
    );
  }
  const definition = provider.models[0] as PiModelDefinition;
  assertOnlyFields(
    definition,
    COMMANDCODE_MODEL_FIELDS,
    `models.json model ${definition.id}`,
  );
  if (definition.api !== undefined && definition.api !== commandCodePrivateApiId) {
    throw new Error(`model ${definition.id} API must be ${commandCodePrivateApiId}`);
  }
  const baseUrl = definition.baseUrl ?? provider.baseUrl ?? "https://api.commandcode.ai";
  const input: Array<"text" | "image"> = [...(definition.input ?? ["text"])];
  Object.freeze(input);
  return Object.freeze({
    id: definition.id,
    name: definition.name ?? definition.id,
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    input,
    cost: commandCodeCost(definition),
    contextWindow: definition.contextWindow ?? 200_000,
    maxTokens: definition.maxTokens ?? 64_000,
  });
}

export async function createConfiguredPiModels(
  options: ConfiguredPiModelsOptions,
): Promise<ConfiguredPiModels> {
  const config = await loadPiModelsConfig(join(options.piDirectory, "models.json"));
  const providerConfig = config.getProvider(commandCodePrivateProviderId);
  if (providerConfig === undefined) {
    throw new Error(
      `models.json must configure provider ${commandCodePrivateProviderId}`,
    );
  }
  const model = commandCodeModel(providerConfig);
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? randomUUID;
  const mutableModels = createModels({
    credentials:
      options.credentials ??
      createFileCredentialStore(join(options.piDirectory, "auth.json")),
  });
  mutableModels.setProvider(
    createCommandCodePrivateProvider({
      fetch: options.fetch,
      model,
      now,
      projectSnapshot: options.projectSnapshot ?? createNodeProjectSnapshot(),
      createSessionId,
    }),
  );
  const models: Models = mutableModels;
  return Object.freeze({ models, model });
}

export async function createConfiguredLuckyTokenComposition(
  options: ConfiguredLuckyTokenCompositionOptions,
): Promise<ConfiguredLuckyTokenComposition> {
  const config = options.config;
  const uninstalledProtocol = Object.keys(config.clientProtocols).find(
    (protocolId) => protocolId !== anthropicMessagesProtocolId,
  );
  if (uninstalledProtocol !== undefined) {
    throw new Error(
      `Client Protocol is configured but not installed: ${uninstalledProtocol}`,
    );
  }
  const anthropicConfig = Object.hasOwn(
    config.clientProtocols,
    anthropicMessagesProtocolId,
  )
    ? config.clientProtocols[anthropicMessagesProtocolId]
    : undefined;
  if (anthropicConfig === undefined) {
    throw new Error(
      `clientProtocols must configure ${anthropicMessagesProtocolId}`,
    );
  }
  const clientAuthority = await loadFileClientTokenAuthority(
    anthropicConfig.authFile,
  );
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? randomUUID;
  const { models, model } = await createConfiguredPiModels({
    piDirectory: config.pi.directory,
    ...(options.credentials === undefined
      ? {}
      : { credentials: options.credentials }),
    fetch: options.fetch,
    ...(options.projectSnapshot === undefined
      ? {}
      : { projectSnapshot: options.projectSnapshot }),
    createSessionId,
    now,
  });
  const providerAuth = await models.checkAuth(commandCodePrivateProviderId);
  const certification = certifyServingComposition({
    model,
    modelValidityPolicyRevision: defaultAnthropicModelValidityPolicy.revision,
    compatibility: {},
    fetchBound: true,
    projectSnapshotPolicy:
      options.projectSnapshot === undefined
        ? "node-project-snapshot-v1"
        : "bound-injected-project-snapshot-v1",
    projectAuthorizationPolicy: "per-client-protocol-token-file-v1",
    clientAuthorityPolicy: "handler-bound-file-snapshot-v1",
    routerDefaults: {},
    clientAuthConfigured: true,
    providerApiKeyConfigured: providerAuth !== undefined,
    providerAuthPolicy: "pi-models-credential-store-v1",
    providerRegistrationPolicy: "pi-models-json-startup-registration-v1",
    maxRequestBytes: config.limits.maxRequestBytes,
    requestTimeoutMs: config.limits.requestTimeoutMs,
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

  const auth = createAuth({
    authorizeToken: (token) => clientAuthority.authorize(token),
    createFallbackSessionId: createSessionId,
  });
  const anthropic = createAnthropicMessagesHandler({
    models,
    auth,
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    maxRequestBytes: config.limits.maxRequestBytes,
    now,
  });
  const runtime = createLuckyTokenRuntime({
    clientProtocols: [anthropic],
    requestTimeoutMs: config.limits.requestTimeoutMs,
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
  });
  return Object.freeze({ runtime, certification });
}
