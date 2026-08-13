import {
  createModels,
  type CredentialStore,
  type FetchFunction,
  type Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { createAuth } from "./auth.js";
import { createInvocationDiagnosticsFactory } from "./invocation-diagnostics/index.js";
import { bindCommandCodeConfiguration, type CommandCodeConfiguration } from "./providers/commandcode-private/configuration.js";
import { bindAnthropicConfiguration } from "./protocols/anthropic/configuration.js";
import { bindOpenAIResponsesConfiguration } from "./protocols/openai-responses/configuration.js";
import { loadFileClientTokenAuthority } from "./client-auth/file-token-store.js";
import type { LuckyTokenCliConfig } from "./cli-config.js";
import {
  certifyServingComposition,
  ServingCertificationFailure,
  type ServingCertificationManifest,
} from "./commandcode-serving-certification.js";
import { HttpObserver } from "./http-observer.js";
import type { ClientProtocolHandler } from "./http.js";
import { createModelsDiscoveryHandler } from "./models-discovery.js";
import { createFileCredentialStore } from "./pi/file-credential-store.js";
import { loadModelsJson } from "./providers/models-json.js";
import {
  commandCodePrivateDefaultModelId,
  commandCodePrivateProviderId,
  registerLuckyTokenProviders,
  type ProjectSnapshot,
} from "./providers/catalog.js";
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
  createOpenAIResponsesHandler,
  openaiResponsesProtocolId,
} from "./protocols/openai-responses/handler.js";
import {
  createLuckyTokenRuntime,
  type LuckyTokenRuntime,
} from "./runtime.js";

export interface ConfiguredPiModelsOptions {
  readonly piDirectory: string;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  readonly commandCodeConfiguration?: CommandCodeConfiguration;
  /** Optional models.json path; absent means no user-registered providers. */
  readonly modelsJsonPath?: string;
  /**
   * Optional shared HTTP observer. When provided, the CommandCode provider's
   * bound fetch is wrapped by it so provider HTTP failures are visible to the
   * Client Protocol handler.
   */
  readonly httpObserver?: HttpObserver;
  readonly projectSnapshot?: ProjectSnapshot;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
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

export async function createConfiguredPiModels(
  options: ConfiguredPiModelsOptions,
): Promise<{ models: Models }> {
  const modelsJson = await loadModelsJson(options.modelsJsonPath);
  const mutableModels = createModels({
    credentials:
      options.credentials ??
      createFileCredentialStore(join(options.piDirectory, "auth.json")),
  });
  registerLuckyTokenProviders(mutableModels, {
    fetch: options.fetch,
    ...(options.commandCodeConfiguration === undefined ? {} : { commandCodeConfiguration: options.commandCodeConfiguration }),
    ...(modelsJson === undefined ? {} : { modelsJson }),
    ...(options.httpObserver === undefined
      ? {}
      : { httpObserver: options.httpObserver }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.projectSnapshot === undefined
      ? {}
      : { projectSnapshot: options.projectSnapshot }),
    ...(options.createSessionId === undefined
      ? {}
      : { createSessionId: options.createSessionId }),
  });
  const models: Models = mutableModels;
  return Object.freeze({ models });
}

export async function createConfiguredLuckyTokenComposition(
  options: ConfiguredLuckyTokenCompositionOptions,
): Promise<ConfiguredLuckyTokenComposition> {
  const config = options.config;
  const uninstalledProtocol = Object.keys(config.clientProtocols).find(
    (protocolId) =>
      protocolId !== anthropicMessagesProtocolId &&
      protocolId !== openaiResponsesProtocolId,
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
  const httpObserver = new HttpObserver(options.fetch);
  const invocationDiagnostics = createInvocationDiagnosticsFactory({
    configuration: config.failureLogging,
    now,
  });
  const { models } = await createConfiguredPiModels({
    piDirectory: config.pi.directory,
    ...(config.pi.modelsJson === undefined
      ? {}
      : { modelsJsonPath: config.pi.modelsJson }),
    ...(options.credentials === undefined
      ? {}
      : { credentials: options.credentials }),
    fetch: options.fetch,
    commandCodeConfiguration: bindCommandCodeConfiguration(
      config.providerAdapters[commandCodePrivateProviderId],
    ),
    httpObserver,
    ...(options.projectSnapshot === undefined
      ? {}
      : { projectSnapshot: options.projectSnapshot }),
    createSessionId,
    now,
  });
  const providers = models.getProviders();
  const certifiedProvider = providers.find(
    (provider) => provider.id === commandCodePrivateProviderId,
  );
  if (certifiedProvider === undefined) {
    throw new Error(
      `Registered Providers do not include the certified Provider ` +
        `"${commandCodePrivateProviderId}" (found: ` +
        `${providers.map((provider) => provider.id).join(", ") || "none"})`,
    );
  }
  const certifiedModel = models.getModels().find(
    (entry) =>
      entry.provider === certifiedProvider.id &&
      entry.id === commandCodePrivateDefaultModelId,
  );
  if (certifiedModel === undefined) {
    throw new Error(
      `Registered Provider ${certifiedProvider.id} exposes no model`,
    );
  }
  const providerAuth = await models.checkAuth(certifiedProvider.id);
  const certification = certifyServingComposition({
    model: certifiedModel,
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
    providerRegistrationPolicy: "startup-only-mutable-models-v1",
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
    configuration: bindAnthropicConfiguration(anthropicConfig.adapterConfiguration),
    invocationDiagnostics,
    httpObserver,
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    maxRequestBytes: config.limits.maxRequestBytes,
    now,
  });
  const openaiResponsesConfig = Object.hasOwn(
    config.clientProtocols,
    openaiResponsesProtocolId,
  )
    ? config.clientProtocols[openaiResponsesProtocolId]
    : undefined;
  const clientProtocols: ClientProtocolHandler[] = [anthropic];
  // Shared, unauthenticated model discovery: any client may learn the
  // selectors this endpoint serves, independent of Client Protocol Auth.
  clientProtocols.push(
    createModelsDiscoveryHandler({
      models,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
  if (openaiResponsesConfig !== undefined) {
    const responsesAuthority = await loadFileClientTokenAuthority(
      openaiResponsesConfig.authFile,
    );
    const responsesAuth = createAuth({
      authorizeToken: (token) => responsesAuthority.authorize(token),
      createFallbackSessionId: createSessionId,
    });
    const stateFile =
      openaiResponsesConfig.stateFile ??
      join(dirname(config.configPath), "state", "openai-responses.json");
    const responses = createOpenAIResponsesHandler({
      models,
      auth: responsesAuth,
      configuration: bindOpenAIResponsesConfiguration(
        openaiResponsesConfig.adapterConfiguration,
      ),
      invocationDiagnostics,
      stateFile,
      httpObserver,
      maxRequestBytes: config.limits.maxRequestBytes,
      ...(options.shutdownSignal === undefined
        ? {}
        : { shutdownSignal: options.shutdownSignal }),
      now,
    });
    clientProtocols.push(responses);
  }
  const runtime = createLuckyTokenRuntime({
    clientProtocols,
    requestTimeoutMs: config.limits.requestTimeoutMs,
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
  });
  return Object.freeze({ runtime, certification });
}
