import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { decodeRequestJourneyRecord } from "@token/application-control-plane/control-plane";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
} from "../../src/diagnostics/index.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

const JOURNEY_PHASES = [
  "http_admission",
  "protocol_ingress",
  "request_resolution",
  "lane_request_preparation",
  "upstream_execution",
  "lane_response_processing",
  "client_response_preparation",
  "outcome_commit",
  "http_handoff",
] as const;

const REQUEST_ID = "20000000-0000-4000-8000-000000000001";

function commandCodeSuccess(): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text: "diagnosed" }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      }),
      "",
    ].join("\n"),
    { status: 200 },
  );
}

describe("unified Request Journey tracer", () => {
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

  it("persists one successful Anthropic Semantic Conversion journey from P0 through P8", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-request-journey-"));
    roots.push(root);
    const configuration = parseDiagnosticsConfiguration(
      { directory: root },
      root,
    );
    const authority = await createDiagnosticsAuthority({ configuration });
    authorities.push(authority);
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-provider-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: async () => commandCodeSuccess(),
      modelId: "claude-fixture",
      createMessageId: () => "msg_diagnostics_tracer",
      createSessionId: () => "10000000-0000-4000-8000-000000000001",
      now: () => 1_787_472_000_000,
    });
    const server = await startTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-fixture",
        max_tokens: 32,
        messages: [{ role: "user", content: "diagnose this request" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      id: "msg_diagnostics_tracer",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "diagnosed" }],
      stop_reason: "end_turn",
    });

    await expect
      .poll(async () => {
        const page = await authority.queryRequestJourneys({ limit: 10 });
        return page.records.length;
      })
      .toBe(1);

    const page = await authority.queryRequestJourneys({ limit: 10 });
    const summary = page.records[0]!;
    const responseRequestId = response.headers.get("x-token-request-id");
    expect(responseRequestId).toBe(REQUEST_ID);
    expect(summary.requestId).toBe(REQUEST_ID);
    expect(page.records.map((record) => record.requestId)).toEqual([REQUEST_ID]);
    expect(summary).toMatchObject({
      operation: "model_generation",
      protocol: "anthropic-messages",
      lane: "semantic_conversion",
      outcome: "success",
    });

    const detail = await authority.getRequestJourney({
      requestId: summary.requestId,
    });
    expect(detail).toMatchObject({
      requestId: REQUEST_ID,
      admission: {
        operationCandidate: "pending",
        transport: "http",
        method: "POST",
        path: "/v1/messages",
        cancellation: {
          caller: "active",
        },
      },
      workOutcome: {
        outcome: "success",
        terminalAuthority: "pi_execution",
      },
      clientPresentation: {
        status: 200,
        mediaType: "application/json",
      },
      handoffOutcome: {
        outcome: "finished",
        transport: "http",
        writableFinished: true,
      },
    });
    expect(detail.admission).not.toHaveProperty("requestId");
    expect(decodeRequestJourneyRecord(detail)).toEqual(detail);
    expect(detail.incident).toBeUndefined();
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactKind: "client_request_wire",
          state: "unavailable",
          reason: "full_journey_capture_disabled",
        }),
        expect.objectContaining({
          artifactKind: "client_response_wire",
          state: "unavailable",
          reason: "full_journey_capture_disabled",
        }),
      ]),
    );
    const observations = detail.timeline.map((event) => event.observation);
    expect(
      Array.from(
        new Set(observations.map((observation) => observation.location.phase)),
      ),
    ).toEqual(JOURNEY_PHASES);
    const enteredSteps = observations
      .filter((observation) => observation.kind === "step_entered")
      .map((observation) => observation.location.step);
    expect(enteredSteps).toEqual(
      expect.arrayContaining([
        "admit_http_request",
        "resolve_route",
        "resolve_public_model",
        "validate_client_semantics",
        "finalize_pi_invocation",
        "create_pi_stream",
        "validate_assistant_message",
        "encode_client_json",
        "commit_request_outcome",
        "write_http_response",
      ]),
    );
    expect(
      observations.some(
        (observation) =>
          observation.kind === "lane_committed" &&
          observation.lane === "semantic_conversion",
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.kind === "handoff_observed" &&
          observation.location.phase === "http_handoff" &&
          observation.location.step === "write_http_response" &&
          observation.outcome === "finished" &&
          observation.transport === "http" &&
          observation.writableFinished === true,
      ),
    ).toBe(true);
  });
});
