import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  AdvanceAfterFinal429Input,
  ManagedProviderAuthBindingCapture,
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsManagementAuthority,
  type RequestJourneyCloseInput,
  type RequestJourneyObservationAuthority,
} from "../../src/diagnostics/index.js";
import type { ExecutionOperation } from "../../src/execution.js";
import {
  createProviderNativeResponses,
} from "../../src/provider-native-responses/index.js";
import { parseProviderNativeResponsesConfiguration } from "../../src/provider-native-responses/configuration.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "64000000-0000-4000-8000-000000000001";
const SESSION_ID = "64000000-0000-4000-8000-000000000002";
const PROFILE_A = "openai-profile-a";
const PROFILE_B = "openai-profile-b";
const PROVIDER_TOKEN_A = "provider-openai-token-a-19c06e";
const PROVIDER_TOKEN_B = "provider-openai-token-b-704ad1";
const CLIENT_TOKEN = "client-openai-token-canary-b2e7c8";
const CLIENT_COOKIE = "client-cookie-canary-a83f62";
const UPSTREAM_COOKIE = "provider-set-cookie-canary-1ca58d";
const PRIMARY_LOCATION = {
  phase: "upstream_execution",
  lane: "provider_native",
  step: "advance_provider_profile",
  attempt: 2,
} as const;
const CLIENT_PRESENTATION_LOCATION = {
  phase: "client_response_preparation",
  lane: "provider_native",
  step: "prepare_provider_native_error_response",
} as const;
const WORK_OUTCOME_LOCATION = {
  phase: "outcome_commit",
  lane: "provider_native",
  step: "commit_request_outcome",
} as const;

function openAIModel(): Model<string> {
  return {
    id: "gpt-native",
    name: "GPT Native",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://provider.example.com/v1",
    headers: { "x-provider-static": "provider-owned" },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function managedCapture(
  credentialId: string,
  displayName: string,
): ManagedProviderAuthBindingCapture {
  return Object.freeze({
    facts: Object.freeze({
      kind: "managed" as const,
      providerId: "openai",
      credentialId,
      authType: "api_key" as const,
      authMethodLabel: "API key",
      displayName,
      credentialGeneration: `credential-generation:${credentialId}`,
      selectionGeneration: `selection-generation:${credentialId}`,
    }),
  });
}

interface TransitionFact {
  readonly fromProfileId: string;
  readonly attemptedProfileIds: readonly string[];
  readonly retryAfterMs?: number;
  readonly outcome: "switched" | "exhausted";
}

interface OutboundAttempt {
  readonly attempt: number;
  readonly url: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly accept: string | null;
  readonly sessionId: string | null;
  readonly clientRequestId: string | null;
  readonly providerStatic: string | null;
  readonly clientCookie: string | null;
  readonly body: string;
}

async function diagnosticsFileBytes(directory: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else parts.push(await readFile(path));
    }
  };
  await visit(directory);
  return Buffer.concat(parts);
}

function requiredAttemptValue<T>(values: readonly T[], attempt: number): T {
  const value = values[attempt - 1];
  if (value === undefined) throw new Error(`Missing fixture value for ${attempt}`);
  return value;
}

function completedStep(
  observations: readonly { readonly kind: string }[],
  stepInstanceId: string,
) {
  return observations.find(
    (observation) =>
      observation.kind === "step_completed" &&
      "stepInstanceId" in observation &&
      observation.stepInstanceId === stepInstanceId,
  );
}

