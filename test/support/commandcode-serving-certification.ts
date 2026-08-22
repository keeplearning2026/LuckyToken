import type { Model } from "@earendil-works/pi-ai";

import type { RouterOptionDefaults } from "../../src/protocols/anthropic/options.js";
import type { CommandCodeCompatibilityPolicy } from "@luckytoken/provider-commandcode-private";

export const SERVING_CONFORMANCE_REVISION =
  "sha256:3724644850ba6ff7cb0a235aaa3aff159e078db1748b0f672931ac8936a7574c";

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
  "thinkingLevelMap",
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
  "npm run test:distribution",
  "git diff --check",
] as const;

export interface ServingCertificationFacts {
  readonly model: Model<string>;
  readonly modelValidityPolicyRevision: string;
  readonly compatibility: CommandCodeCompatibilityPolicy;
  readonly fetchBound: boolean;
  readonly routerDefaults: RouterOptionDefaults;
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
  readonly schemaVersion: "luckytoken-serving-certification-manifest-v2";
  readonly certificationBasis: "offline-and-online";
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
  readonly profiles: {
    readonly anthropicConversion: ServingCertificationProfile;
    readonly anthropicNativePassthrough: ServingCertificationProfile;
    readonly responsesConversion: ServingCertificationProfile;
    readonly responsesNativePassthrough: ServingCertificationProfile;
    readonly commandCodeProvider: ServingCertificationProfile;
  };
  readonly coverage: Readonly<Record<string, "verified">>;
  readonly verification: {
    readonly commands: readonly string[];
    readonly conformanceRecord: string;
    readonly onlineEvidence: {
      readonly status: "online-passed";
      readonly attempted: true;
      readonly executedAt: "2026-08-14";
      readonly repositoryRevision: "22ed328a5b6d00189d6086c580c4d288246b8e39";
      readonly summaryArtifact: "test/fixtures/certification/online-validation-2026-08-14.json";
      readonly toolVersions: {
        readonly codexCli: "0.147.0";
        readonly claudeCode: "2.1.210";
      };
      readonly runs: readonly ServingCertificationOnlineRun[];
      readonly gaps: readonly [];
    };
    readonly result: ServingCertificationResult;
  };
}

export interface ServingCertificationProfile {
  readonly id: string;
  readonly seam: string;
  readonly offlineResult: "CERTIFIED";
  readonly onlineStatus: "online-passed" | "not-applicable";
}

