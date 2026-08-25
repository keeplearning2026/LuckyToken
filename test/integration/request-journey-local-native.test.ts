import type { Models } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexFetchFunction,
  CodexNativeModelSource,
} from "../../src/codex-native-seam.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
} from "../../src/diagnostics/index.js";
import type { ExecutionOperation } from "../../src/execution.js";
import { createCodexDirectResponsesLane } from "../../src/integrations/codex/local-responses.js";
import {
  createOpenAIResponsesHandler,
} from "../../src/protocols/openai-responses/handler.js";
import type { ProviderResponsesLane } from "../../src/provider-native-responses/contract.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "50000000-0000-4000-8000-000000000001";
const FAILURE_LOCATION = {
  phase: "upstream_execution",
  lane: "direct",
  step: "read_direct_response",
  attempt: 1,
} as const;
const CLIENT_PRESENTATION_LOCATION = {
  phase: "client_response_preparation",
  lane: "direct",
  step: "render_direct_error_response",
} as const;
const WORK_OUTCOME_LOCATION = {
  phase: "outcome_commit",
  lane: "direct",
  step: "commit_request_outcome",
} as const;

describe("Direct Mode Request Journey", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("locates a Codex response-body read failure without entering either other lane", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-local-journey-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
    });
    authorities.push(authority);

    let piModelsTouches = 0;
    const piModels = new Proxy({} as Models, {
      get() {
        piModelsTouches += 1;
        throw new Error("Pi Models must not be touched by Direct Mode");
      },
    });
    const semanticExecution = vi.fn(async () => {
      throw new Error("Semantic Conversion must not execute");
    }) as unknown as ExecutionOperation;
    const providerClaims = vi.fn(() => {
      throw new Error("Provider Native claims must not run");
    });
    const providerExecute = vi.fn(async () => {
      throw new Error("Provider Native execution must not run");
    });
    const providerNativeLane: ProviderResponsesLane = {
      claims: providerClaims,
      execute: providerExecute,
    };

    const credentialSecret = "client-token";
    const nativeModels: CodexNativeModelSource = Object.freeze({
      has: (modelId: string) => modelId === "gpt-native",
    });
    const outboundRequests: Array<{
      readonly url: string;
      readonly method: string;
      readonly body: string;
    }> = [];
    const localFetch: CodexFetchFunction = async (input, init) => {
      const outbound = new Request(input, init);
      outboundRequests.push({
        url: outbound.url,
        method: outbound.method,
        body: await outbound.clone().text(),
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("fixture upstream body read failure"));
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "upstream-local-request",
          },
        },
      );
    };
    const directLane = createCodexDirectResponsesLane({
      models: nativeModels,
      fetch: localFetch,
    });
    const handler = createOpenAIResponsesHandler({
      models: piModels,
      directLane,
      providerNativeLane,
      executeOperation: semanticExecution,
      stateFile: join(root, "responses-state.json"),
      maxRequestBytes: 4_096,
      createSessionId: () => "50000000-0000-4000-8000-000000000002",
    });
    const runtime = createTokenRuntime({ clientProtocols: [handler] });
    const server = await startTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const requestBody = JSON.stringify({
      model: "gpt-native",
      input: "diagnose local body read",
    });
    const expectedResponseBody = JSON.stringify({
      error: {
        message: "Upstream provider response could not be read",
        type: "api_error",
        code: null,
        param: null,
      },
    });
    const response = await fetch(`${server.origin}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer client-token",
        "chatgpt-account-id": "client-account",
        "content-type": "application/json",
      },
      body: requestBody,
    });
    const responseBody = await response.text();

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.has("x-token-request-id")).toBe(false);
    expect(responseBody).toBe(expectedResponseBody);
    expect(outboundRequests).toEqual([
      {
        url: "https://chatgpt.com/backend-api/codex/responses",
        method: "POST",
        body: requestBody,
      },
    ]);
    expect(piModelsTouches).toBe(0);
    expect(providerClaims).not.toHaveBeenCalled();
    expect(providerExecute).not.toHaveBeenCalled();
    expect(semanticExecution).not.toHaveBeenCalled();

    await expect
      .poll(async () => {
        const page = await authority.queryRequestJourneys({ limit: 10 });
        return page.records.length;
      })
      .toBe(1);
    const page = await authority.queryRequestJourneys({ limit: 10 });
    const summary = page.records[0]!;
    expect(summary).toMatchObject({
      requestId: REQUEST_ID,
      operation: "model_generation",
      protocol: "openai-responses",
      lane: "direct",
      outcome: "failed",
      primaryFailureLocation: FAILURE_LOCATION,
    });

    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    const primaryFailureId = detail.incident?.primaryFailureId;
    expect(primaryFailureId).toBeTypeOf("string");
    const observations = detail.timeline.map((event) => event.observation);
    const primaryFailure = observations.find(
      (observation) =>
        observation.kind === "failure_detected" &&
        observation.failureId === primaryFailureId,
    );
    expect(primaryFailure).toMatchObject({
      kind: "failure_detected",
      role: "primary",
      classification: "local_upstream_response_body_read_failed",
      origin: "network_os",
      originPrecision: "boundary",
      location: FAILURE_LOCATION,
    });
    expect(detail.incident?.failures).toContainEqual(primaryFailure);

    const completedSteps = observations.filter(
      (observation) => observation.kind === "step_completed",
    );
    expect(completedSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepInstanceId: "p2.extract_model_selector",
          completion: "success",
          operation: "model_generation",
          protocol: "openai-responses",
          location: {
            phase: "request_resolution",
            step: "extract_model_selector",
          },
        }),
        expect.objectContaining({
          stepInstanceId: "p2.recognize_direct",
          completion: "success",
          location: {
            phase: "request_resolution",
            lane: "direct",
            step: "recognize_direct",
          },
        }),
        expect.objectContaining({
          stepInstanceId: "p3.preserve_caller_envelope",
          completion: "success",
          location: {
            phase: "lane_request_preparation",
            lane: "direct",
            step: "preserve_caller_envelope",
          },
        }),
        expect.objectContaining({
          stepInstanceId: "p3.construct_direct_envelope",
          completion: "success",
          location: {
            phase: "lane_request_preparation",
            lane: "direct",
            step: "construct_direct_envelope",
          },
        }),
        expect.objectContaining({
          stepInstanceId: "p4.read_direct_response",
          completion: "failed",
          location: FAILURE_LOCATION,
        }),
      ]),
    );
    expect(
      observations.some(
        (observation) =>
          observation.kind === "lane_committed" &&
          observation.lane === "direct" &&
          observation.location.phase === "request_resolution" &&
          observation.location.step === "commit_lane",
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.location.phase === "lane_response_processing",
      ),
    ).toBe(false);

    const attempts = observations.filter(
      (observation) => observation.kind === "attempt_observed",
    );
    expect(attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        transition: "started",
        location: {
          phase: "upstream_execution",
          lane: "direct",
          step: "dispatch_direct_transport",
          attempt: 1,
        },
      }),
      expect.objectContaining({
        attempt: 1,
        status: 200,
        transition: "response",
        location: FAILURE_LOCATION,
      }),
    ]);
    expect(detail.workOutcome).toEqual({
      outcome: "failed",
      terminalAuthority: "codex_direct_responses_lane",
      location: WORK_OUTCOME_LOCATION,
    });
    expect(detail.clientPresentation).toEqual({
      status: 502,
      mediaType: "application/json",
      location: CLIENT_PRESENTATION_LOCATION,
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
          mediaType: "application/json",
        }),
        expect.objectContaining({
          artifactId: "local_outbound_request_wire",
          artifactKind: "local_outbound_request_wire",
          state: "captured",
          mediaType: "application/json",
          originalBytes: Buffer.byteLength(requestBody),
          capturedBytes: Buffer.byteLength(requestBody),
          truncated: false,
        }),
        expect.objectContaining({
          artifactId: "local_upstream_response_wire",
          artifactKind: "local_upstream_response_wire",
          state: "unavailable",
          mediaType: "application/json",
          reason: "response_body_read_failed",
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
      ]),
    );
    expect(JSON.stringify(detail)).not.toContain(credentialSecret);

    const outboundArtifact = await authority.getRequestArtifact({
      requestId: REQUEST_ID,
      artifactId: "local_outbound_request_wire",
      offset: 0,
      limit: 256 * 1_024,
    });
    expect(Buffer.from(outboundArtifact.dataBase64, "base64").toString("utf8"))
      .toBe(requestBody);
  });
});
