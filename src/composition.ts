import {
  createModels,
  type CredentialStore,
  type FetchFunction,
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
  createLuckyTokenRuntime,
  type LuckyTokenRuntime,
} from "./runtime.js";

export interface ConfiguredPiModelsOptions {
  readonly piDirectory: string;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  /** Test-only override for the built-in provider upstream endpoint. */
  readonly commandCodeBaseUrl?: string;
  readonly projectSnapshot?: ProjectSnapshot;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
}

export interface ConfiguredLuckyTokenCompositionOptions {
  readonly config: LuckyTokenCliConfig;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  /** Test-only override for the built-in provider upstream endpoint. */
  readonly commandCodeBaseUrl?: string;
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
  const mutableModels = createModels({
    credentials:
      options.credentials ??
      createFileCredentialStore(join(options.piDirectory, "auth.json")),
  });
  registerLuckyTokenProviders(mutableModels, {
    fetch: options.fetch,
    ...(options.commandCodeBaseUrl === undefined
      ? {}
      : { baseUrl: options.commandCodeBaseUrl }),
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
  const { models } = await createConfiguredPiModels({
    piDirectory: config.pi.directory,
    ...(options.credentials === undefined
      ? {}
      : { credentials: options.credentials }),
    fetch: options.fetch,
    ...(options.commandCodeBaseUrl === undefined
      ? {}
      : { commandCodeBaseUrl: options.commandCodeBaseUrl }),
    ...(options.projectSnapshot === undefined
      ? {}
      : { projectSnapshot: options.projectSnapshot }),
    createSessionId,
    now,
  });
  const providers = models.getProviders();
  const certifiedProvider = providers[0];
  if (certifiedProvider === undefined) {
    throw new Error("No LuckyToken built-in Provider is registered");
  }
  const certifiedModel = models
    .getModels()
    .find((entry) => entry.provider === certifiedProvider.id);
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