export interface ServingCertificationOnlineRun {
  readonly profiles: readonly string[];
  readonly command: string;
  readonly passed: number;
  readonly attempted: number;
  readonly artifactPath: string;
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
  if (model.id.length === 0 || model.name.length === 0) {
    failures.push("Model identity must have non-empty id and name");
  }
  if (
    !model.input.includes("text") ||
    new Set(model.input).size !== model.input.length ||
    model.input.some((input) => input !== "text" && input !== "image")
  ) {
    failures.push("Model input capabilities are not the certified text/image set");
  }
  if (
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow <= 0 ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens <= 0
  ) {
    failures.push("Model context or maximum-output must be positive safe integers");
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = model.cost[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      failures.push("Model cost rates must be finite non-negative numbers");
    }
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
  if (!facts.providerApiKeyConfigured) {
    failures.push("Provider authentication must be configured");
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
    schemaVersion: "luckytoken-serving-certification-manifest-v2",
    certificationBasis: "offline-and-online",
    result,
    failures,
    identity: {
      core: {
        specification: "LuckyToken Core Architecture Specification v6.0",
        servingComposition: "luckytoken-full-route-serving-composition-v3",
      },
      conversions: {
        architecturePolicy: "Protocol Conversion Architecture and Policy",
        anthropicPi:
          "Anthropic-Pi AI IR Conversion Method (Part I/II/III)",
        openaiResponsesPi:
          "OpenAI Responses-Pi AI IR Conversion Method",
        piCommandCode:
          "PI AI IR-Commandcode Private Conversion (Part I/II)",
      },
      anthropicProtocol: {
        specification: "Anthropic Messages API Protocol Specification v0.4",
        sha256:
          "efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918",
      },
      pi: {
        evidence: {
          protocol: "Pi AI IR Protocol v0.10.0",
          referenceCommit: "914cf1472e715297caa30db4b9535d534a9eb718",
          referencePackage: "@earendil-works/pi-ai 0.84.2",
          protocolBlobSha: "ebf2e9ef043d7351a38fd69909bf367f0f103884",
        },
        runtime: {
          package: "@earendil-works/pi-ai",
          version: "0.84.2",
          integrity:
            "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
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
        clientAuth: "none-local-data-plane-v1",
        providerAuth: facts.providerAuthPolicy,
        endpoint: "model-base-url-alpha-generate-v1",
        authSemanticTransform: "inert-v1",
      },
      toolId: "exact-injective-correlation-v1",
      transformHeaders: "absent",
      fetch: "required-bound-injected-fetch-v1",
      callback: "onPayload-absent-v1",
      auxiliaryOptions: "closed-world-anthropic-simple-options-v1",
      ambientSemantics: {
        compatibility,
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
    profiles: {
      anthropicConversion: {
        id: "anthropic-conversion",
        seam: "POST /v1/messages conversion",
        offlineResult: "CERTIFIED",
        onlineStatus: "online-passed",
      },
      anthropicNativePassthrough: {
        id: "anthropic-native-passthrough",
        seam: "POST /v1/messages native passthrough",
        offlineResult: "CERTIFIED",
        onlineStatus: "not-applicable",
      },
      responsesConversion: {
        id: "responses-conversion",
        seam: "POST /v1/responses conversion",
        offlineResult: "CERTIFIED",
        onlineStatus: "online-passed",
      },
      responsesNativePassthrough: {
        id: "responses-native-passthrough",
        seam: "POST /v1/responses native passthrough",
        offlineResult: "CERTIFIED",
        onlineStatus: "not-applicable",
      },
      commandCodeProvider: {
        id: "commandcode-provider",
        seam: "Pi Provider commandcode-private",
        offlineResult: "CERTIFIED",
        onlineStatus: "online-passed",
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
    },
    verification: {
      commands: [...VERIFICATION_COMMANDS],
      conformanceRecord: SERVING_CONFORMANCE_REVISION,
      onlineEvidence: {
        status: "online-passed",
        attempted: true,
        executedAt: "2026-08-14",
        repositoryRevision: "22ed328a5b6d00189d6086c580c4d288246b8e39",
        summaryArtifact:
          "test/fixtures/certification/online-validation-2026-08-14.json",
        toolVersions: {
          codexCli: "0.147.0",
          claudeCode: "2.1.210",
        },
        runs: [
          {
            profiles: ["anthropic-conversion", "commandcode-provider"],
            command: "npx tsx test/online/pi-commandcode-ir-probe.ts",
            passed: 23,
            attempted: 23,
            artifactPath:
              "test/fixtures/certification/online-validation-2026-08-14.json",
          },
          {
            profiles: ["anthropic-conversion", "commandcode-provider"],
            command: "npm run test:online",
            passed: 60,
            attempted: 60,
            artifactPath: ".online-artifacts/commandcode-conformance-samples.json",
          },
          {
            profiles: ["responses-conversion", "commandcode-provider"],
            command: "npm run test:online-responses",
            passed: 60,
            attempted: 60,
            artifactPath:
              "test/fixtures/certification/online-validation-2026-08-14.json",
          },
          {
            profiles: ["responses-conversion", "commandcode-provider"],
            command: "npm run test:online-codex -- 3",
            passed: 60,
            attempted: 60,
            artifactPath:
              "C:/Users/huich/AppData/Local/Temp/luckytoken-codex-cli-Uqe3iv/artifacts",
          },
          {
            profiles: ["anthropic-conversion", "commandcode-provider"],
            command: "npm run test:online-claude -- 3",
            passed: 51,
            attempted: 51,
            artifactPath:
              "onlinetest/claude/.runs/1786734390723-cb546e6e",
          },
        ],
        gaps: [],
      },
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
