import type { FetchFunction, Models } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { LuckyTokenCliConfig } from "./cli-config.js";
import {
  certifyCoreServingComposition,
  type CoreServingCertificationManifest,
} from "./core-serving-certification.js";
import type { CodexNativeModelSource } from "./codex-native-seam.js";
import type { RequestJourneyObservationAuthority } from "./diagnostics/contract.js";
import { createExecutionOperation } from "./execution.js";
import type { ProviderAuthBindingAuthority } from "./credentials/profile-contract.js";
import { credentialActivityForExecutionFacts } from "./credentials/activity.js";
import type { ClientProtocolHandler } from "./http.js";
import { createCodexDirectCompactLane } from "./integrations/codex/local-compact.js";
import { createCodexDirectResponsesLane } from "./integrations/codex/local-responses.js";
import { createCodexDirectSearchHandler } from "./integrations/codex/local-search.js";
import {
  createCodexDirectImagesEditsHandler,
  createCodexDirectImagesGenerationsHandler,
} from "./integrations/codex/local-images.js";
import {
  createCodexDirectRealtimeModule,
} from "./integrations/codex/local-realtime.js";
import { createModelsDiscoveryHandler } from "./models-discovery.js";
import type { PublicModelSource } from "./public-model-seam.js";
import { createAnthropicProviderNativeLane } from "./provider-native-anthropic/index.js";
import { createProviderNativeResponses } from "./provider-native-responses/index.js";
import { bindProviderNativeResponsesConfiguration } from "./provider-native-responses/configuration.js";
import { resolveRequestModel } from "./providers/request-composition.js";
import { resolveUsageSemantics } from "./providers/usage-declarations.js";
import { bindAnthropicConfiguration } from "./protocols/anthropic/configuration.js";
import {
  anthropicMessagesProtocolId,
  createAnthropicMessagesHandler,
} from "./protocols/anthropic/handler.js";
import { createOpenAIResponsesCompactHandler } from "./protocols/openai-responses/compact.js";
import { bindOpenAIResponsesConfiguration } from "./protocols/openai-responses/configuration.js";
import {
  createOpenAIResponsesHandler,
  openaiResponsesProtocolId,
} from "./protocols/openai-responses/handler.js";
import { createResponseSessionState } from "./protocols/openai-responses/session-state.js";
import { createLuckyTokenRuntime, type LuckyTokenRuntime } from "./runtime.js";
import { createProtocolAwareRuntime } from "./settings/runtime.js";
import { createProfileBoundPiExecution } from "./credentials/profile-bound-pi-execution.js";
import type { WebSocketUpgradeHandler } from "./websocket-upgrade.js";

export type DataPlaneConfiguration = Readonly<
  Pick<
    LuckyTokenCliConfig,
    "configPath" | "clientProtocols" | "limits"
  >
>;

/** Everything serving needs from its Backend owner. Provider construction,
 * persistence stores, settings mutation, and credential representation stay
 * outside this Interface. */
export interface ConfiguredLuckyTokenDataPlaneOptions {
  readonly configuration: DataPlaneConfiguration;
  readonly models: Models;
  readonly providerAuthBindings: ProviderAuthBindingAuthority;
  readonly publicModels: PublicModelSource;
  readonly diagnostics?: RequestJourneyObservationAuthority;
  readonly isProtocolEnabled: (protocolId: string) => boolean;
  readonly fetch: FetchFunction;
  readonly codexNativeModels?: CodexNativeModelSource;
  readonly createMessageId?: () => string;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
  readonly shutdownSignal?: AbortSignal;
}

export interface ConfiguredLuckyTokenDataPlane {
  readonly runtime: LuckyTokenRuntime;
  readonly certification: CoreServingCertificationManifest;
  readonly webSocketUpgrade?: WebSocketUpgradeHandler;
  /** Finalize protocol-owned resources after request execution is quiescent. */
  close(): Promise<void>;
}

