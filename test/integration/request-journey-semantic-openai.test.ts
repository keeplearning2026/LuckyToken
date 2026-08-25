import type { Model, Models } from "@earendil-works/pi-ai";
import {
  createUpstreamFailureFact,
  type InvocationAttempt,
} from "@token/provider-contract/diagnostics";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
} from "../../src/diagnostics/index.js";
import {
  ExecutionFailure,
  type ExecutionOperation,
} from "../../src/execution.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "70000000-0000-4000-8000-000000000001";
const CLIENT_TOKEN = "client-semantic-token-canary-49f7d1";
const PROVIDER_HEADER_SECRET = "provider-header-secret-canary-6cc438";
const SAFE_INPUT_MARKER = "semantic-investigation-marker-835a";
const SAFE_FAILURE_MESSAGE = "Provider capacity is temporarily unavailable";
const SAFE_PROVIDER_CODE = "CAPACITY_EXHAUSTED";
const PRIMARY_LOCATION = {
  phase: "upstream_execution",
  lane: "semantic_conversion",
  step: "read_provider_response",
  attempt: 2,
} as const;
const CLIENT_PRESENTATION_LOCATION = {
  phase: "client_response_preparation",
  lane: "semantic_conversion",
  step: "render_client_error",
} as const;
const WORK_OUTCOME_LOCATION = {
  phase: "outcome_commit",
  lane: "semantic_conversion",
  step: "commit_request_outcome",
} as const;

