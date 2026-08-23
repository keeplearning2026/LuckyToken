import { createModels } from "@earendil-works/pi-ai";
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
import { createModelsDiscoveryHandler } from "../../src/models-discovery.js";
import type { PublicModelSource } from "../../src/public-model-seam.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "66000000-0000-4000-8000-000000000001";
const SUCCESS_REQUEST_ID = "66000000-0000-4000-8000-000000000002";
const PROJECTION_CANARY = "model-discovery-projection-canary-2ff874";
const ROUTE_LOCATION = {
  phase: "protocol_ingress",
  step: "resolve_route",
} as const;
const READ_LOCATION = {
  phase: "client_response_preparation",
  step: "read_publication_snapshot",
} as const;
const PRIMARY_LOCATION = {
  phase: "client_response_preparation",
  step: "project_model_list",
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
    requestId: response.headers.get("x-luckytoken-request-id"),
    mediaType: response.headers.get("content-type"),
    body: Object.freeze([...new Uint8Array(await response.arrayBuffer())]),
  });
}

function projectionFailingSource(): PublicModelSource {
  const malformedEntry = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(malformedEntry, {
    alias: {
      enumerable: true,
      get: () => {
        throw new Error(PROJECTION_CANARY);
      },
    },
    providerId: {
      enumerable: true,
      value: "fixture-provider",
    },
  });
  return Object.freeze({
    requestSnapshot: async () =>
      ({
        publishedModels: () => Object.freeze([malformedEntry]),
      }) as unknown as Awaited<
        ReturnType<PublicModelSource["requestSnapshot"]>
      >,
  });
}

describe("Request Journey model discovery", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const subscriptions: DiagnosticsSubscription[] = [];
  const servers: RunningLuckyTokenHttpServer[] = [];

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

  it("records the successful model-list encoding and terminal handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-models-success-"));
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
        if (record.requestId === SUCCESS_REQUEST_ID) publish(record);
      }),
    );
    const handler = createModelsDiscoveryHandler({
      models: createModels(),
      publicModels: {
        requestSnapshot: async () =>
          ({
            publishedModels: () => [
              {
                alias: "public-model",
                providerId: "fixture-provider",
                modelId: "fixture-model",
              },
            ],
          }) as never,
      },
      now: () => 1_800_000_000_000,
    });
    const server = await startLuckyTokenHttpServer({
      runtime: createLuckyTokenRuntime({ clientProtocols: [handler] }),
      diagnostics: authority,
      createRequestId: () => SUCCESS_REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/models`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: "list",
      data: [
        {
          id: "public-model",
          object: "model",
          created: 1_800_000_000,
          owned_by: "fixture-provider",
        },
      ],
    });
    await published;

    const detail = await authority.getRequestJourney({
      requestId: SUCCESS_REQUEST_ID,
    });
    const observations = detail.timeline.map((event) => event.observation);
    expect(detail.workOutcome).toEqual({
      outcome: "success",
      terminalAuthority: "model_discovery_handler",
      location: WORK_OUTCOME_LOCATION,
    });
    expect(detail.clientPresentation).toEqual({
      status: 200,
      mediaType: "application/json",
      location: {
        phase: "client_response_preparation",
        step: "encode_model_list",
      },
    });
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "step_completed",
          stepInstanceId: "p6.encode_model_list",
          completion: "success",
          operation: "model_discovery",
        }),
        expect.objectContaining({
          kind: "handoff_observed",
          outcome: "finished",
          transport: "http",
        }),
      ]),
    );
  });

  it("records one exact model-list projection incident without changing the 500 wire", async () => {
    const handler = createModelsDiscoveryHandler({
      models: createModels(),
      publicModels: projectionFailingSource(),
      now: () => 1_800_000_000_000,
    });
    const runtime = createLuckyTokenRuntime({ clientProtocols: [handler] });
    const baselineServer = await startLuckyTokenHttpServer({
      runtime,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baselineServer);
    const baseline = await readResponse(
      await fetch(`${baselineServer.origin}/v1/models`),
    );

    const root = await mkdtemp(join(tmpdir(), "luckytoken-models-journey-"));
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
    const observedServer = await startLuckyTokenHttpServer({
      runtime,
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(observedServer);

    const observed = await readResponse(
      await fetch(`${observedServer.origin}/v1/models`),
    );
    const publishedSummary = await published;

    expect(observed).toEqual(baseline);
    expect(observed).toEqual({
      status: 500,
      requestId: REQUEST_ID,
      mediaType: null,
      body: [],
    });
    expect(JSON.stringify(observed)).not.toContain(PROJECTION_CANARY);

    expect(publishedSummary).toMatchObject({
      requestId: REQUEST_ID,
      operation: "model_discovery",
      protocol: "openai-responses",
      outcome: "failed",
      primaryFailureLocation: PRIMARY_LOCATION,
    });
    expect(publishedSummary).not.toHaveProperty("lane");

    const page = await authority.queryRequestJourneys({ limit: 10 });
    expect(page.records).toEqual([publishedSummary]);
    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect(detail.admission).toMatchObject({
      operationCandidate: "pending",
      transport: "http",
      method: "GET",
      path: "/v1/models",
    });
    expect(detail).not.toHaveProperty("lane");

    const observations = detail.timeline.map((event) => event.observation);
    const routeEvents = observations.filter(
      (observation) =>
        (observation.kind === "step_entered" ||
          observation.kind === "step_completed") &&
        observation.stepInstanceId === "p1.resolve_route",
    );
    expect(routeEvents).toEqual([
      {
        kind: "step_entered",
        stepInstanceId: "p1.resolve_route",
        location: ROUTE_LOCATION,
      },
      {
        kind: "step_completed",
        stepInstanceId: "p1.resolve_route",
        completion: "success",
        location: ROUTE_LOCATION,
      },
    ]);
    expect(observations).toEqual(
      expect.arrayContaining([
        {
          kind: "step_entered",
          stepInstanceId: "p6.read_publication_snapshot",
          location: READ_LOCATION,
        },
        {
          kind: "step_completed",
          stepInstanceId: "p6.read_publication_snapshot",
          completion: "success",
          operation: "model_discovery",
          protocol: "openai-responses",
          location: READ_LOCATION,
        },
        {
          kind: "step_entered",
          stepInstanceId: "p6.project_model_list",
          location: PRIMARY_LOCATION,
        },
        {
          kind: "step_completed",
          stepInstanceId: "p6.project_model_list",
          completion: "failed",
          operation: "model_discovery",
          protocol: "openai-responses",
          location: PRIMARY_LOCATION,
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
          operation: "model_discovery",
          protocol: "openai-responses",
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
      classification: "model_list_projection_failed",
      origin: "luckytoken",
      originPrecision: "exact",
      location: PRIMARY_LOCATION,
    });
    expect(detail.incident?.failures).toEqual(failures);
    expect(detail.workOutcome).toEqual({
      outcome: "failed",
      terminalAuthority: "model_discovery_handler",
      location: WORK_OUTCOME_LOCATION,
    });
    expect(detail.clientPresentation).toEqual({
      status: 500,
      location: PRESENTATION_LOCATION,
    });
    expect(detail.handoffOutcome).toMatchObject({
      outcome: "finished",
      transport: "http",
      writableFinished: true,
      location: HANDOFF_LOCATION,
    });
    expect(JSON.stringify(detail)).not.toContain(PROJECTION_CANARY);
  });
});
