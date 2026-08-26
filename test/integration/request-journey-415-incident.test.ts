import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

const REQUEST_ID = "40000000-0000-4000-8000-000000000001";
const FAILURE_LOCATION = {
  phase: "protocol_ingress",
  step: "validate_media_and_encoding",
} as const;
const CLIENT_PRESENTATION_LOCATION = {
  phase: "client_response_preparation",
  step: "prepare_anthropic_error_response",
} as const;
const WORK_OUTCOME_LOCATION = {
  phase: "outcome_commit",
  step: "commit_request_outcome",
} as const;

describe("Request Journey protocol incidents", () => {
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

  it("records an exact P1 incident for an unread unsupported-media request", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-journey-415-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);

    let providerCalls = 0;
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-provider-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: async () => {
        providerCalls += 1;
        throw new Error("Provider must not run for an unsupported media type");
      },
      modelId: "claude-fixture",
    });
    const server = await startTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const expectedResponse = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Content-Type must be application/json",
      },
      request_id: REQUEST_ID,
    };
    const response = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-client-key",
        "content-type": "text/plain",
        "anthropic-version": "2023-06-01",
      },
      body: "this body must not be read",
    });
    const responseBody = await response.text();

    expect(providerCalls).toBe(0);
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-token-request-id")).toBe(REQUEST_ID);
    expect(responseBody).toBe(JSON.stringify(expectedResponse));
    expect(JSON.parse(responseBody)).toEqual(expectedResponse);

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
      protocol: "anthropic-messages",
      outcome: "failed",
    });
    expect(summary.primaryFailureLocation).toEqual(FAILURE_LOCATION);
    expect(summary).not.toHaveProperty("lane");

    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect(detail.incident).toBeDefined();
    const primaryFailureId = detail.incident!.primaryFailureId;
    expect(primaryFailureId).not.toBe("");

    const primaryFailure = detail.timeline
      .map((event) => event.observation)
      .find(
        (observation) =>
          observation.kind === "failure_detected" &&
          observation.failureId === primaryFailureId,
      );
    expect(primaryFailure).toMatchObject({
      kind: "failure_detected",
      failureId: primaryFailureId,
      role: "primary",
      classification: "unsupported_media_type",
      origin: "client",
      originPrecision: "exact",
      location: FAILURE_LOCATION,
    });
    expect(detail.incident!.failures).toContainEqual(primaryFailure);

    const mediaStepEvents = detail.timeline
      .map((event) => event.observation)
      .filter(
        (observation) =>
          (observation.kind === "step_entered" ||
            observation.kind === "step_completed") &&
          observation.stepInstanceId === "p1.validate_media_and_encoding",
      );
    expect(mediaStepEvents).toEqual([
      {
        kind: "step_entered",
        stepInstanceId: "p1.validate_media_and_encoding",
        location: FAILURE_LOCATION,
      },
      {
        kind: "step_completed",
        stepInstanceId: "p1.validate_media_and_encoding",
        completion: "failed",
        operation: "model_generation",
        protocol: "anthropic-messages",
        location: FAILURE_LOCATION,
      },
    ]);
    expect(detail.workOutcome).toEqual({
      outcome: "failed",
      terminalAuthority: "anthropic_messages_handler",
      location: WORK_OUTCOME_LOCATION,
    });
    expect(detail.clientPresentation).toEqual({
      status: 415,
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
          state: "unavailable",
          reason: "body_not_read_due_to_media_type",
        }),
        expect.objectContaining({
          artifactId: "client_response_wire",
          artifactKind: "client_response_wire",
          state: "captured",
          mediaType: "application/json",
          originalBytes: Buffer.byteLength(responseBody),
          capturedBytes: Buffer.byteLength(
            JSON.stringify(JSON.parse(responseBody), null, 2),
          ),
          truncated: false,
        }),
      ]),
    );

    const responseArtifact = await authority.getRequestArtifact({
      requestId: REQUEST_ID,
      artifactId: "client_response_wire",
      offset: 0,
      limit: 256 * 1_024,
    });
    expect(responseArtifact).toMatchObject({
      requestId: REQUEST_ID,
      artifactId: "client_response_wire",
      offset: 0,
      complete: true,
    });
    expect(
      JSON.parse(
        Buffer.from(responseArtifact.dataBase64, "base64").toString("utf8"),
      ),
    ).toEqual(JSON.parse(responseBody));
  });
});
