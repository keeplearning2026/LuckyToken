import type { Model } from "@earendil-works/pi-ai";

import type { RouterOptionDefaults } from "./protocols/anthropic/options.js";
import type { CommandCodeCompatibilityPolicy } from "./providers/commandcode-private/provider.js";

export const SERVING_CONFORMANCE_REVISION =
  "sha256:b661ac6faa41132fc21ebc024ded09ad8311abc4e511120b8ab7444115b26958";

const CERTIFIED_PROVIDER_ID = "commandcode-private";
const CERTIFIED_API_ID = "commandcode-private";
const COMPATIBILITY_KEYS = new Set([
  "cliEnvironment",
  "ossPrimaryProvider",
  "permissionMode",
]);
const MODEL_KEYS = new Set([
  "id",
  "name",
  "api",
  "provider",
  "baseUrl",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
]);
const VERIFICATION_COMMANDS = [
  "npm test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "git diff --check",
  "npm run test:online",
] as const;

export interface ServingCertificationFacts {
  readonly model: Model<string>;
  readonly modelValidityPolicyRevision: string;
  readonly compatibility: CommandCodeCompatibilityPolicy;
  readonly fetchBound: boolean;
  readonly projectSnapshotPolicy:
    | "node-project-snapshot-v1"
    | "bound-injected-project-snapshot-v1";
  readonly projectAuthorizationPolicy:
    | "project-dir-absent-v1"
    | "fixed-authorized-project-dir-v1"
    | "per-client-protocol-token-file-v1";
  readonly clientAuthorityPolicy:
    | "bound-injected-auth-v1"
    | "handler-bound-file-snapshot-v1";
  readonly routerDefaults: RouterOptionDefaults;
  readonly clientAuthConfigured: boolean;
  readonly providerApiKeyConfigured: boolean;
  readonly providerAuthPolicy:
    | "fixed-api-key-header-v1"
    | "pi-models-credential-store-v1";
  readonly providerRegistrationPolicy:
    | "startup-only-mutable-models-v1"
    | "pi-models-json-startup-registration-v1";
  readonly maxRequestBytes: number;
  readonly requestTimeoutMs: number | null;
  readonly shutdownSignalBound: boolean;
  readonly messageIdPolicy:
    | "node-random-uuid-v1"
    | "bound-injected-message-id-v1";
  readonly sessionIdPolicy:
    | "node-random-uuid-v1"
    | "bound-injected-session-id-v1";
  readonly clockPolicy: "system-clock-v1" | "bound-injected-clock-v1";
  readonly syntheticHistoryIdentity: {
    readonly provider: string;
    readonly api: string;
  };
  readonly unresolvedSemanticLosses?: readonly string[];
}

export type ServingCertificationResult = "CERTIFIED" | "FAILED";

export interface ServingCertificationManifest {
  readonly schemaVersion: "luckytoken-serving-certification-manifest-v1";
  readonly result: ServingCertificationResult;
  readonly failures: readonly string[];
  readonly identity: Readonly<Record<string, unknown>>;
  readonly policies: {
    readonly sourceProfile: {
      readonly version: "2023-06-01";
      readonly betas: readonly string[];
    };
    readonly modelValidity: { readonly revision: string };
    readonly inboundBoundary: Readonly<Record<string, string>>;
    readonly authEndpoint: Readonly<Record<string, string>>;
    readonly toolId: string;
    readonly transformHeaders: string;
    readonly fetch: string;
    readonly callback: string;
    readonly auxiliaryOptions: string;
    readonly ambientSemantics: Readonly<Record<string, unknown>>;
    readonly models: Readonly<Record<string, string>>;
  };
  readonly coverage: Readonly<Record<string, "verified">>;
  readonly verification: {
    readonly commands: readonly string[];
    readonly conformanceRecord: string;
    readonly result: ServingCertificationResult;
  };
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreezePlainData(
  value: unknown,
  seen: Set<object> = new Set(),
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreezePlainData(nested, seen);
  Object.freeze(value);
}

function snapshotCompatibility(
  value: CommandCodeCompatibilityPolicy,
  failures: string[],
): CommandCodeCompatibilityPolicy {
  const snapshot: CommandCodeCompatibilityPolicy = {};
  for (const key of Object.keys(value)) {
    if (!COMPATIBILITY_KEYS.has(key)) {
      failures.push(`Unclassified CommandCode compatibility field: ${key}`);
    }
  }
  for (const key of [
    "cliEnvironment",
    "ossPrimaryProvider",
    "permissionMode",
  ] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "string") {
      failures.push(`CommandCode compatibility ${key} must be a string`);
      continue;
    }
    snapshot[key] = field;
  }
  return snapshot;
}

