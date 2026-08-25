import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type DiagnosticsSubscription,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "65000000-0000-4000-8000-000000000001";
const FAILURE_LOCATION = {
  phase: "protocol_ingress",
  step: "resolve_route",
} as const;
const PRESENTATION_LOCATION = {
  phase: "client_response_preparation",
  step: "render_client_error",
} as const;
const WORK_OUTCOME_LOCATION = {
  phase: "outcome_commit",
  step: "commit_request_outcome",
} as const;
const HANDOFF_LOCATION = {
  phase: "http_handoff",
  step: "write_http_response",
} as const;

interface ResponseSnapshot {
  readonly status: number;
  readonly requestId: string | null;
  readonly mediaType: string | null;
  readonly body: readonly number[];
}

async function readResponse(response: Response): Promise<ResponseSnapshot> {
  return Object.freeze({
    status: response.status,
    requestId: response.headers.get("x-token-request-id"),
    mediaType: response.headers.get("content-type"),
    body: Object.freeze([...new Uint8Array(await response.arrayBuffer())]),
  });
}

describe("Request Journey unmatched HTTP routes", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const subscriptions: DiagnosticsSubscription[] = [];
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    for (const subscription of subscriptions.splice(0)) {
      subscription.unsubscribe();
    }
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("records one exact no-lane P1 incident while preserving the unmatched 404 wire", async () => {
    const runtime = createTokenRuntime({ clientProtocols: [] });
    const baselineServer = await startTokenHttpServer({
      runtime,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baselineServer);
    const baseline = await readResponse(
      await fetch(`${baselineServer.origin}/not-a-Token-route`, {
        method: "PATCH",
      }),
    );

    const root = await mkdtemp(join(tmpdir(), "Token-unmatched-journey-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    authorities.push(authority);

    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    subscriptions.push(
      authority.subscribeRequestJourneys((record) => {
        if (record.requestId === REQUEST_ID) publish(record);
      }),
    );
    const observedServer = await startTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(observedServer);

    const observed = await readResponse(
      await fetch(`${observedServer.origin}/not-a-Token-route`, {
        method: "PATCH",
      }),
    );
    const publishedSummary = await published;

    expect(observed).toEqual(baseline);
    expect(observed).toEqual({
      status: 404,
      requestId: REQUEST_ID,
      mediaType: null,
      body: [],
    });

    expect(publishedSummary).toMatchObject({
      requestId: REQUEST_ID,
      operation: "unmatched_request",
      outcome: "failed",
      primaryFailureLocation: FAILURE_LOCATION,
    });
    expect(publishedSummary).not.toHaveProperty("protocol");
    expect(publishedSummary).not.toHaveProperty("lane");

    const page = await authority.queryRequestJourneys({ limit: 10 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toEqual(publishedSummary);

    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect(detail.admission).toMatchObject({
      operationCandidate: "pending",
      transport: "http",
      method: "PATCH",
      path: "/not-a-Token-route",
    });
    expect(detail).not.toHaveProperty("lane");
    expect(detail).not.toHaveProperty("protocol");

    const observations = detail.timeline.map((event) => event.observation);
    expect(
      observations.filter(
        (observation) =>
          observation.kind === "step_entered" ||
          observation.kind === "step_completed",
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          kind: "step_entered",
          stepInstanceId: "p1.resolve_route",
          location: FAILURE_LOCATION,
        },
        {
          kind: "step_completed",
          stepInstanceId: "p1.resolve_route",
          completion: "failed",
          operation: "unmatched_request",
          location: FAILURE_LOCATION,
        },
        {
          kind: "step_entered",
          stepInstanceId: "p6.render_client_error",
          location: PRESENTATION_LOCATION,
        },
        {
          kind: "step_completed",
          stepInstanceId: "p6.render_client_error",
          completion: "success",
          operation: "unmatched_request",
          location: PRESENTATION_LOCATION,
        },
        {
          kind: "step_entered",
          stepInstanceId: "p8.write_http_response",
          location: HANDOFF_LOCATION,
        },
        {
          kind: "step_completed",
          stepInstanceId: "p8.write_http_response",
          completion: "success",
          location: HANDOFF_LOCATION,
        },
      ]),
    );

    const failures = observations.filter(
      (observation) => observation.kind === "failure_detected",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "failure_detected",
      failureId: detail.incident?.primaryFailureId,
      role: "primary",
      classification: "unmatched_route",
      origin: "client",
      originPrecision: "exact",
      location: FAILURE_LOCATION,
    });
    expect(detail.incident?.failures).toEqual(failures);
    expect(detail.workOutcome).toEqual({
      outcome: "failed",
      terminalAuthority: "http_routing",
      location: WORK_OUTCOME_LOCATION,
    });
    expect(detail.clientPresentation).toEqual({
      status: 404,
      location: PRESENTATION_LOCATION,
    });
    expect(detail.handoffOutcome).toMatchObject({
      outcome: "finished",
      transport: "http",
      writableFinished: true,
      location: HANDOFF_LOCATION,
    });
  });
});
