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
  type DiagnosticsAuthority,
} from "../../src/diagnostics/index.js";
import type { ExecutionOperation } from "../../src/execution.js";
import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import { identityRequestModelResolver } from "../../src/protocols/anthropic/options.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "60000000-0000-4000-8000-000000000001";
const PROFILE_A = "provider-profile-a";
const PROFILE_B = "provider-profile-b";
const PROVIDER_TOKEN_A = "provider-oauth-token-a-43f71d";
const PROVIDER_TOKEN_B = "provider-oauth-token-b-5a912c";
const CLIENT_TOKEN = "client-token-canary-3d66f4";
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

function anthropicModel(): Model<string> {
  return {
    id: "claude-test",
    name: "Claude Test",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://provider.example.com/gateway",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function managedCapture(
  credentialId: string,
  displayName: string,
): ManagedProviderAuthBindingCapture {
  return Object.freeze({
    facts: Object.freeze({
      kind: "managed" as const,
      providerId: "anthropic",
      credentialId,
      authType: "oauth" as const,
      authMethodLabel: "Account",
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
  readonly apiKey: string | null;
  readonly userAgent: string | null;
  readonly beta: string | null;
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

function requiredAttemptValue<T>(
  values: readonly T[],
  attempt: number,
): T {
  const value = values[attempt - 1];
  if (value === undefined) {
    throw new Error(`Missing fixture value for attempt ${attempt}`);
  }
  return value;
}

describe("Anthropic Provider Native Request Journey", () => {
  it("persists the complete successful native request and response scene", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-provider-native-success-journey-"),
    );
    const requestId = "60000000-0000-4000-8000-000000000003";
    let authority: DiagnosticsAuthority | undefined;
    let server: RunningTokenHttpServer | undefined;
    try {
      authority = await createDiagnosticsAuthority({
        configuration: parseDiagnosticsConfiguration(
          { directory: join(root, "diagnostics") },
          root,
        ),
        journeyCapturePolicy: {
          snapshot: () => Object.freeze({
            allRequestsEnabled: true,
            failedRequestsEnabled: true,
          }),
        },
      });
      const profile = managedCapture(PROFILE_A, "Provider Profile A");
      const bindings: Pick<
        ProviderAuthBindingAuthority,
        "capture" | "runBound" | "advanceAfterFinal429"
      > = Object.freeze({
        capture: async () => profile,
        runBound: async <T>(
          _capture: ProviderAuthBindingCapture,
          operation: () => Promise<T>,
        ) => operation(),
        advanceAfterFinal429: async () => {
          throw new Error("A successful native response must not retry");
        },
      });
      const model = anthropicModel();
      const models = {
        getModels: () => [model],
        getAuth: async () => ({
          auth: { apiKey: PROVIDER_TOKEN_A },
          source: "fixture",
        }),
      } as unknown as Models;
      const providerBody = JSON.stringify({
        id: "msg_provider_native_success",
        type: "message",
        role: "assistant",
        model: model.id,
        content: [{ type: "text", text: "native response evidence" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      });
      let outboundBody = "";
      const providerFetch: FetchFunction = async (input, init) => {
        const request = new Request(input, init);
        outboundBody = await request.text();
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${PROVIDER_TOKEN_A}`,
        );
        return new Response(providerBody, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "request-id": "provider-success-request-id",
          },
        });
      };
      const semanticExecution = vi.fn(async () => {
        throw new Error("Semantic Conversion must not execute");
      }) as unknown as ExecutionOperation;
      const handler = createAnthropicMessagesHandler({
        models,
        providerNativeLane: createAnthropicProviderNativeLane({
          models,
          bindings,
          resolveRequestModel: identityRequestModelResolver,
          fetch: providerFetch,
        }),
        executeOperation: semanticExecution,
        maxRequestBytes: 4_096,
        createMessageId: () => "unused",
        now: () => 1_787_500_000_100,
      });
      server = await startTokenHttpServer({
        runtime: createTokenRuntime({ clientProtocols: [handler] }),
        diagnostics: authority,
        createRequestId: () => requestId,
        port: 0,
      });
      const clientBody = JSON.stringify({
        model: "anthropic/claude-test",
        max_tokens: 32,
        messages: [{ role: "user", content: "capture native success" }],
      });

      const response = await fetch(`${server.origin}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_TOKEN}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: clientBody,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(providerBody);
      expect(semanticExecution).not.toHaveBeenCalled();

      await server.close();
      server = undefined;
      const detail = await authority.getRequestJourney({ requestId });
      expect(detail).toMatchObject({
        protocol: "anthropic-messages",
        lane: "provider_native",
        outcome: "success",
      });
      expect(detail.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: "client_request_wire",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "provider_native_outbound_request_wire.1",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "provider_native_upstream_response_wire.1",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "provider_native_preserved_response_wire",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "client_response_wire",
            state: "captured",
          }),
        ]),
      );
      for (const [artifactId, expected] of [
        ["client_request_wire", clientBody],
        ["provider_native_outbound_request_wire.1", outboundBody],
        ["provider_native_upstream_response_wire.1", providerBody],
        ["provider_native_preserved_response_wire", providerBody],
        ["client_response_wire", providerBody],
      ] as const) {
        const artifact = await authority.getRequestArtifact({
          requestId,
          artifactId,
          offset: 0,
          limit: 256 * 1_024,
        });
        expect(Buffer.from(artifact.dataBase64, "base64").toString("utf8"))
          .toBe(expected);
      }
    } finally {
      await Promise.allSettled([
        server?.close() ?? Promise.resolve(),
        authority?.close() ?? Promise.resolve(),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps physical 429s supporting and locates final managed-Profile exhaustion", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-provider-native-journey-"),
    );
    const diagnosticsDirectory = join(root, "diagnostics");
    let authority: DiagnosticsAuthority | undefined;
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

      const profileA = managedCapture(PROFILE_A, "Provider Profile A");
      const profileB = managedCapture(PROFILE_B, "Provider Profile B");
      let boundProfileId: string | undefined;
      const transitions: TransitionFact[] = [];
      const bindings: Pick<
        ProviderAuthBindingAuthority,
        "capture" | "runBound" | "advanceAfterFinal429"
      > = Object.freeze({
        capture: async (providerId: string) => {
          expect(providerId).toBe("anthropic");
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

      const model = anthropicModel();
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
                throw new Error("getAuth must run under an exact Profile binding");
              }
              return { auth: { apiKey }, source: "fixture" };
            };
          }
          throw new Error(`Unexpected Pi Models capability: ${String(property)}`);
        },
      });

      const upstreamBodies = [
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Provider Profile A is rate limited",
          },
        }),
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Provider Profile B is rate limited",
          },
        }),
      ] as const;
      const outboundAttempts: OutboundAttempt[] = [];
      const providerFetch: FetchFunction = async (input, init) => {
        const request = new Request(input, init);
        const attempt = outboundAttempts.length + 1;
        outboundAttempts.push({
          attempt,
          url: request.url,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
          userAgent: request.headers.get("user-agent"),
          beta: request.headers.get("anthropic-beta"),
          body: await request.text(),
        });
        return new Response(requiredAttemptValue(upstreamBodies, attempt), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "request-id": `provider-attempt-${attempt}`,
            "retry-after": "1",
          },
        });
      };
      const semanticExecution = vi.fn(async () => {
        throw new Error("Pi Provider/Semantic Conversion must not execute");
      }) as unknown as ExecutionOperation;
      const providerNativeLane = createAnthropicProviderNativeLane({
        models,
        bindings,
        resolveRequestModel: identityRequestModelResolver,
        fetch: providerFetch,
      });
      const handler = createAnthropicMessagesHandler({
        models,
        providerNativeLane,
        executeOperation: semanticExecution,
        maxRequestBytes: 4_096,
        createMessageId: () => "msg_provider_native_must_not_render",
        createSessionId: () => "60000000-0000-4000-8000-000000000002",
        now: () => 1_787_500_000_000,
      });
      const runtime = createTokenRuntime({ clientProtocols: [handler] });
      server = await startTokenHttpServer({
        runtime,
        diagnostics: authority,
        createRequestId: () => REQUEST_ID,
        port: 0,
      });

      const requestBody = JSON.stringify({
        model: "anthropic/claude-test",
        max_tokens: 32,
        system: "Keep the client instruction",
        messages: [{ role: "user", content: "diagnose Profile exhaustion" }],
      });
      const expectedOutboundBody = JSON.stringify({
        model: "claude-test",
        max_tokens: 32,
        system: [
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
          { type: "text", text: "Keep the client instruction" },
        ],
        messages: [{ role: "user", content: "diagnose Profile exhaustion" }],
      });
      const response = await fetch(`${server.origin}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_TOKEN}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: requestBody,
      });
      const responseBody = await response.text();

      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("request-id")).toBe("provider-attempt-2");
      expect(response.headers.get("retry-after")).toBe("1");
      expect(response.headers.get("x-token-request-id")).toBe(REQUEST_ID);
      expect(responseBody).toBe(upstreamBodies[1]);
      expect(outboundAttempts).toHaveLength(2);
      expect(outboundAttempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
      expect(outboundAttempts.map((attempt) => attempt.url)).toEqual([
        "https://provider.example.com/gateway/v1/messages",
        "https://provider.example.com/gateway/v1/messages",
      ]);
      expect(outboundAttempts.map((attempt) => attempt.authorization)).toEqual([
        `Bearer ${PROVIDER_TOKEN_A}`,
        `Bearer ${PROVIDER_TOKEN_B}`,
      ]);
      expect(outboundAttempts.map((attempt) => attempt.apiKey)).toEqual([
        null,
        null,
      ]);
      expect(outboundAttempts.map((attempt) => attempt.userAgent)).toEqual([
        "claude-cli/2.1.75",
        "claude-cli/2.1.75",
      ]);
      expect(
        outboundAttempts.every((attempt) =>
          attempt.beta?.includes("oauth-2025-04-20"),
        ),
      ).toBe(true);
      expect(outboundAttempts.map((attempt) => attempt.body)).toEqual([
        expectedOutboundBody,
        expectedOutboundBody,
      ]);
      expect(transitions).toEqual([
        {
          fromProfileId: PROFILE_A,
          attemptedProfileIds: [PROFILE_A],
          retryAfterMs: 1_000,
          outcome: "switched",
        },
        {
          fromProfileId: PROFILE_B,
          attemptedProfileIds: [PROFILE_A, PROFILE_B],
          retryAfterMs: 1_000,
          outcome: "exhausted",
        },
      ]);
      expect(modelCapabilityTouches).toEqual([
        "getModels",
        `getAuth:${PROFILE_A}`,
        `getAuth:${PROFILE_B}`,
      ]);
      expect(semanticExecution).not.toHaveBeenCalled();

      await expect
        .poll(async () => {
          const page = await authority!.queryRequestJourneys({ limit: 10 });
          return page.records.find((record) => record.requestId === REQUEST_ID)
            ?.outcome;
        })
        .toBe("failed");
      const page = await authority.queryRequestJourneys({ limit: 10 });
      expect(page.records).toHaveLength(1);
      expect(page.records[0]).toMatchObject({
        requestId: REQUEST_ID,
        operation: "model_generation",
        protocol: "anthropic-messages",
        lane: "provider_native",
        outcome: "failed",
        primaryFailureLocation: PRIMARY_LOCATION,
      });

      const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
      expect(detail.admission).toMatchObject({
        transport: "http",
        method: "POST",
        path: "/v1/messages",
        operationCandidate: "pending",
      });
      const observations = detail.timeline.map((event) => event.observation);
      expect(completedStep(observations, "p1.validate_media_and_encoding"))
        .toMatchObject({
          completion: "success",
          operation: "model_generation",
          protocol: "anthropic-messages",
          location: {
            phase: "protocol_ingress",
            step: "validate_media_and_encoding",
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
        observations.filter(
          (observation) => observation.kind === "lane_committed",
        ),
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
          location: {
            phase: "upstream_execution",
            lane: "provider_native",
            step: "advance_provider_profile",
            attempt: 1,
          },
        });
      expect(completedStep(observations, "p4.advance_provider_profile.2"))
        .toMatchObject({ completion: "failed", location: PRIMARY_LOCATION });

      const attempts = observations.filter(
        (observation) => observation.kind === "attempt_observed",
      );
      expect(attempts).toEqual([
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
      const supporting429s = failures.filter(
        (failure) =>
          failure.role === "supporting" &&
          failure.classification === "provider_http_429",
      );
      expect(supporting429s).toEqual([
        expect.objectContaining({
          origin: "provider",
          originPrecision: "external_boundary",
          location: {
            phase: "upstream_execution",
            lane: "provider_native",
            step: "classify_native_retry",
            attempt: 1,
          },
        }),
        expect.objectContaining({
          origin: "provider",
          originPrecision: "external_boundary",
          location: {
            phase: "upstream_execution",
            lane: "provider_native",
            step: "classify_native_retry",
            attempt: 2,
          },
        }),
      ]);
      const primaryFailures = failures.filter(
        (failure) => failure.role === "primary",
      );
      expect(primaryFailures).toEqual([
        expect.objectContaining({
          failureId: detail.incident?.primaryFailureId,
          classification: "provider_profile_exhausted_after_final_429",
          origin: "Token",
          originPrecision: "exact",
          location: PRIMARY_LOCATION,
        }),
      ]);
      expect(detail.incident?.failures).toEqual(failures);
      expect(
        observations.some(
          (observation) =>
            observation.location.phase === "lane_response_processing",
        ),
      ).toBe(false);

      expect(
        completedStep(
          observations,
          "p6.prepare_provider_native_error_response",
        ),
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
        terminalAuthority: "anthropic_provider_native_lane",
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
          ...([1, 2] as const).flatMap((attempt) => [
            expect.objectContaining({
              artifactId: `provider_native_outbound_request_envelope.${attempt}`,
              artifactKind: "provider_native_outbound_request_envelope",
              state: "captured",
            }),
            expect.objectContaining({
              artifactId: `provider_native_outbound_request_wire.${attempt}`,
              artifactKind: "provider_native_outbound_request_wire",
              state: "captured",
              mediaType: "application/json",
              originalBytes: Buffer.byteLength(expectedOutboundBody),
              capturedBytes: Buffer.byteLength(expectedOutboundBody),
              truncated: false,
            }),
            expect.objectContaining({
              artifactId: `provider_native_upstream_response_wire.${attempt}`,
              artifactKind: "provider_native_upstream_response_wire",
              state: "captured",
              mediaType: "application/json",
              originalBytes: Buffer.byteLength(
                requiredAttemptValue(upstreamBodies, attempt),
              ),
              capturedBytes: Buffer.byteLength(
                requiredAttemptValue(upstreamBodies, attempt),
              ),
              truncated: false,
            }),
            expect.objectContaining({
              artifactId: `provider_native_upstream_response_envelope.${attempt}`,
              artifactKind: "provider_native_upstream_response_envelope",
              state: "captured",
            }),
          ]),
          expect.objectContaining({
            artifactId: "provider_native_preserved_response_wire",
            artifactKind: "provider_native_preserved_response_wire",
            state: "unavailable",
            reason: "profile_exhausted_before_response_preservation",
          }),
          expect.objectContaining({
            artifactId: "client_response_wire",
            artifactKind: "client_response_wire",
            state: "captured",
            mediaType: "application/json",
            originalBytes: Buffer.byteLength(responseBody),
            capturedBytes: Buffer.byteLength(responseBody),
            truncated: false,
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
          Buffer.from(outboundArtifact.dataBase64, "base64").toString("utf8"),
        ).toBe(expectedOutboundBody);
        const upstreamArtifact = await authority.getRequestArtifact({
          requestId: REQUEST_ID,
          artifactId: `provider_native_upstream_response_wire.${attempt}`,
          offset: 0,
          limit: 256 * 1_024,
        });
        expect(
          Buffer.from(upstreamArtifact.dataBase64, "base64").toString("utf8"),
        ).toBe(requiredAttemptValue(upstreamBodies, attempt));
      }

      const projectedDetail = JSON.stringify(detail);
      expect(projectedDetail).not.toContain(CLIENT_TOKEN);
      expect(projectedDetail).not.toContain(PROVIDER_TOKEN_A);
      expect(projectedDetail).not.toContain(PROVIDER_TOKEN_B);

      await server.close();
      server = undefined;
      await authority.close();
      authority = undefined;
      const persistedBytes = await diagnosticsFileBytes(diagnosticsDirectory);
      expect(persistedBytes.includes(Buffer.from(REQUEST_ID))).toBe(true);
      for (const secret of [CLIENT_TOKEN, PROVIDER_TOKEN_A, PROVIDER_TOKEN_B]) {
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
