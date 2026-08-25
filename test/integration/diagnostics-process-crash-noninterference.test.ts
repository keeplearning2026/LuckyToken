import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  createNodeDiagnosticsProcess,
  type DiagnosticsWorkerSession,
} from "../../src/diagnostics/authority.js";
import type { DiagnosticsAuthority } from "../../src/diagnostics/index.js";
import { parseDiagnosticsConfiguration } from "../../src/diagnostics/configuration.js";
import type {
  ClientProtocolHandler,
  ClientProtocolRequestContext,
} from "../../src/http.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "72000000-0000-4000-8000-000000000001";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function protocol(
  wait?: Readonly<{ promise: Promise<void>; started: () => void }>,
  diagnosticArtifactCount = 0,
): ClientProtocolHandler {
  return Object.freeze({
    method: "POST",
    pathname: "/fixture",
    async handle(
      _request: Request,
      context: ClientProtocolRequestContext | undefined,
    ) {
      wait?.started();
      await wait?.promise;
      const bytes = Buffer.from(`{"payload":"${"x".repeat(64 * 1_024 - 14)}"}`);
      for (let index = 0; index < diagnosticArtifactCount; index += 1) {
        context?.journey.observe({
          kind: "artifact_observed",
          artifactId: `saturation-${index}`,
          artifactKind: "saturation_probe",
          state: "captured",
          mediaType: "application/json",
          bytes,
          originalBytes: bytes.byteLength,
          capturedBytes: bytes.byteLength,
          truncated: false,
          location: {
            phase: "upstream_execution",
            step: "saturate_diagnostics_queue",
          },
        });
      }
      return new Response('{"result":"served"}', {
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-serving-authority": "data-plane",
        },
      });
    },
  });
}

class StalledDiagnosticsSession implements DiagnosticsWorkerSession {
  readonly posted: object[] = [];
  #listener: ((message: unknown) => void) | undefined;

  postMessage(message: object): boolean {
    this.posted.push(message);
    return true;
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#listener = listener;
    queueMicrotask(() => listener({ type: "ready" }));
  }

  onError(): void {}
  onExit(): void {}
  async terminate(): Promise<number> { return 0; }

  release(): void {
    for (const raw of this.posted.splice(0)) {
      const message = raw as {
        readonly type?: string;
        readonly runtimeId?: string;
        readonly requestId?: string;
        readonly recordId?: string;
        readonly sequence?: number;
        readonly artifactId?: string;
        readonly chunkIndex?: number;
        readonly commandId?: number;
      };
      if (message.type === "append") {
        this.#listener?.({
          type: "ack",
          runtimeId: message.runtimeId,
          requestId: message.requestId,
          recordId: message.recordId,
          sequence: message.sequence,
        });
      } else if (message.type?.startsWith("artifact_")) {
        this.#listener?.({
          type: "ack",
          runtimeId: message.runtimeId,
          requestId: message.requestId,
          artifactId: message.artifactId,
          chunkIndex: message.chunkIndex,
        });
      } else if (message.commandId !== undefined) {
        this.#listener?.({ type: "closed", commandId: message.commandId });
      }
    }
  }
}

async function invoke(server: RunningTokenHttpServer) {
  const response = await fetch(`${server.origin}/fixture`, {
    method: "POST",
    body: "{}",
  });
  const headers = new Headers(response.headers);
  headers.delete("date");
  return Object.freeze({
    status: response.status,
    headers: Object.freeze([...headers.entries()]),
    body: await response.text(),
  });
}

describe("diagnostics child-process crash non-interference", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const servers: RunningTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
    await Promise.allSettled(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps an in-flight response identical when the diagnostics process exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-diagnostics-crash-"));
    roots.push(root);
    const sessions: DiagnosticsWorkerSession[] = [];
    const authority = await createDiagnosticsAuthority({
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
      workerFactory(input) {
        const session = createNodeDiagnosticsProcess(input);
        sessions.push(session);
        return session;
      },
    });
    authorities.push(authority);

    const baseline = await startTokenHttpServer({
      runtime: createTokenRuntime({ clientProtocols: [protocol()] }),
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baseline);

    const entered = deferred();
    const release = deferred();
    const diagnosed = await startTokenHttpServer({
      runtime: createTokenRuntime({
        clientProtocols: [
          protocol({ promise: release.promise, started: entered.resolve }),
        ],
      }),
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(diagnosed);

    const diagnosedResponse = invoke(diagnosed);
    await entered.promise;
    expect(sessions).toHaveLength(1);
    await sessions[0]!.terminate();
    release.resolve();

    await expect(diagnosedResponse).resolves.toEqual(await invoke(baseline));
    expect(authority.diagnosticsAvailable()).toBe(true);
  });

  it("keeps the response identical when persistence stalls and the bounded queue saturates", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-diagnostics-stalled-"));
    roots.push(root);
    const stalled = new StalledDiagnosticsSession();
    const authority = await createDiagnosticsAuthority({
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
      workerFactory: () => stalled,
    });
    authorities.push(authority);

    const baseline = await startTokenHttpServer({
      runtime: createTokenRuntime({ clientProtocols: [protocol()] }),
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    const diagnosed = await startTokenHttpServer({
      runtime: createTokenRuntime({
        clientProtocols: [protocol(undefined, 400)],
      }),
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baseline, diagnosed);

    await expect(invoke(diagnosed)).resolves.toEqual(await invoke(baseline));
    expect(stalled.posted.length).toBeGreaterThan(0);
    stalled.release();
  });
});
