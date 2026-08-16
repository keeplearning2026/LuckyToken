import {
  createModels,
  type CredentialStore,
  type FetchFunction,
  type Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { createAuth } from "./auth.js";
import {
  certifyCoreServingComposition,
  type CoreServingCertificationManifest,
} from "./core-serving-certification.js";
import { createInvocationDiagnosticsFactory } from "./invocation-diagnostics/index.js";
import {
  bindRuntimeDiagnosticsConfiguration,
  createRuntimeDiagnosticsStoreFactory,
  type RuntimeDiagnosticsStore,
} from "./runtime-diagnostics/index.js";
import { bindAnthropicConfiguration } from "./protocols/anthropic/configuration.js";
import { bindOpenAIResponsesConfiguration } from "./protocols/openai-responses/configuration.js";
import {
  loadFileClientTokenAuthority,
  type ClientTokenAuthority,
} from "./client-auth/file-token-store.js";
import type { LuckyTokenCliConfig } from "./cli-config.js";
import type { ClientProtocolHandler } from "./http.js";
import { createModelsDiscoveryHandler } from "./models-discovery.js";
import { createFileCredentialStore } from "./pi/file-credential-store.js";
import { loadModelsJson } from "./providers/models-json.js";
import { registerLuckyTokenProviders } from "./providers/catalog.js";
import {
  loadProviderPackages,
  type ImportProviderModule,
} from "./providers/package-loader.js";
import {
  anthropicMessagesProtocolId,
  createAnthropicMessagesHandler,
} from "./protocols/anthropic/handler.js";
import {
  createOpenAIResponsesHandler,
  openaiResponsesProtocolId,
} from "./protocols/openai-responses/handler.js";
import {
  createLuckyTokenRuntime,
  type LuckyTokenRuntime,
} from "./runtime.js";
import { createProtocolAwareRuntime } from "./settings/runtime.js";
import type { SettingsRegistry } from "./settings/catalog.js";

export interface ConfiguredPiModelsOptions {
  readonly piDirectory: string;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  /** Optional models.json path; absent means no user-registered providers. */
  readonly modelsJsonPath?: string;
  readonly providerPackages?: Readonly<Record<string, unknown>>;
  readonly importModule?: ImportProviderModule;
  readonly createUuid?: () => string;
  readonly now?: () => number;
  /**
   * Called when models.json exists but cannot be parsed or validated
   * (Ticket 08): the gateway keeps running without models.json providers and
   * the Control Plane authority exposes the exact file error instead of
   * bricking the data plane.
   */
  readonly onInvalidModelsJson?: (error: unknown) => void;
}

/**
 * Builds the narrow known-value scrubber (Ticket 07 F4) from every
 * credential owner: Client Protocol token authorities expose their own
 * scrub operation, and the Pi CredentialStore exposes only non-secret
 * metadata plus per-provider reads through the standard contract.
 */
async function createCompositionScrubber(
  owners: {
    readonly clientAuthority: ClientTokenAuthority;
    readonly responsesAuthority?: ClientTokenAuthority;
    readonly credentials?: CredentialStore;
  },
): Promise<((value: string) => string) | undefined> {
  const scrubbers: Array<(value: string) => string> = [];
  scrubbers.push(owners.clientAuthority.scrub);
  if (owners.responsesAuthority !== undefined) {
    scrubbers.push(owners.responsesAuthority.scrub);
  }
  if (owners.credentials !== undefined) {
    const listed = await owners.credentials.list().catch(() => undefined);
    if (listed !== undefined) {
      for (const info of listed) {
        const credential = await owners.credentials
          .read(info.providerId)
          .catch(() => undefined);
        if (credential === undefined) continue;
        const values: string[] = [];
        if (credential.type === "api_key") {
          if (credential.key !== undefined) values.push(credential.key);
          if (credential.env !== undefined) values.push(...Object.values(credential.env));
        } else {
          values.push(credential.access, credential.refresh);
        }
        const escape = (text: string): string =>
          text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const pattern = new RegExp(
          values.filter((value) => value.length > 0).map(escape).join("|"),
          "gu",
        );
        if (values.some((value) => value.length > 0)) {
          scrubbers.push((value: string) => value.replace(pattern, "[REDACTED]"));
        }
      }
    }
  }
  if (scrubbers.length === 0) return undefined;
  return (value: string) => {
    let redacted = value;
    for (const scrub of scrubbers) redacted = scrub(redacted);
    return redacted;
  };
}

export interface ConfiguredLuckyTokenCompositionOptions {
  readonly config: LuckyTokenCliConfig;
  readonly credentials?: CredentialStore;
  readonly fetch: FetchFunction;
  readonly importModule?: ImportProviderModule;
  readonly createMessageId?: () => string;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
  readonly shutdownSignal?: AbortSignal;
  /**
   * Reuse an already-open Runtime Diagnostics store (Ticket 07), e.g. the
   * one the Control Plane host owns. When absent the composition opens and
   * returns its own store, which the caller must close.
   */
  readonly diagnosticsStore?: RuntimeDiagnosticsStore;
  /** Registered settings authority for protocol enablement; when absent every
   *  configured protocol is served (Ticket 03 behavior). */
  readonly settingsRegistry?: SettingsRegistry;
  /** See `ConfiguredPiModelsOptions.onInvalidModelsJson`. */
  readonly onInvalidModelsJson?: (error: unknown) => void;
}

export interface ConfiguredLuckyTokenComposition {
  readonly runtime: LuckyTokenRuntime;
  readonly certification: CoreServingCertificationManifest;
  /** User-configured models.json and external Provider Package registrations. */
  readonly userConfiguredProviderIds: readonly string[];
  /** Permanent Runtime Diagnostics store (Ticket 07). */
  readonly diagnosticsStore: RuntimeDiagnosticsStore;
}

export async function createConfiguredPiModels(
  options: ConfiguredPiModelsOptions,
): Promise<{
  models: Models;
  externalProviderIds: readonly string[];
  userConfiguredProviderIds: readonly string[];
}> {
  // A broken models.json must never brick the data plane (Ticket 08): the
  // gateway starts without models.json providers and the Control Plane
  // authority exposes the exact file error for inspection instead.
  let modelsJson: Awaited<ReturnType<typeof loadModelsJson>>;
  try {
    modelsJson = await loadModelsJson(options.modelsJsonPath);
  } catch (error) {
    modelsJson = undefined;
    options.onInvalidModelsJson?.(error);
  }
  const mutableModels = createModels({
    credentials:
      options.credentials ??
      createFileCredentialStore(join(options.piDirectory, "auth.json")),
  });
  const modelsJsonProviderIds = registerLuckyTokenProviders(mutableModels, {
    ...(modelsJson === undefined ? {} : { modelsJson }),
  });
  const loaded = await loadProviderPackages({
    models: mutableModels,
    providerPackages: options.providerPackages ?? {},
    host: Object.freeze({
      fetch: options.fetch,
      now: options.now ?? Date.now,
      createUuid: options.createUuid ?? randomUUID,
    }),
    ...(options.importModule === undefined
      ? {}
      : { importModule: options.importModule }),
  });
  const models: Models = mutableModels;
  return Object.freeze({
    models,
    externalProviderIds: loaded.providerIds,
    userConfiguredProviderIds: Object.freeze([
      ...modelsJsonProviderIds,
      ...loaded.providerIds,
    ]),
  });
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
  const openaiResponsesConfig = Object.hasOwn(
    config.clientProtocols,
    openaiResponsesProtocolId,
  )
    ? config.clientProtocols[openaiResponsesProtocolId]
    : undefined;
  const responsesAuthority =
    openaiResponsesConfig === undefined
      ? undefined
      : await loadFileClientTokenAuthority(openaiResponsesConfig.authFile);
  const { models, externalProviderIds, userConfiguredProviderIds } =
    await createConfiguredPiModels({
      piDirectory: config.pi.directory,
      modelsJsonPath: config.pi.modelsJson,
      ...(options.credentials === undefined
        ? {}
        : { credentials: options.credentials }),
      fetch: options.fetch,
      providerPackages: config.providerPackages,
      ...(options.importModule === undefined
        ? {}
        : { importModule: options.importModule }),
      ...(options.onInvalidModelsJson === undefined
        ? {}
        : { onInvalidModelsJson: options.onInvalidModelsJson }),
      createUuid: createSessionId,
      now,
    });
  // F4: build the narrow known-value scrubber from every credential owner.
  // Each authority exposes only a scrub operation; no raw-secret arrays flow
  // through unrelated modules.
  const scrub = await createCompositionScrubber({
    clientAuthority,
    ...(responsesAuthority === undefined ? {} : { responsesAuthority }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
  const invocationDiagnostics = createInvocationDiagnosticsFactory({
    configuration: config.failureLogging,
    now,
    ...(scrub === undefined ? {} : { scrub }),
  });
  const diagnosticsStore: RuntimeDiagnosticsStore =
    options.diagnosticsStore ??
    (await createRuntimeDiagnosticsStoreFactory({
      configuration: bindRuntimeDiagnosticsConfiguration(
        config.runtimeDiagnostics,
      ),
      now,
      ...(scrub === undefined ? {} : { scrub }),
    }).open());
  // Attach the known-value scrubber to a caller-provided store (F4): the
  // store opened before credential authorities resolved in `serve`.
  if (options.diagnosticsStore !== undefined && scrub !== undefined) {
    diagnosticsStore.attachScrub(scrub);
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
    passthroughFetch: options.fetch,
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    maxRequestBytes: config.limits.maxRequestBytes,
    now,
  });
  const clientProtocols: ClientProtocolHandler[] = [anthropic];
  // Shared, unauthenticated model discovery: any client may learn the
  // selectors this endpoint serves, independent of Client Protocol Auth.
  clientProtocols.push(
    createModelsDiscoveryHandler({
      models,
      providerIds: externalProviderIds,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
  if (openaiResponsesConfig !== undefined && responsesAuthority !== undefined) {
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
      passthroughFetch: options.fetch,
      maxRequestBytes: config.limits.maxRequestBytes,
      ...(options.shutdownSignal === undefined
        ? {}
        : { shutdownSignal: options.shutdownSignal }),
      now,
    });
    clientProtocols.push(responses);
  }
  const certification = certifyCoreServingComposition({
    clientProtocolIds: Object.keys(config.clientProtocols),
    providerIds: models.getProviders().map((provider) => provider.id),
    maxRequestBytes: config.limits.maxRequestBytes,
    requestTimeoutMs: config.limits.requestTimeoutMs,
  });
  const baseRuntime = createLuckyTokenRuntime({
    clientProtocols,
    requestTimeoutMs: config.limits.requestTimeoutMs,
    ...(options.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.shutdownSignal }),
  });
  const registry = options.settingsRegistry;
  const runtime =
    registry === undefined
      ? baseRuntime
      : createProtocolAwareRuntime({
          runtime: baseRuntime,
          registry,
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
          ],
        });
  return Object.freeze({
    runtime,
    certification,
    userConfiguredProviderIds,
    diagnosticsStore,
  });
}