export async function createConfiguredLuckyTokenDataPlane(
  options: ConfiguredLuckyTokenDataPlaneOptions,
): Promise<ConfiguredLuckyTokenDataPlane> {
  const config = options.configuration;
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
  const responsesConfig = Object.hasOwn(
    config.clientProtocols,
    openaiResponsesProtocolId,
  )
    ? config.clientProtocols[openaiResponsesProtocolId]
    : undefined;
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? randomUUID;
  const semanticExecution = createProfileBoundPiExecution({
    bindings: options.providerAuthBindings,
    execute: createExecutionOperation(resolveUsageSemantics),
    resolveCredentialActivity: credentialActivityForExecutionFacts,
  });
  const anthropicProviderNativeLane = createAnthropicProviderNativeLane({
    models: options.models,
    bindings: options.providerAuthBindings,
    resolveRequestModel,
    fetch: options.fetch,
  });

  const anthropic = createAnthropicMessagesHandler({
    models: options.models,
    createSessionId,
    configuration: bindAnthropicConfiguration(
      anthropicConfig.adapterConfiguration,
    ),
    providerNativeLane: anthropicProviderNativeLane,
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    publicModels: options.publicModels,
    maxRequestBytes: config.limits.maxRequestBytes,
    now,
    executeOperation: semanticExecution,
  });
  const handlers: ClientProtocolHandler[] = [
    anthropic,
    createModelsDiscoveryHandler({
      models: options.models,
      publicModels: options.publicModels,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  ];
  const realtime = createCodexDirectRealtimeModule({ fetch: options.fetch });
  const webSocketUpgrade = realtime.webSocketUpgrade;
  handlers.push(
    createCodexDirectSearchHandler({
      fetch: options.fetch,
      maxRequestBytes: config.limits.maxRequestBytes,
    }),
    createCodexDirectImagesGenerationsHandler({
      fetch: options.fetch,
      maxRequestBytes: config.limits.maxRequestBytes,
    }),
    createCodexDirectImagesEditsHandler({
      fetch: options.fetch,
      maxRequestBytes: config.limits.maxRequestBytes,
    }),
    ...realtime.httpHandlers,
  );

  let finalizeResponsesState: (() => Promise<void>) | undefined;
  if (responsesConfig !== undefined) {
    const stateFile =
      responsesConfig.stateFile ??
      join(dirname(config.configPath), "state", "openai-responses.json");
    const providerNativeLane = createProviderNativeResponses({
      models: options.models,
      bindings: options.providerAuthBindings,
      fetch: options.fetch,
      configuration: bindProviderNativeResponsesConfiguration(
        responsesConfig.providerNativeConfiguration,
      ),
    });
    const directLane =
      options.codexNativeModels === undefined
        ? undefined
        : createCodexDirectResponsesLane({
            models: options.codexNativeModels,
            fetch: options.fetch,
          });
    const directCompactLane =
      options.codexNativeModels === undefined
        ? undefined
        : createCodexDirectCompactLane({
            models: options.codexNativeModels,
            fetch: options.fetch,
          });
    const configuration = bindOpenAIResponsesConfiguration(
      responsesConfig.adapterConfiguration,
    );
    const sessionState = createResponseSessionState({
      stateFile,
      storeFalsePolicy: configuration.conversion.response.storeFalse,
    });
    finalizeResponsesState = () => sessionState.flush();
    handlers.push(
      createOpenAIResponsesHandler({
        models: options.models,
        createSessionId,
        configuration,
        stateFile,
        sessionState,
        providerNativeLane,
        publicModels: options.publicModels,
        maxRequestBytes: config.limits.maxRequestBytes,
        now,
        executeOperation: semanticExecution,
        ...(directLane === undefined ? {} : { directLane }),
      }),
      createOpenAIResponsesCompactHandler({
        models: options.models,
        publicModels: options.publicModels,
        ...(directCompactLane === undefined
          ? {}
          : { directLane: directCompactLane }),
        providerNativeLane,
        configuration,
        stateFile,
        sessionState,
        createSessionId,
        executeOperation: semanticExecution,
        maxRequestBytes: config.limits.maxRequestBytes,
        now,
      }),
    );
  }

  const certification = certifyCoreServingComposition({
    clientProtocolIds: Object.keys(config.clientProtocols),
    providerIds: options.models.getProviders().map((provider) => provider.id),
    maxRequestBytes: config.limits.maxRequestBytes,
    requestTimeoutMs: config.limits.requestTimeoutMs,
  });
  const baseRuntime = createLuckyTokenRuntime({
    clientProtocols: handlers,
    requestTimeoutMs: config.limits.requestTimeoutMs,
    ...(options.diagnostics === undefined
      ? {}
      : { diagnostics: options.diagnostics }),
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
  });
  const runtime = createProtocolAwareRuntime({
    runtime: baseRuntime,
    isProtocolEnabled: options.isProtocolEnabled,
    protocolRoutes: [
      {
        id: anthropicMessagesProtocolId,
        method: "POST",
        pathname: "/v1/messages",
      },
      {
        id: openaiResponsesProtocolId,
        method: "POST",
        pathname: "/v1/responses",
      },
      {
        id: openaiResponsesProtocolId,
        method: "POST",
        pathname: "/v1/responses/compact",
      },
    ],
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    runtime,
    certification,
    ...(webSocketUpgrade === undefined ? {} : { webSocketUpgrade }),
    close(): Promise<void> {
      closePromise ??= finalizeResponsesState?.() ?? Promise.resolve();
      return closePromise;
    },
  });
}