function semanticModel(): Model<string> {
  return {
    id: "semantic-test",
    name: "Semantic Test",
    api: "semantic-test-api",
    provider: "semantic-test-provider",
    baseUrl: "https://provider-internal.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function diagnosticsFileBytes(directory: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith("diagnostics-v2.sqlite3")) continue;
    parts.push(await readFile(join(directory, name)));
  }
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

describe("OpenAI Responses Semantic Conversion Request Journey", () => {
  it("has one Request Journey observation boundary without legacy diagnostic writers", async () => {
    const sources = await Promise.all(
      ["handler.ts", "semantic.ts", "compact-semantic.ts"].map((name) =>
        readFile(
          join(process.cwd(), "src", "protocols", "openai-responses", name),
          "utf8",
        ),
      ),
    );

    for (const source of sources) {
      expect(source).not.toMatch(
        /\b(?:InvocationDiagnostics(?:Factory)?|RequestLedger(?:Entry)?|DeepCapture(?:Authority|Entry)?|createNoop(?:InvocationDiagnosticsFactory|RequestLedger|DeepCaptureAuthority|CaptureEntry)|invocationDiagnostics|requestLedger|deepCapture)\b/u,
      );
    }
  });

  it("locates a trusted Provider terminal failure without inventing Provider wire evidence", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-semantic-openai-journey-"),
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
      });

      const model = semanticModel();
      const modelCapabilityTouches: string[] = [];
      const models = new Proxy({} as Models, {
        get(_target, property) {
          if (property === "getModels") {
            return () => {
              modelCapabilityTouches.push("getModels");
              return [model];
            };
          }
          throw new Error(`Unexpected Pi Models capability: ${String(property)}`);
        },
      });
      const trustedAttempts: readonly InvocationAttempt[] = Object.freeze([
        Object.freeze({
          attempt: 1,
          classification: "http",
          stage: "response_headers",
          status: 503,
          retryable: true,
          safeIds: Object.freeze({ requestId: "provider-attempt-1" }),
        }),
        Object.freeze({
          attempt: 2,
          classification: "http",
          stage: "response_headers",
          status: 503,
          retryable: false,
          safeIds: Object.freeze({ requestId: "provider-attempt-2" }),
        }),
      ]);
      const trustedFailure = createUpstreamFailureFact({
        kind: "http",
        status: 503,
        statusText: "Service Unavailable",
        providerType: "capacity_error",
        providerCode: SAFE_PROVIDER_CODE,
        message: SAFE_FAILURE_MESSAGE,
        headers: {
          "request-id": "provider-attempt-2",
          "retry-after": "4",
          authorization: `Bearer ${PROVIDER_HEADER_SECRET}`,
        },
        retryable: false,
        attemptCount: 2,
        snapshot: {
          mediaType: "application/json",
          capturedBytes: 0,
          totalBytes: 97,
          truncated: true,
        },
      });
      const executionInputs: string[] = [];
      const semanticExecution: ExecutionOperation = vi.fn(
        async (_models, selectedModel, context, options, factsSink) => {
          executionInputs.push(
            JSON.stringify({
              model: {
                provider: selectedModel.provider,
                id: selectedModel.id,
              },
              context,
              options: {
                maxTokens: options.maxTokens,
                sessionId: options.sessionId,
              },
            }),
          );
          for (const attempt of trustedAttempts) factsSink?.attempt(attempt);
          throw new ExecutionFailure(
            "Pi execution failed with a trusted Provider fact",
            undefined,
            trustedFailure,
          );
        },
      );
      const handler = createOpenAIResponsesHandler({
        models,
        executeOperation: semanticExecution,
        stateFile: join(root, "responses-state.json"),
        maxRequestBytes: 8_192,
        createResponseId: () => "resp_semantic_must_not_render",
        createSessionId: () => "70000000-0000-4000-8000-000000000002",
        now: () => 1_787_600_000_000,
      });
      const runtime = createTokenRuntime({ clientProtocols: [handler] });
      server = await startTokenHttpServer({
        runtime,
        diagnostics: authority,
        createRequestId: () => REQUEST_ID,
        port: 0,
      });

      const requestBody = JSON.stringify({
        model: "semantic-test-provider/semantic-test",
        input: SAFE_INPUT_MARKER,
        instructions: "Keep the diagnosis precise",
        max_output_tokens: 32,
      });
      const expectedResponseBody = JSON.stringify({
        error: {
          message: SAFE_FAILURE_MESSAGE,
          type: "api_error",
          code: SAFE_PROVIDER_CODE,
          param: null,
        },
      });
      const response = await fetch(`${server.origin}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_TOKEN}`,
          "content-type": "application/json",
        },
        body: requestBody,
      });
      const responseBody = await response.text();

      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("request-id")).toBe("provider-attempt-2");
      expect(response.headers.get("retry-after")).toBe("4");
      expect(response.headers.get("authorization")).toBeNull();
      expect(response.headers.get("x-token-request-id")).toBe(REQUEST_ID);
      expect(responseBody).toBe(expectedResponseBody);
      expect(modelCapabilityTouches).toEqual(["getModels"]);
      expect(semanticExecution).toHaveBeenCalledTimes(1);
      expect(executionInputs).toHaveLength(1);
      expect(executionInputs[0]).toContain(SAFE_INPUT_MARKER);
      expect(executionInputs[0]).toContain('"id":"semantic-test"');
      expect(executionInputs[0]).not.toContain(CLIENT_TOKEN);
      expect(executionInputs[0]).not.toContain(PROVIDER_HEADER_SECRET);

      await server.close();
      server = undefined;
      const page = await authority.queryRequestJourneys({ limit: 10 });
      expect(page.records).toHaveLength(1);
      expect(page.records[0]).toMatchObject({
        requestId: REQUEST_ID,
        operation: "model_generation",
        protocol: "openai-responses",
        lane: "semantic_conversion",
        outcome: "failed",
        primaryFailureLocation: PRIMARY_LOCATION,
      });

      const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
      expect(detail.admission).toMatchObject({
        operationCandidate: "pending",
        transport: "http",
        method: "POST",
        path: "/v1/responses",
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
      expect(
        observations.filter(
          (observation) => observation.kind === "lane_committed",
        ),
      ).toEqual([
        expect.objectContaining({
          lane: "semantic_conversion",
          location: {
            phase: "request_resolution",
            lane: "semantic_conversion",
            step: "commit_lane",
          },
        }),
      ]);
      expect(
        observations.some(
          (observation) =>
            observation.location.lane === "direct" ||
            observation.location.lane === "provider_native",
        ),
      ).toBe(false);

      expect(completedStep(observations, "p3.convert_request_envelope"))
        .toMatchObject({
          completion: "success",
          location: {
            phase: "lane_request_preparation",
            lane: "semantic_conversion",
            direction: "client_to_pi",
            step: "convert_request_envelope",
            subject: "envelope",
          },
        });
      expect(completedStep(observations, "p3.finalize_pi_invocation"))
        .toMatchObject({
          completion: "success",
          location: {
            phase: "lane_request_preparation",
            lane: "semantic_conversion",
            direction: "client_to_pi",
            step: "finalize_pi_invocation",
            subject: "envelope",
          },
        });
      const invocationDescriptor = detail.artifacts.find(
        (artifact) => artifact.artifactId === "pi_invocation_snapshot",
      );
      expect(invocationDescriptor).toMatchObject({
        artifactKind: "pi_invocation_snapshot",
        state: "captured",
        mediaType: "application/json",
        truncated: false,
      });
      expect(invocationDescriptor?.capturedBytes).toBeGreaterThan(0);
      expect(invocationDescriptor?.capturedBytes).toBeLessThanOrEqual(
        256 * 1_024,
      );
      const invocationArtifact = await authority.getRequestArtifact({
        requestId: REQUEST_ID,
        artifactId: "pi_invocation_snapshot",
        offset: 0,
        limit: 256 * 1_024,
      });
      const invocationJson = Buffer.from(
        invocationArtifact.dataBase64,
        "base64",
      ).toString("utf8");
      expect(() => JSON.parse(invocationJson)).not.toThrow();
      expect(invocationJson).toContain(SAFE_INPUT_MARKER);
      expect(invocationJson).not.toContain(CLIENT_TOKEN);
      expect(invocationJson).not.toContain(PROVIDER_HEADER_SECRET);

      expect(completedStep(observations, "p4.create_pi_stream"))
        .toMatchObject({
          completion: "failed",
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "create_pi_stream",
          },
        });
      expect(completedStep(observations, "p4.read_provider_response"))
        .toMatchObject({ completion: "failed", location: PRIMARY_LOCATION });
      expect(
        observations.filter(
          (observation) => observation.kind === "attempt_observed",
        ),
      ).toEqual([
        expect.objectContaining({
          attempt: 1,
          status: 503,
          transition: "response",
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "read_provider_response",
            attempt: 1,
          },
        }),
        expect.objectContaining({
          attempt: 2,
          status: 503,
          transition: "response",
          location: {
            phase: "upstream_execution",
            lane: "semantic_conversion",
            step: "read_provider_response",
            attempt: 2,
          },
        }),
      ]);
      const primaryFailures = observations.filter(
        (observation) =>
          observation.kind === "failure_detected" &&
          observation.role === "primary",
      );
      expect(primaryFailures).toEqual([
        expect.objectContaining({
          failureId: detail.incident?.primaryFailureId,
          classification: "trusted_upstream_http_failure",
          origin: "provider",
          originPrecision: "external_boundary",
          safeMessage: SAFE_FAILURE_MESSAGE,
          location: PRIMARY_LOCATION,
        }),
      ]);
      expect(detail.incident?.failures).toContainEqual(primaryFailures[0]);

      const providerOutboundObservation = observations.find(
        (observation) =>
          observation.kind === "artifact_observed" &&
          observation.artifactId === "pi_provider_outbound_request_evidence",
      );
      expect(providerOutboundObservation).toMatchObject({
        state: "unavailable",
        reason: "provider_did_not_expose",
        location: {
          phase: "upstream_execution",
          lane: "semantic_conversion",
          direction: "pi_to_provider",
          step: "convert_pi_request",
          subject: "envelope",
        },
      });
      const providerDecodeObservation = observations.find(
        (observation) =>
          observation.kind === "artifact_observed" &&
          observation.artifactId === "pi_provider_response_decode_evidence",
      );
      expect(providerDecodeObservation).toMatchObject({
        state: "unavailable",
        reason: "provider_did_not_expose",
        location: {
          phase: "upstream_execution",
          lane: "semantic_conversion",
          direction: "provider_to_pi",
          step: "decode_provider_events",
          subject: "envelope",
        },
      });
      expect(
        detail.artifacts.find(
          (artifact) =>
            artifact.artifactId === "pi_provider_outbound_request_evidence",
        ),
      ).toMatchObject({
        state: "unavailable",
        reason: "provider_did_not_expose",
      });
      expect(
        detail.artifacts.find(
          (artifact) =>
            artifact.artifactId === "pi_provider_response_decode_evidence",
        ),
      ).toMatchObject({
        state: "unavailable",
        reason: "provider_did_not_expose",
      });

      const terminalDescriptor = detail.artifacts.find(
        (artifact) => artifact.artifactId === "pi_terminal_summary",
      );
      expect(terminalDescriptor).toMatchObject({
        artifactKind: "pi_terminal_summary",
        state: "captured",
        mediaType: "application/json",
        truncated: false,
      });
      const terminalArtifact = await authority.getRequestArtifact({
        requestId: REQUEST_ID,
        artifactId: "pi_terminal_summary",
        offset: 0,
        limit: 256 * 1_024,
      });
      const terminalJson = JSON.parse(
        Buffer.from(terminalArtifact.dataBase64, "base64").toString("utf8"),
      ) as Record<string, unknown>;
      expect(terminalJson).toMatchObject({
        kind: "http",
        status: 503,
        providerCode: SAFE_PROVIDER_CODE,
        message: SAFE_FAILURE_MESSAGE,
        attemptCount: 2,
        truncated: true,
      });
      expect(JSON.stringify(terminalJson)).not.toContain(PROVIDER_HEADER_SECRET);
      expect(
        observations.some(
          (observation) =>
            observation.location.phase === "lane_response_processing",
        ),
      ).toBe(false);

      expect(completedStep(observations, "p6.render_client_error"))
        .toMatchObject({
          completion: "success",
          location: CLIENT_PRESENTATION_LOCATION,
        });
      expect(detail.clientPresentation).toEqual({
        status: 503,
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
        terminalAuthority: "pi_execution",
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
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "client_response_wire",
            state: "captured",
            mediaType: "application/json",
            originalBytes: Buffer.byteLength(responseBody),
            capturedBytes: Buffer.byteLength(responseBody),
            truncated: false,
          }),
        ]),
      );

      const projectedDetail = JSON.stringify(detail);
      expect(projectedDetail).not.toContain(CLIENT_TOKEN);
      expect(projectedDetail).not.toContain(PROVIDER_HEADER_SECRET);

      await authority.close();
      authority = undefined;
      const persistedBytes = await diagnosticsFileBytes(diagnosticsDirectory);
      expect(persistedBytes.includes(Buffer.from(REQUEST_ID))).toBe(true);
      expect(persistedBytes.includes(Buffer.from(SAFE_INPUT_MARKER))).toBe(true);
      expect(persistedBytes.includes(Buffer.from(CLIENT_TOKEN))).toBe(false);
      expect(persistedBytes.includes(Buffer.from(PROVIDER_HEADER_SECRET))).toBe(
        false,
      );
    } finally {
      await Promise.allSettled([
        server?.close() ?? Promise.resolve(),
        authority?.close() ?? Promise.resolve(),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
