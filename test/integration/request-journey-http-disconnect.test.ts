import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  type DiagnosticsWorkerFactory,
  type DiagnosticsWorkerSession,
} from "../../src/diagnostics/authority.js";
import { parseDiagnosticsConfiguration } from "../../src/diagnostics/configuration.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const RUNTIME_ID = "http-disconnect-runtime";
const REQUEST_ID = "70000000-0000-4000-8000-000000000001";

interface AppendEnvelope {
  readonly type?: string;
  readonly messageKind?: string;
  readonly payload?: Readonly<{
    readonly kind?: string;
    readonly outcome?: string;
    readonly location?: Readonly<{
      readonly phase?: string;
      readonly step?: string;
    }>;
  }>;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function createObservationHarness(): {
  readonly factory: DiagnosticsWorkerFactory;
  readonly waitForP8Entered: () => Promise<void>;
  readonly waitForCloseSeal: () => Promise<void>;
  readonly closeSealOutcomes: () => readonly string[];
  readonly terminalHandoffPostCount: () => number;
  readonly terminalHandoffBeforeClose: () => boolean;
} {
  const p8Entered = deferred();
  const closeSeal = deferred();
  const appendOrder: string[] = [];
  const closeOutcomes: string[] = [];
  let terminalHandoffPosts = 0;
  let created = false;

  const factory: DiagnosticsWorkerFactory = (input) => {
    if (created) throw new Error("HTTP disconnect harness expects one Worker");
    created = true;
    const worker = new Worker(input.source, {
      eval: true,
      workerData: input.workerData,
    });
    const session: DiagnosticsWorkerSession = {
      postMessage(message: object): void {
        const envelope = message as AppendEnvelope;
        const payload = envelope.payload;
        if (
          envelope.type === "append" &&
          envelope.messageKind === "observation" &&
          payload?.kind === "step_entered" &&
          payload.location?.phase === "http_handoff"
        ) {
          appendOrder.push("p8_entered");
          p8Entered.resolve();
        }
        if (
          envelope.type === "append" &&
          envelope.messageKind === "observation" &&
          payload?.kind === "handoff_observed" &&
          (payload.outcome === "closed" || payload.outcome === "failed")
        ) {
          appendOrder.push("handoff_terminal");
          terminalHandoffPosts += 1;
        }
        if (envelope.type === "append" && envelope.messageKind === "close") {
          appendOrder.push("close");
          if (typeof payload?.outcome === "string") {
            closeOutcomes.push(payload.outcome);
          }
          closeSeal.resolve();
        }
        worker.postMessage(message);
      },
      onMessage(listener): void {
        worker.on("message", listener);
      },
      onError(listener): void {
        worker.on("error", listener);
      },
      onExit(listener): void {
        worker.on("exit", listener);
      },
      terminate: () => worker.terminate(),
    };
    return Object.freeze(session);
  };

  return {
    factory,
    waitForP8Entered: () => p8Entered.promise,
    waitForCloseSeal: () => closeSeal.promise,
    closeSealOutcomes: () => Object.freeze([...closeOutcomes]),
    terminalHandoffPostCount: () => terminalHandoffPosts,
    terminalHandoffBeforeClose: () => {
      const handoff = appendOrder.indexOf("handoff_terminal");
      const close = appendOrder.indexOf("close");
      return handoff >= 0 && close >= 0 && handoff < close;
    },
  };
}

function waitForSocketEvent(socket: Socket, event: "connect" | "close") {
  return new Promise<void>((resolve) => socket.once(event, () => resolve()));
}

describe("Request Journey early HTTP client disconnect", () => {
  it("records the real P8 handoff failure before sealing the Journey exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-http-disconnect-"));
    const diagnosticsDirectory = join(root, "diagnostics");
    const harness = createObservationHarness();
    const bodyReadStarted = deferred();
    const releaseBody = deferred();
    let bodyReleased = false;
    let bodyCancelled = false;
    let server: RunningTokenHttpServer | undefined;
    let socket: Socket | undefined;
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: diagnosticsDirectory },
        root,
      ),
      runtimeId: RUNTIME_ID,
      workerFactory: harness.factory,
    });

    try {
      const runtime = createTokenRuntime({
        clientProtocols: [
          {
            method: "GET",
            pathname: "/disconnect",
            handle: async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  async pull(controller) {
                    bodyReadStarted.resolve();
                    await releaseBody.promise;
                    if (bodyCancelled || bodyReleased) return;
                    bodyReleased = true;
                    controller.enqueue(new TextEncoder().encode("late-body"));
                    controller.close();
                  },
                  cancel() {
                    bodyCancelled = true;
                  },
                }),
                { status: 200, headers: { "content-type": "text/plain" } },
              ),
          },
        ],
      });
      server = await startTokenHttpServer({
        runtime,
        diagnostics: authority,
        createRequestId: () => REQUEST_ID,
        port: 0,
      });
      socket = connect(server.port, server.host);
      socket.on("error", () => undefined);
      await waitForSocketEvent(socket, "connect");
      socket.write(
        "GET /disconnect HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );

      await bodyReadStarted.promise;
      await harness.waitForP8Entered();
      const socketClosed = waitForSocketEvent(socket, "close");
      socket.destroy();
      await socketClosed;
      releaseBody.resolve();
      await harness.waitForCloseSeal();
      await server.close();
      server = undefined;
      const journey = await authority.getRequestJourney({
        requestId: REQUEST_ID,
      });
      const handoffs = journey.timeline.filter(
        (event) => event.observation.kind === "handoff_observed",
      );

      // The current bug closes the observer from the generic response-close
      // listener first, so the later truthful P8 closed observation is lost.
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]!.observation).toMatchObject({
        kind: "handoff_observed",
        outcome: expect.stringMatching(/^(closed|failed)$/u),
        transport: "http",
        location: {
          phase: "http_handoff",
          step: "write_http_response",
        },
      });
      const p8EnteredIndex = journey.timeline.findIndex(
        (event) =>
          event.observation.kind === "step_entered" &&
          event.observation.location.phase === "http_handoff",
      );
      const handoffIndex = journey.timeline.findIndex(
        (event) => event.observation.kind === "handoff_observed",
      );
      expect(p8EnteredIndex).toBeGreaterThanOrEqual(0);
      expect(handoffIndex).toBeGreaterThan(p8EnteredIndex);
      expect(harness.terminalHandoffPostCount()).toBe(1);
      expect(harness.terminalHandoffBeforeClose()).toBe(true);
      expect(harness.closeSealOutcomes()).toHaveLength(1);
      expect(harness.closeSealOutcomes()[0]).toMatch(/^(aborted|failed)$/u);
      expect(journey.outcome).toMatch(/^(aborted|failed)$/u);
      expect(journey.handoffOutcome).toMatchObject({
        outcome: expect.stringMatching(/^(closed|failed)$/u),
        transport: "http",
        location: {
          phase: "http_handoff",
          step: "write_http_response",
        },
      });
      expect(journey.incident).toMatchObject({
        failures: [
          expect.objectContaining({
            kind: "failure_detected",
            role: "primary",
            classification: "http_connection_aborted",
            origin: "client",
            location: {
              phase: "http_handoff",
              step: "write_http_response",
            },
          }),
        ],
      });
    } finally {
      releaseBody.resolve();
      socket?.destroy();
      await server?.close().catch(() => undefined);
      await authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a protocol handler exception as the primary runtime fallback Incident", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-http-fallback-"));
    const requestId = "70000000-0000-4000-8000-000000000002";
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
      runtimeId: `${RUNTIME_ID}-fallback`,
    });
    let server: RunningTokenHttpServer | undefined;
    try {
      const runtime = createTokenRuntime({
        clientProtocols: [
          {
            method: "GET",
            pathname: "/throws",
            handle: async () => {
              throw new Error("fixture protocol failure");
            },
          },
        ],
      });
      server = await startTokenHttpServer({
        runtime,
        diagnostics: authority,
        createRequestId: () => requestId,
        port: 0,
      });

      const response = await fetch(`${server.origin}/throws`);
      await response.arrayBuffer();
      expect(response.status).toBe(500);
      const page = await authority.queryRequestJourneys({ limit: 10 });
      expect(page.records).toContainEqual(
        expect.objectContaining({
          requestId,
          outcome: "failed",
          primaryFailureLocation: {
            phase: "protocol_ingress",
            step: "invoke_protocol_handler",
          },
        }),
      );
      const journey = await authority.getRequestJourney({ requestId });
      expect(journey.incident).toMatchObject({
        failures: [
          expect.objectContaining({
            kind: "failure_detected",
            role: "primary",
            classification: "protocol_handler_failed",
            origin: "Token",
            location: {
              phase: "protocol_ingress",
              step: "invoke_protocol_handler",
            },
          }),
        ],
      });
      expect(journey.timeline.map((event) => event.observation)).toContainEqual(
        expect.objectContaining({
          kind: "step_completed",
          stepInstanceId: "p1.invoke_protocol_handler",
          completion: "failed",
        }),
      );
    } finally {
      await server?.close().catch(() => undefined);
      await authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