describe("OpenAI Responses Provider Native Request Journey", () => {
  it("keeps the Responses native lane observable through final Profile exhaustion", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-openai-provider-native-journey-"),
    );
    const diagnosticsDirectory = join(root, "diagnostics");
    let authority: DiagnosticsManagementAuthority | undefined;
    let server: RunningTokenHttpServer | undefined;

    try {
      authority = await createDiagnosticsAuthority({
        configuration: parseDiagnosticsConfiguration(
          { directory: diagnosticsDirectory },
          root,
        ),
        journeyCapturePolicy: {
          snapshot: () => Object.freeze({
            allRequestsEnabled: true,
            failedRequestsEnabled: true,
          }),
        },
      });
      let resolveJourneyClosed!: (input: RequestJourneyCloseInput) => void;
      const journeyClosed = new Promise<RequestJourneyCloseInput>((resolve) => {
        resolveJourneyClosed = resolve;
      });
      let closeCount = 0;
      const latchedAuthority: RequestJourneyObservationAuthority = {
        begin: (input) => {
          const observer = authority!.begin(input);
          return {
            requestId: observer.requestId,
            observe: (observation) => observer.observe(observation),
            close: (closeInput) => {
              observer.close(closeInput);
              closeCount += 1;
              resolveJourneyClosed(closeInput);
            },
          };
        },
        observeRuntime: (input) => authority!.observeRuntime(input),
      };

      const profileA = managedCapture(PROFILE_A, "OpenAI Profile A");
      const profileB = managedCapture(PROFILE_B, "OpenAI Profile B");
      let boundProfileId: string | undefined;
      const transitions: TransitionFact[] = [];
      const bindings: Pick<
        ProviderAuthBindingAuthority,
        "capture" | "runBound" | "advanceAfterFinal429"
      > = Object.freeze({
        capture: async (providerId: string) => {
          expect(providerId).toBe("openai");
          return profileA;
        },
        runBound: async <T>(
          capture: ProviderAuthBindingCapture,
          operation: () => Promise<T>,
        ): Promise<T> => {
          expect(capture.facts.kind).toBe("managed");
          const previous = boundProfileId;
          boundProfileId =
            capture.facts.kind === "managed"
              ? capture.facts.credentialId
              : undefined;
          try {
            return await operation();
          } finally {
            boundProfileId = previous;
          }
        },
        advanceAfterFinal429: async (input: AdvanceAfterFinal429Input) => {
          const switched = input.capture.facts.credentialId === PROFILE_A;
          transitions.push({
            fromProfileId: input.capture.facts.credentialId,
            attemptedProfileIds: [...input.attemptedCredentialIds],
            ...(input.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: input.retryAfterMs }),
            outcome: switched ? "switched" : "exhausted",
          });
          return switched
            ? Object.freeze({ outcome: "switched" as const, capture: profileB })
            : Object.freeze({ outcome: "exhausted" as const });
        },
      });

      const model = openAIModel();
      const modelCapabilityTouches: string[] = [];
      const models = new Proxy({} as Models, {
        get(_target, property) {
          if (property === "getModels") {
            return () => {
              modelCapabilityTouches.push("getModels");
              return [model];
            };
          }
          if (property === "getAuth") {
            return async () => {
              modelCapabilityTouches.push(`getAuth:${boundProfileId}`);
              const apiKey =
                boundProfileId === PROFILE_A
                  ? PROVIDER_TOKEN_A
                  : boundProfileId === PROFILE_B
                    ? PROVIDER_TOKEN_B
                    : undefined;
              if (apiKey === undefined) {
                throw new Error("getAuth must run under the exact Profile");
              }
              return { auth: { apiKey }, source: "fixture" };
            };
          }
          throw new Error(`Unexpected Pi Models capability: ${String(property)}`);
        },
      });
      const upstreamBodies = [
        '{"error":{"type":"rate_limit_error","message":"Profile A exhausted"}}',
        '{"error":{"type":"rate_limit_error","message":"Profile B exhausted"}}',
      ] as const;
      const outboundAttempts: OutboundAttempt[] = [];
      const providerFetch: FetchFunction = async (input, init) => {
        const request = new Request(input, init);
        const attempt = outboundAttempts.length + 1;
        outboundAttempts.push({
          attempt,
          url: request.url,
          authorization: request.headers.get("authorization"),
          contentType: request.headers.get("content-type"),
          accept: request.headers.get("accept"),
          sessionId: request.headers.get("session_id"),
          clientRequestId: request.headers.get("x-client-request-id"),
          providerStatic: request.headers.get("x-provider-static"),
          clientCookie: request.headers.get("cookie"),
          body: await request.text(),
        });
        return new Response(requiredAttemptValue(upstreamBodies, attempt), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "request-id": `provider-attempt-${attempt}`,
            "retry-after": "0",
            "set-cookie": UPSTREAM_COOKIE,
          },
        });
      };
      const semanticExecution = vi.fn(async () => {
        throw new Error("Pi Provider/Semantic Conversion must not execute");
      }) as unknown as ExecutionOperation;
      const providerNativeLane = createProviderNativeResponses({
        models,
        bindings,
        fetch: providerFetch,
        configuration: parseProviderNativeResponsesConfiguration({
          transport: { maxRetries: 0 },
        }),
        retryDependencies: {
          random: () => 0,
          now: () => 1_788_000_000_000,
          sleep: async () => {
            throw new Error("transport retry sleep must not run");
          },
        },
      });
      const handler = createOpenAIResponsesHandler({
        models,
        providerNativeLane,
        executeOperation: semanticExecution,
        stateFile: join(root, "responses-state.json"),
        maxRequestBytes: 8_192,
        createSessionId: () => SESSION_ID,
        createResponseId: () => "resp_semantic_must_not_render",
        now: () => 1_788_000_000_000,
      });
      const runtime = createTokenRuntime({ clientProtocols: [handler] });
      server = await startTokenHttpServer({
        runtime,
        diagnostics: latchedAuthority,
        createRequestId: () => REQUEST_ID,
        port: 0,
      });

      const requestBody = `{
  "input": [{"role":"user","content":[{"type":"input_text","text":"preserve me"}]}],
  "model": "openai/gpt-native",
  "max_output_tokens": 37,
  "parallel_tool_calls": false,
  "metadata": {"trace":"native-openai","nested":{"model_name":"unchanged"}},
  "store": false,
  "unknown_extension": {"nested":[1,true,null]}
}`;
      const expectedOutboundBody = requestBody.replace(
        '"openai/gpt-native"',
        '"gpt-native"',
      );
      const persistedOutboundBody = JSON.stringify(
        JSON.parse(expectedOutboundBody) as unknown,
      );
      const response = await fetch(`${server.origin}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_TOKEN}`,
          cookie: CLIENT_COOKIE,
          "content-type": "application/json",
          "x-client-request-id": SESSION_ID,
          "x-provider-static": "client-must-not-win",
        },
        body: requestBody,
      });
      const responseBody = await response.text();
      const closeInput = await journeyClosed;

      expect(closeInput).toMatchObject({
        outcome: "failed",
        lastKnownLocation: {
          phase: "http_handoff",
          step: "write_http_response",
        },
      });
      expect(closeCount).toBe(1);
      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("request-id")).toBe("provider-attempt-2");
      expect(response.headers.get("retry-after")).toBe("0");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("authorization")).toBeNull();
      expect(response.headers.get("x-token-request-id")).toBe(REQUEST_ID);
      expect(responseBody).toBe(upstreamBodies[1]);

      expect(outboundAttempts).toHaveLength(2);
      expect(outboundAttempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
      expect(outboundAttempts.map((attempt) => attempt.url)).toEqual([
        "https://provider.example.com/v1/responses",
        "https://provider.example.com/v1/responses",
      ]);
      expect(outboundAttempts.map((attempt) => attempt.authorization)).toEqual([
        `Bearer ${PROVIDER_TOKEN_A}`,
        `Bearer ${PROVIDER_TOKEN_B}`,
      ]);
      expect(outboundAttempts.map((attempt) => attempt.body)).toEqual([
        expectedOutboundBody,
        expectedOutboundBody,
      ]);
      expect(
        outboundAttempts.map(({ contentType, accept }) => ({ contentType, accept })),
      ).toEqual([
        { contentType: "application/json", accept: "application/json" },
        { contentType: "application/json", accept: "application/json" },
      ]);
      expect(
        outboundAttempts.map(({ sessionId, clientRequestId }) => ({
          sessionId,
          clientRequestId,
        })),
      ).toEqual([
        { sessionId: SESSION_ID, clientRequestId: SESSION_ID },
        { sessionId: SESSION_ID, clientRequestId: SESSION_ID },
      ]);
      expect(outboundAttempts.map((attempt) => attempt.providerStatic)).toEqual([
        "provider-owned",
        "provider-owned",
      ]);
      expect(outboundAttempts.map((attempt) => attempt.clientCookie)).toEqual([
        null,
        null,
      ]);
      expect(transitions).toEqual([
        {
          fromProfileId: PROFILE_A,
          attemptedProfileIds: [PROFILE_A],
          retryAfterMs: 0,
          outcome: "switched",
        },
        {
          fromProfileId: PROFILE_B,
          attemptedProfileIds: [PROFILE_A, PROFILE_B],
          retryAfterMs: 0,
          outcome: "exhausted",
        },
      ]);
      expect(modelCapabilityTouches).toEqual([
        "getModels",
        `getAuth:${PROFILE_A}`,
        `getAuth:${PROFILE_B}`,
      ]);
      expect(semanticExecution).not.toHaveBeenCalled();

      const page = await authority.queryRequestJourneys({ limit: 10 });
      expect(page.records).toHaveLength(1);
      expect(page.records[0]?.lane).toBe("provider_native");
      expect(page.records[0]).toMatchObject({
        requestId: REQUEST_ID,
        operation: "model_generation",
        protocol: "openai-responses",
        outcome: "failed",
        primaryFailureLocation: PRIMARY_LOCATION,
      });

      const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
      expect(detail.admission).toMatchObject({
        transport: "http",
        method: "POST",
        path: "/v1/responses",
        operationCandidate: "pending",
      });
      const observations = detail.timeline.map((event) => event.observation);
      expect(completedStep(observations, "p2.extract_model_selector"))
        .toMatchObject({
          completion: "success",
          operation: "model_generation",
          protocol: "openai-responses",
          location: {
            phase: "request_resolution",
            step: "extract_model_selector",
          },
        });
      expect(completedStep(observations, "p2.resolve_public_model"))
        .toMatchObject({
          completion: "success",
          location: {
            phase: "request_resolution",
            step: "resolve_public_model",
          },
        });
      expect(completedStep(observations, "p2.recognize_provider_native"))
        .toMatchObject({
          completion: "success",
          location: {
            phase: "request_resolution",
            lane: "provider_native",
            step: "recognize_provider_native",
          },
        });
      expect(
        observations.filter((observation) => observation.kind === "lane_committed"),
      ).toEqual([
        expect.objectContaining({
          lane: "provider_native",
          location: {
            phase: "request_resolution",
            lane: "provider_native",
            step: "commit_lane",
          },
        }),
      ]);

      for (const attempt of [1, 2] as const) {
        for (const step of [
          "capture_provider_profile",
          "resolve_provider_auth",
          "project_native_body",
          "reconstruct_provider_envelope",
        ] as const) {
          expect(completedStep(observations, `p3.${step}.${attempt}`))
            .toMatchObject({
              completion: "success",
              location: {
                phase: "lane_request_preparation",
                lane: "provider_native",
                step,
                attempt,
              },
            });
        }
        for (const step of [
          "dispatch_provider_native",
          "read_provider_native_response",
          "classify_native_retry",
        ] as const) {
          expect(completedStep(observations, `p4.${step}.${attempt}`))
            .toMatchObject({
              completion: "success",
              location: {
                phase: "upstream_execution",
                lane: "provider_native",
                step,
                attempt,
              },
            });
        }
      }
      expect(completedStep(observations, "p4.advance_provider_profile.1"))
        .toMatchObject({
          completion: "success",
          location: { ...PRIMARY_LOCATION, attempt: 1 },
        });
      expect(completedStep(observations, "p4.advance_provider_profile.2"))
        .toMatchObject({ completion: "failed", location: PRIMARY_LOCATION });

      expect(
        observations.filter((observation) => observation.kind === "attempt_observed"),
      ).toEqual([
        expect.objectContaining({
          attempt: 1,
          profileId: PROFILE_A,
          transition: "started",
          location: {
            phase: "upstream_execution",
            lane: "provider_native",
            step: "dispatch_provider_native",
            attempt: 1,
          },
        }),
        expect.objectContaining({
          attempt: 1,
          profileId: PROFILE_A,
          status: 429,
          transition: "response",
          location: {
            phase: "upstream_execution",
            lane: "provider_native",
            step: "read_provider_native_response",
            attempt: 1,
          },
        }),
        expect.objectContaining({
          attempt: 2,
          profileId: PROFILE_B,
          transition: "started",
          location: {
            phase: "upstream_execution",
            lane: "provider_native",
            step: "dispatch_provider_native",
            attempt: 2,
          },
        }),
        expect.objectContaining({
          attempt: 2,
          profileId: PROFILE_B,
          status: 429,
          transition: "response",
          location: {
            phase: "upstream_execution",
            lane: "provider_native",
            step: "read_provider_native_response",
            attempt: 2,
          },
        }),
      ]);

      const failures = observations.filter(
        (observation) => observation.kind === "failure_detected",
      );
      expect(
        failures.filter(
          (failure) =>
            failure.role === "supporting" &&
            failure.classification === "provider_http_429",
        ),
      ).toEqual(
        [1, 2].map((attempt) =>
          expect.objectContaining({
            origin: "provider",
            originPrecision: "external_boundary",
            location: {
              phase: "upstream_execution",
              lane: "provider_native",
              step: "classify_native_retry",
              attempt,
            },
          }),
        ),
      );
      expect(failures.filter((failure) => failure.role === "primary")).toEqual([
        expect.objectContaining({
          failureId: detail.incident?.primaryFailureId,
          classification: "provider_profile_exhausted_after_final_429",
          origin: "Token",
          originPrecision: "exact",
          location: PRIMARY_LOCATION,
        }),
      ]);
      expect(detail.incident?.failures).toEqual(failures);

      for (const [instance, step] of [
        ["p5.buffer_provider_native_response", "buffer_provider_native_response"],
        ["p5.preserve_provider_response", "preserve_provider_response"],
        ["p5.observe_provider_native_usage", "observe_provider_native_usage"],
      ] as const) {
        expect(completedStep(observations, instance)).toMatchObject({
          completion: "success",
          location: {
            phase: "lane_response_processing",
            lane: "provider_native",
            step,
          },
        });
      }
      expect(
        completedStep(observations, "p6.prepare_provider_native_error_response"),
      ).toMatchObject({
        completion: "success",
        location: CLIENT_PRESENTATION_LOCATION,
      });
      expect(detail.clientPresentation).toEqual({
        status: 429,
        mediaType: "application/json",
        location: CLIENT_PRESENTATION_LOCATION,
      });
      expect(completedStep(observations, "p7.commit_request_outcome"))
        .toMatchObject({
          completion: "success",
          location: WORK_OUTCOME_LOCATION,
        });
      expect(detail.workOutcome).toEqual({
        outcome: "failed",
        requestOutcome: "failed",
        terminalAuthority: "openai_responses_provider_native_lane",
        location: WORK_OUTCOME_LOCATION,
      });
      expect(detail.handoffOutcome).toMatchObject({
        outcome: "finished",
        transport: "http",
        writableFinished: true,
        location: {
          phase: "http_handoff",
          step: "write_http_response",
        },
      });

      const analyticsOptions = await authority.getAnalytics({
        version: 3,
        command: "options",
      });
      expect(analyticsOptions).toEqual({
        version: 3,
        command: "options",
        providers: ["openai"],
        profiles: [
          {
            profileId: PROFILE_B,
            displayName: "OpenAI Profile B",
            providerId: "openai",
          },
        ],
        models: ["gpt-native"],
        protocols: ["openai-responses"],
        sessions: [SESSION_ID],
        outcomes: ["failed"],
      });

      const analyticsSummary = await authority.getAnalytics({
        version: 3,
        command: "summary",
        from: 0,
        to: Number.MAX_SAFE_INTEGER,
        filters: {
          providers: ["openai"],
          profiles: [PROFILE_B],
          models: ["gpt-native"],
          protocols: ["openai-responses"],
          sessions: [SESSION_ID],
          outcomes: ["failed"],
        },
      });
      expect(analyticsSummary.command).toBe("summary");
      if (analyticsSummary.command !== "summary") {
        throw new Error("Expected a diagnostics analytics summary");
      }
      expect(analyticsSummary.totals).toMatchObject({
        total: 1,
        failed: 1,
        usageRequests: 0,
        missingUsageRequests: 1,
        speedRequests: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
      });
      expect(analyticsSummary.totals).not.toHaveProperty(
        "normalizedTokenTotal",
      );
      expect(analyticsSummary.totals).not.toHaveProperty(
        "outputTokensPerSecond",
      );

      expect(detail.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: "client_request_wire",
            artifactKind: "client_request_wire",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "client_request_envelope",
            artifactKind: "client_request_envelope",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "provider_native_outbound_request_envelope.1",
            artifactKind: "provider_native_outbound_request_envelope",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "provider_native_outbound_request_wire.1",
            artifactKind: "provider_native_outbound_request_wire",
            state: "captured",
            originalBytes: Buffer.byteLength(expectedOutboundBody),
          }),
          expect.objectContaining({
            artifactId: "provider_native_upstream_response_wire.1",
            artifactKind: "provider_native_upstream_response_wire",
            state: "unavailable",
            reason: "response_body_not_read_before_profile_switch",
          }),
          expect.objectContaining({
            artifactId: "provider_native_upstream_response_envelope.1",
            artifactKind: "provider_native_upstream_response_envelope",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "provider_native_outbound_request_envelope.2",
            artifactKind: "provider_native_outbound_request_envelope",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "provider_native_outbound_request_wire.2",
            artifactKind: "provider_native_outbound_request_wire",
            state: "captured",
            originalBytes: Buffer.byteLength(expectedOutboundBody),
          }),
          expect.objectContaining({
            artifactId: "provider_native_upstream_response_wire.2",
            artifactKind: "provider_native_upstream_response_wire",
            state: "captured",
            originalBytes: Buffer.byteLength(upstreamBodies[1]),
          }),
          expect.objectContaining({
            artifactId: "provider_native_upstream_response_envelope.2",
            artifactKind: "provider_native_upstream_response_envelope",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "provider_native_preserved_response_wire",
            artifactKind: "provider_native_preserved_response_wire",
            state: "captured",
            originalBytes: Buffer.byteLength(upstreamBodies[1]),
          }),
          expect.objectContaining({
            artifactId: "client_response_wire",
            artifactKind: "client_response_wire",
            state: "captured",
            originalBytes: Buffer.byteLength(responseBody),
          }),
          expect.objectContaining({
            artifactId: "client_response_envelope",
            artifactKind: "client_response_envelope",
            state: "captured",
          }),
        ]),
      );
      for (const attempt of [1, 2] as const) {
        const outboundArtifact = await authority.getRequestArtifact({
          requestId: REQUEST_ID,
          artifactId: `provider_native_outbound_request_wire.${attempt}`,
          offset: 0,
          limit: 256 * 1_024,
        });
        expect(
          JSON.parse(
            Buffer.from(outboundArtifact.dataBase64, "base64").toString("utf8"),
          ),
        ).toEqual(JSON.parse(persistedOutboundBody));
      }
      for (const artifactId of [
        "provider_native_upstream_response_wire.2",
        "provider_native_preserved_response_wire",
        "client_response_wire",
      ]) {
        const artifact = await authority.getRequestArtifact({
          requestId: REQUEST_ID,
          artifactId,
          offset: 0,
          limit: 256 * 1_024,
        });
        expect(
          JSON.parse(Buffer.from(artifact.dataBase64, "base64").toString("utf8")),
        ).toEqual(JSON.parse(upstreamBodies[1]));
      }

      const serializedDetail = JSON.stringify(detail);
      expect(serializedDetail).not.toContain("anthropic");
      expect(serializedDetail).not.toContain("\"lane\":\"direct\"");
      expect(serializedDetail).not.toContain("semantic_conversion");
      for (const forbiddenArtifact of [
        "direct_outbound_request_wire",
        "pi_invocation_snapshot",
        "pi_terminal_summary",
        "pi_provider_outbound_request_wire",
        "pi_provider_upstream_response_wire",
      ]) {
        expect(detail.artifacts.some((artifact) =>
          artifact.artifactKind === forbiddenArtifact,
        )).toBe(false);
      }
      for (const secret of [
        CLIENT_TOKEN,
        CLIENT_COOKIE,
        PROVIDER_TOKEN_A,
        PROVIDER_TOKEN_B,
        UPSTREAM_COOKIE,
      ]) {
        expect(serializedDetail).not.toContain(secret);
      }

      await server.close();
      server = undefined;
      await authority.close();
      authority = undefined;
      const persistedBytes = await diagnosticsFileBytes(diagnosticsDirectory);
      expect(persistedBytes.includes(Buffer.from(REQUEST_ID))).toBe(true);
      for (const secret of [
        CLIENT_TOKEN,
        CLIENT_COOKIE,
        PROVIDER_TOKEN_A,
        PROVIDER_TOKEN_B,
        UPSTREAM_COOKIE,
      ]) {
        expect(persistedBytes.includes(Buffer.from(secret))).toBe(false);
      }
    } finally {
      await Promise.allSettled([
        server?.close() ?? Promise.resolve(),
        authority?.close() ?? Promise.resolve(),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
