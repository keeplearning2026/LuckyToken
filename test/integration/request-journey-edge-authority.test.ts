import { afterEach, describe, expect, it } from "vitest";

import type {
  RequestJourneyBeginInput,
  RequestJourneyCloseInput,
  RequestJourneyObservationAuthority,
  RequestJourneyObservationInput,
} from "../../src/diagnostics/index.js";
import type { ClientProtocolHandler } from "../../src/http.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const P0_REQUEST_ID = "30000000-0000-4000-8000-000000000001";
const HANDLER_REQUEST_ID = "40000000-0000-4000-8000-000000000002";

interface RecordedJourney {
  readonly admission: RequestJourneyBeginInput;
  readonly observations: RequestJourneyObservationInput[];
  close?: RequestJourneyCloseInput;
}

function createRecordingAuthority(): {
  readonly authority: RequestJourneyObservationAuthority;
  readonly journeys: RecordedJourney[];
} {
  const journeys: RecordedJourney[] = [];
  const authority: RequestJourneyObservationAuthority = Object.freeze({
    begin(
      admission: RequestJourneyBeginInput,
    ): ReturnType<RequestJourneyObservationAuthority["begin"]> {
      const journey: RecordedJourney = {
        admission,
        observations: [],
      };
      journeys.push(journey);
      return Object.freeze({
        requestId: admission.requestId,
        observe(observation: RequestJourneyObservationInput): void {
          journey.observations.push(observation);
        },
        close(input: RequestJourneyCloseInput): void {
          journey.close = input;
        },
      });
    },
    observeRuntime(): void {
      // These request-edge tests intentionally record Request Journeys only.
    },
  });
  return { authority, journeys };
}

describe("Request Journey HTTP edge authority", () => {
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("records the direct in-process response handoff before closing", async () => {
    const recording = createRecordingAuthority();
    const handler: ClientProtocolHandler = {
      method: "GET",
      pathname: "/in-process",
      handle: async () => new Response("in-process-body", { status: 200 }),
    };
    const runtime = createTokenRuntime({
      clientProtocols: [handler],
      diagnostics: recording.authority,
      createRequestId: () => P0_REQUEST_ID,
    });

    const response = await runtime.handle(
      new Request("http://Token.test/in-process"),
    );

    expect(await response.text()).toBe("in-process-body");
    expect(recording.journeys).toHaveLength(1);
    const journey = recording.journeys[0]!;
    expect(journey.admission.transport).toBe("in_process");
    expect(journey.observations).toEqual(
      expect.arrayContaining([
        {
          kind: "step_entered",
          stepInstanceId: "p8.return_in_process_response",
          location: {
            phase: "http_handoff",
            step: "return_in_process_response",
          },
        },
        {
          kind: "handoff_observed",
          outcome: "finished",
          transport: "in_process",
          location: {
            phase: "http_handoff",
            step: "return_in_process_response",
          },
        },
        {
          kind: "step_completed",
          stepInstanceId: "p8.return_in_process_response",
          completion: "success",
          location: {
            phase: "http_handoff",
            step: "return_in_process_response",
          },
        },
      ]),
    );
    expect(journey.close).toMatchObject({
      outcome: "success",
      lastKnownLocation: {
        phase: "http_handoff",
        step: "return_in_process_response",
      },
    });
  });

  it("keeps the P0 request id authoritative when a handler publishes a different legacy id", async () => {
    const recording = createRecordingAuthority();
    const handler: ClientProtocolHandler = {
      method: "POST",
      pathname: "/edge-id",
      handle: async () => new Response("stable-body", { status: 200 }),
      requestIdFor: () => HANDLER_REQUEST_ID,
    };
    const server = await startTokenHttpServer({
      runtime: createTokenRuntime({ clientProtocols: [handler] }),
      diagnostics: recording.authority,
      createRequestId: () => P0_REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`${server.origin}/edge-id`, { method: "POST" });
    await expect(response.text()).resolves.toBe("stable-body");

    expect(response.headers.get("x-token-request-id")).toBe(
      P0_REQUEST_ID,
    );
    expect(recording.journeys).toHaveLength(1);
    expect(recording.journeys[0]!.admission.requestId).toBe(P0_REQUEST_ID);
    expect(recording.journeys[0]!.close).toMatchObject({ outcome: "success" });
  });

  it("closes a timed-out live HTTP request after presenting and handing off its synthesized 500", async () => {
    const recording = createRecordingAuthority();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const handler: ClientProtocolHandler = {
      method: "POST",
      pathname: "/times-out",
      handle: async (request) => {
        markStarted();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => {
              markAborted();
              resolve();
            },
            { once: true },
          );
        });
        throw request.signal.reason;
      },
    };
    const server = await startTokenHttpServer({
      runtime: createTokenRuntime({
        clientProtocols: [handler],
        requestTimeoutMs: 1,
      }),
      diagnostics: recording.authority,
      createRequestId: () => P0_REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const responsePromise = fetch(`${server.origin}/times-out`, {
      method: "POST",
    });
    await started;
    await aborted;
    const response = await responsePromise;
    expect(response.status).toBe(500);
    expect(response.headers.get("x-token-request-id")).toBe(
      P0_REQUEST_ID,
    );
    await response.arrayBuffer();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(recording.journeys).toHaveLength(1);
    const journey = recording.journeys[0]!;
    expect(journey.close).toMatchObject({ outcome: "aborted" });
    expect(journey.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "client_response_prepared",
          status: 500,
          location: expect.objectContaining({
            phase: "client_response_preparation",
          }),
        }),
        expect.objectContaining({
          kind: "handoff_observed",
          outcome: "finished",
          transport: "http",
          writableFinished: true,
          location: expect.objectContaining({
            phase: "http_handoff",
            step: "write_http_response",
          }),
        }),
      ]),
    );
  });
});
