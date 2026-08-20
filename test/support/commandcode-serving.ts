import {
  createModels,
  type FetchFunction,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { AliasModelSource } from "../../src/alias-model-seam.js";
import type { RequestLedger } from "../../src/request-ledger/index.js";
import type { DeepCaptureAuthority } from "../../src/deep-diagnostics/index.js";
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
import { resolveUsageSemantics } from "../../src/providers/usage-declarations.js";
import { createExecutionOperation } from "../../src/execution.js";
import type { UsageSemanticsResolver } from "@luckytoken/provider-contract/usage";

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
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  shutdownSignal?: AbortSignal;
  routerDefaults?: RouterOptionDefaults;
  anthropicModelValidityPolicy?: AnthropicModelValidityPolicy;
  now?: () => number;
  invocationDiagnostics?: InvocationDiagnosticsFactory;
  /** Ticket 18 Request Lifecycle Ledger observer; absent means the handler
   *  uses its no-op observer. */
  requestLedger?: RequestLedger;
  /** Ticket 22 Deep Diagnostics capture authority; absent means the handler
   *  uses its no-op authority. */
  deepCapture?: DeepCaptureAuthority;
  /** Ticket 15 alias-only data plane seam (handler-level test stub). */
  aliasSource?: AliasModelSource;
  /** Ticket 20 usage-semantics resolver; defaults to the real Provider
   *  integration declaration table, mirroring the production composition. */
  resolveUsageSemantics?: UsageSemanticsResolver;
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
      compatibility: compatibilitySource,
      createSessionId,
    }),
  );
  const models: Models = mutableModels;
  const anthropic = createAnthropicMessagesHandler({
    models,
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
    ...(options.requestLedger === undefined
      ? {}
      : { requestLedger: options.requestLedger }),
    ...(options.deepCapture === undefined
      ? {}
      : { deepCapture: options.deepCapture }),
    ...(options.aliasSource === undefined
      ? {}
      : { aliasSource: options.aliasSource }),
    ...(options.resolveUsageSemantics === undefined
      ? { executeOperation: createExecutionOperation(resolveUsageSemantics) }
      : {
          executeOperation: createExecutionOperation(
            options.resolveUsageSemantics,
          ),
        }),
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
