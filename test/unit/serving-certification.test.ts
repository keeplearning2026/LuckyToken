import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  certifyServingComposition,
  type ServingCertificationFacts,
} from "../support/commandcode-serving-certification.js";
import { freezePiInvocation } from "../../src/execution.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
} from "../../packages/provider-commandcode-private/src/provider.js";
import {
  SYNTHETIC_CLIENT_HISTORY_API,
  SYNTHETIC_CLIENT_HISTORY_PROVIDER,
} from "../../src/protocols/anthropic/request.js";

function model(): Model<typeof commandCodePrivateApiId> {
  return {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash (latest)",
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: "https://commandcode.example/nested",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text"],
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}

function facts(
  overrides: Partial<ServingCertificationFacts> = {},
): ServingCertificationFacts {
  return {
    model: model(),
    modelValidityPolicyRevision: "fixture-model-validity-v1",
    compatibility: {},
    fetchBound: true,
    routerDefaults: {},
    providerApiKeyConfigured: true,
    providerAuthPolicy: "fixed-api-key-header-v1",
    providerRegistrationPolicy: "startup-only-mutable-models-v1",
    maxRequestBytes: 1_048_576,
    requestTimeoutMs: null,
    shutdownSignalBound: false,
    messageIdPolicy: "node-random-uuid-v1",
    sessionIdPolicy: "node-random-uuid-v1",
    clockPolicy: "system-clock-v1",
    syntheticHistoryIdentity: {
      provider: SYNTHETIC_CLIENT_HISTORY_PROVIDER,
      api: SYNTHETIC_CLIENT_HISTORY_API,
    },
    ...overrides,
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeeplyFrozen(nested);
}

describe("serving composition certification", () => {
  it("binds every immutable identity and serving policy in one frozen manifest", () => {
    const manifest = certifyServingComposition(facts());

    expect(manifest).toMatchObject({
      schemaVersion: "luckytoken-serving-certification-manifest-v2",
      certificationBasis: "offline-and-online",
      result: "CERTIFIED",
      failures: [],
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
          providerId: "commandcode-private",
          apiId: "commandcode-private",
        },
        model: {
          id: "deepseek/deepseek-v4-flash",
          endpoint: "https://commandcode.example/alpha/generate",
          input: ["text"],
          contextWindow: 1_000_000,
          maxTokens: 64_000,
        },
        conformanceRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      policies: {
        sourceProfile: { version: "2023-06-01", betas: [] },
        modelValidity: { revision: "fixture-model-validity-v1" },
        inboundBoundary: {
          runtime: "whatwg-request-response-v1",
          listener: "node-http-adapter-v1",
          urlAuthority: "bound-origin-ignore-client-host-v1",
          cancellation: "disconnect-and-shutdown-abort-v1",
          responseTransfer: "status-headers-complete-bytes-v1",
        },
        authEndpoint: {
          clientAuth: "none-local-data-plane-v1",
          providerAuth: "fixed-api-key-header-v1",
          endpoint: "model-base-url-alpha-generate-v1",
          authSemanticTransform: "inert-v1",
        },
        toolId: "exact-injective-correlation-v1",
        transformHeaders: "absent",
        fetch: "required-bound-injected-fetch-v1",
        callback: "onPayload-absent-v1",
        auxiliaryOptions: "closed-world-anthropic-simple-options-v1",
        ambientSemantics: {
          compatibility: {},
          routerDefaults: "empty-v1",
          globalFetchFallback: "prohibited-v1",
        },
        models: {
          providerRegistration: "startup-only-mutable-models-v1",
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
      verification: {
        commands: [
          "npm test",
          "npm run typecheck",
          "npm run lint",
          "npm run build",
          "npm run test:distribution",
          "git diff --check",
        ],
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
            expect.objectContaining({
              command: "npx tsx test/online/pi-commandcode-ir-probe.ts",
              passed: 23,
              attempted: 23,
            }),
            expect.objectContaining({
              command: "npm run test:online",
              passed: 60,
              attempted: 60,
            }),
            expect.objectContaining({
              command: "npm run test:online-responses",
              passed: 60,
              attempted: 60,
            }),
            expect.objectContaining({
              command: "npm run test:online-codex -- 3",
              passed: 60,
              attempted: 60,
            }),
            expect.objectContaining({
              command: "npm run test:online-claude -- 3",
              passed: 51,
              attempted: 51,
            }),
          ],
          gaps: [],
        },
        result: "CERTIFIED",
      },
    });
    expectDeeplyFrozen(manifest);
  });

  it("publishes Pi config and credential ownership only when those facts are bound", () => {
    const manifest = certifyServingComposition(
      facts({
        providerAuthPolicy: "pi-models-credential-store-v1",
        providerRegistrationPolicy: "pi-models-json-startup-registration-v1",
      }),
    );

    expect(manifest.policies.authEndpoint.providerAuth).toBe(
      "pi-models-credential-store-v1",
    );
    expect(manifest.policies.models.providerRegistration).toBe(
      "pi-models-json-startup-registration-v1",
    );
  });

  it("certifies the local data plane as having no LuckyToken client auth", () => {
    const manifest = certifyServingComposition(facts());
    expect(manifest.policies.authEndpoint.clientAuth).toBe(
      "none-local-data-plane-v1",
    );
    expect(manifest.coverage).not.toHaveProperty("perClientProtocolAuthIsolation");
  });

  it.each([
    {
      name: "an unresolved reachable loss",
      override: { unresolvedSemanticLosses: ["reachable pause_turn"] },
      failure: "reachable pause_turn",
    },
    {
      name: "a synthetic target identity collision",
      override: {
        syntheticHistoryIdentity: {
          provider: commandCodePrivateProviderId,
          api: commandCodePrivateApiId,
        },
      },
      failure: "synthetic-history identity",
    },
    {
      name: "an ambient fetch fallback",
      override: { fetchBound: false },
      failure: "fetch",
    },
    {
      name: "unclassified router defaults",
      override: { routerDefaults: { temperature: 1 } },
      failure: "Router defaults",
    },
  ])("marks $name FAILED", ({ override, failure }) => {
    const manifest = certifyServingComposition(facts(override));

    expect(manifest.result).toBe("FAILED");
    expect(manifest.verification.result).toBe("FAILED");
    expect(manifest.failures.join(" ")).toContain(failure);
    expectDeeplyFrozen(manifest);
  });

  it("deep-freezes Model, Context, and options without freezing the live AbortSignal", () => {
    const signal = new AbortController().signal;
    const invocationModel = model();
    const context = {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hello" }],
          timestamp: 1,
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    };
    const options = {
      maxTokens: 10,
      signal,
      metadata: { user_id: "user", projectDir: "D:/project" },
    };

    freezePiInvocation(invocationModel, context, options);

    expectDeeplyFrozen(invocationModel);
    expectDeeplyFrozen(context);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.metadata)).toBe(true);
    expect(Object.isFrozen(signal)).toBe(false);
  });
});
