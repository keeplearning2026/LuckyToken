import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  certifyServingComposition,
  freezeCertifiedInvocation,
  type ServingCertificationFacts,
} from "../../src/certification.js";
import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
} from "../../src/providers/commandcode-private/provider.js";
import {
  SYNTHETIC_CLIENT_HISTORY_API,
  SYNTHETIC_CLIENT_HISTORY_PROVIDER,
} from "../../src/protocols/anthropic/request.js";

function model(): Model<typeof commandCodePrivateApiId> {
  return {
    id: "claude-certified",
    name: "claude-certified",
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: "https://commandcode.example/nested",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
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
    projectSnapshotPolicy: "node-project-snapshot-v1",
    projectAuthorizationPolicy: "project-dir-absent-v1",
    routerDefaults: {},
    clientApiKeyConfigured: true,
    providerApiKeyConfigured: true,
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
      schemaVersion: "luckytoken-serving-certification-manifest-v1",
      result: "CERTIFIED",
      failures: [],
      identity: {
        core: {
          specification: "LuckyToken Core Architecture Specification v5.5",
          servingComposition: "luckytoken-serving-composition-v1",
        },
        conversions: {
          anthropicPi: "Anthropic-Pi AI IR Conversion Method v1.1 / capability v1",
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
          providerId: "commandcode-private",
          apiId: "commandcode-private",
        },
        model: {
          id: "claude-certified",
          endpoint: "https://commandcode.example/alpha/generate",
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
        conformanceRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      policies: {
        sourceProfile: { version: "2023-06-01", betas: [] },
        modelValidity: { revision: "fixture-model-validity-v1" },
        authEndpoint: {
          clientAuth: "fixed-bearer-token-v1",
          providerAuth: "fixed-api-key-header-v1",
          endpoint: "model-base-url-alpha-generate-v1",
          authSemanticTransform: "inert-v1",
          projectAuthorization: "project-dir-absent-v1",
        },
        toolId: "exact-injective-correlation-v1",
        transformHeaders: "absent",
        fetch: "required-bound-injected-fetch-v1",
        callback: "onPayload-absent-v1",
        auxiliaryOptions: "closed-world-anthropic-simple-options-v1",
        ambientSemantics: {
          compatibility: {},
          projectSnapshot: "node-project-snapshot-v1",
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
      },
      verification: {
        commands: [
          "npm test",
          "npm run typecheck",
          "npm run lint",
          "npm run build",
          "git diff --check",
        ],
        result: "CERTIFIED",
      },
    });
    expectDeeplyFrozen(manifest);
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

    freezeCertifiedInvocation(invocationModel, context, options);

    expectDeeplyFrozen(invocationModel);
    expectDeeplyFrozen(context);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.metadata)).toBe(true);
    expect(Object.isFrozen(signal)).toBe(false);
  });
});