function resolveCertifiedEndpoint(baseUrl: string, failures: string[]): string {
  try {
    const base = new URL(baseUrl);
    if (
      (base.protocol !== "https:" && base.protocol !== "http:") ||
      base.username.length > 0 ||
      base.password.length > 0
    ) {
      throw new Error("unsupported endpoint policy");
    }
    return new URL("/alpha/generate", base).toString();
  } catch {
    failures.push("Model baseUrl is not a certifiable HTTP(S) endpoint");
    return "";
  }
}

function validateModel(model: Model<string>, failures: string[]): void {
  for (const key of Object.keys(model)) {
    if (!MODEL_KEYS.has(key)) {
      failures.push(`Unclassified model configuration field: ${key}`);
    }
  }
  if (model.provider !== CERTIFIED_PROVIDER_ID) {
    failures.push("Model provider does not match the certified Provider");
  }
  if (model.api !== CERTIFIED_API_ID) {
    failures.push("Model API does not match the certified API implementation");
  }
  if (model.id.length === 0 || model.name !== model.id) {
    failures.push("Model identity must be one non-empty exact id/name pair");
  }
  if (
    !model.input.includes("text") ||
    new Set(model.input).size !== model.input.length ||
    model.input.some((input) => input !== "text" && input !== "image")
  ) {
    failures.push("Model input capabilities are not the certified text/image set");
  }
  if (model.contextWindow !== 200_000 || model.maxTokens !== 64_000) {
    failures.push("Model context or maximum-output configuration drifted");
  }
  if (
    model.cost.input !== 0 ||
    model.cost.output !== 0 ||
    model.cost.cacheRead !== 0 ||
    model.cost.cacheWrite !== 0 ||
    model.cost.tiers !== undefined
  ) {
    failures.push("Model cost configuration drifted from the certified route");
  }
}

export function certifyServingComposition(
  facts: ServingCertificationFacts,
): ServingCertificationManifest {
  const failures: string[] = [];
  validateModel(facts.model, failures);
  const endpoint = resolveCertifiedEndpoint(facts.model.baseUrl, failures);
  const compatibility = snapshotCompatibility(facts.compatibility, failures);

  if (facts.modelValidityPolicyRevision.trim().length === 0) {
    failures.push("Anthropic model-validity policy revision is not immutable");
  }
  if (!facts.fetchBound) {
    failures.push("A bound fetch implementation is required; ambient fetch is prohibited");
  }
  if (!facts.clientAuthConfigured || !facts.providerApiKeyConfigured) {
    failures.push("Both client and Provider authentication must be configured");
  }
  if (Object.keys(facts.routerDefaults).length > 0) {
    failures.push("Router defaults contain unclassified ambient semantics");
  }
  if (!Number.isSafeInteger(facts.maxRequestBytes) || facts.maxRequestBytes <= 0) {
    failures.push("maxRequestBytes is not a positive safe integer");
  }
  if (
    facts.requestTimeoutMs !== null &&
    (!Number.isSafeInteger(facts.requestTimeoutMs) || facts.requestTimeoutMs <= 0)
  ) {
    failures.push("requestTimeoutMs is not a positive safe integer");
  }
  if (
    facts.syntheticHistoryIdentity.provider === facts.model.provider &&
    facts.syntheticHistoryIdentity.api === facts.model.api
  ) {
    failures.push("Reserved synthetic-history identity collides with the target");
  }
  for (const loss of facts.unresolvedSemanticLosses ?? []) {
    failures.push(`Unresolved reachable semantic loss: ${loss}`);
  }

  const result: ServingCertificationResult =
    failures.length === 0 ? "CERTIFIED" : "FAILED";
  const manifest: ServingCertificationManifest = {
    schemaVersion: "luckytoken-serving-certification-manifest-v1",
    result,
    failures,
    identity: {
      core: {
        specification: "LuckyToken Core Architecture Specification v5.6",
        servingComposition: "luckytoken-serving-composition-v2",
      },
      conversions: {
        anthropicPi:
          "Anthropic-Pi AI IR Conversion Method v1.2 / capability v2",
        piCommandCode:
          "LuckyToken CommandCode Private Provider Conversion Method v0.20",
      },
      anthropicProtocol: {
        specification: "Anthropic Messages API Protocol Specification v0.4",
        sha256:
          "efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918",
      },
      pi: {
        evidence: {
          protocol: "Pi AI IR Protocol v0.9.2",
          referenceCommit: "eb3c46d6ce28cb87147bb0d05645ebae28524713",
          referencePackage: "@earendil-works/pi-ai 0.84.1",
          protocolBlobSha: "a3dc09b846f2e49f73480d5e33c63aa009ff9a51",
        },
        runtime: {
          package: "@earendil-works/pi-ai",
          version: "0.84.1",
          integrity:
            "sha512-wMsAdJMxuNri08vLqTyYVI201DQQezGhPSTkzYsHdw5dYX3rCNwEmSvpaAwhi7ELKI/2tE/CEgSWg/6iRxSgdQ==",
        },
      },
      commandCode: {
        protocol: "CommandCode Private Protocol v1.3",
        profile: "command-code@1.9.0",
      },
      provider: {
        construction: "luckytoken-commandcode-private-provider-v1",
        providerId: CERTIFIED_PROVIDER_ID,
        apiId: CERTIFIED_API_ID,
      },
      model: {
        id: facts.model.id,
        name: facts.model.name,
        provider: facts.model.provider,
        api: facts.model.api,
        baseUrl: facts.model.baseUrl,
        endpoint,
        reasoning: facts.model.reasoning,
        input: [...facts.model.input],
        cost: { ...facts.model.cost },
        contextWindow: facts.model.contextWindow,
        maxTokens: facts.model.maxTokens,
      },
      conformanceRevision: SERVING_CONFORMANCE_REVISION,
    },
    policies: {
      sourceProfile: { version: "2023-06-01", betas: [] },
      modelValidity: { revision: facts.modelValidityPolicyRevision },
      inboundBoundary: {
        runtime: "whatwg-request-response-v1",
        listener: "node-http-adapter-v1",
        urlAuthority: "bound-origin-ignore-client-host-v1",
        cancellation: "disconnect-and-shutdown-abort-v1",
        responseTransfer: "status-headers-complete-bytes-v1",
      },
      authEndpoint: {
        clientAuth: "x-api-key-or-bearer-token-v1",
        clientAuthority: facts.clientAuthorityPolicy,
        providerAuth: facts.providerAuthPolicy,
        endpoint: "model-base-url-alpha-generate-v1",
        authSemanticTransform: "inert-v1",
        projectAuthorization: facts.projectAuthorizationPolicy,
      },
      toolId: "exact-injective-correlation-v1",
      transformHeaders: "absent",
      fetch: "required-bound-injected-fetch-v1",
      callback: "onPayload-absent-v1",
      auxiliaryOptions: "closed-world-anthropic-simple-options-v1",
      ambientSemantics: {
        compatibility,
        projectSnapshot: facts.projectSnapshotPolicy,
        routerDefaults: "empty-v1",
        globalFetchFallback: "prohibited-v1",
        maxRequestBytes: facts.maxRequestBytes,
        requestTimeoutMs: facts.requestTimeoutMs,
        shutdownSignal: facts.shutdownSignalBound ? "bound-live-v1" : "absent",
        messageId: facts.messageIdPolicy,
        sessionId: facts.sessionIdPolicy,
        clock: facts.clockPolicy,
      },
      models: {
        providerRegistration: facts.providerRegistrationPolicy,
        servingOperations: "unexposed-static-provider-v1",
        inFlight: "deep-frozen-invocation-and-bound-dependencies-v1",
      },
    },
    coverage: {
      inboundGrammarAndSemantics: "verified",
      piInvocationIntegrity: "verified",
      providerRequestResponseConversion: "verified",
      cancellationAndTerminalConsistency: "verified",
      outboundJsonAndAtomicSse: "verified",
      nextTurnRoundTrip: "verified",
      servingReadinessAndIsolation: "verified",
      localLoopbackHttpBoundary: "verified",
      piConfigurationCredentialCli: "verified",
      realProviderOnlineConformance: "verified",
      ...(facts.clientAuthorityPolicy === "handler-bound-file-snapshot-v1"
        ? { perClientProtocolAuthIsolation: "verified" as const }
        : {}),
    },
    verification: {
      commands: [...VERIFICATION_COMMANDS],
      conformanceRecord: SERVING_CONFORMANCE_REVISION,
      result,
    },
  };
  deepFreezePlainData(manifest);
  return manifest;
}

export class ServingCertificationFailure extends Error {
  readonly manifest: ServingCertificationManifest;

  constructor(manifest: ServingCertificationManifest) {
    super(`Serving composition certification failed: ${manifest.failures.join("; ")}`);
    this.name = "ServingCertificationFailure";
    this.manifest = manifest;
  }
}
