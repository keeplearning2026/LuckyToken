import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  publishRenameFaultArtifact = false,
  publishInvalidJsonArtifact = false,
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
      if (publishRenameFaultArtifact) {
        const artifact = Buffer.from('{"rename":"fault"}');
        context?.journey.observe({
          kind: "artifact_observed",
          artifactId: "rename_fault",
          artifactKind: "rename_fault",
          state: "captured",
          mediaType: "application/json",
          bytes: artifact,
          originalBytes: artifact.byteLength,
          capturedBytes: artifact.byteLength,
          truncated: false,
          location: {
            phase: "upstream_execution",
            step: "publish_rename_fault_artifact",
          },
        });
      }
      if (publishInvalidJsonArtifact) {
        const artifact = Buffer.from('{"invalid":');
        context?.journey.observe({
          kind: "artifact_observed",
          artifactId: "redaction_fault",
          artifactKind: "redaction_fault",
          state: "captured",
          mediaType: "application/json",
          bytes: artifact,
          originalBytes: artifact.byteLength,
          capturedBytes: artifact.byteLength,
          truncated: false,
          location: {
            phase: "upstream_execution",
            step: "publish_redaction_fault_artifact",
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

class ControllableDiagnosticsSession implements DiagnosticsWorkerSession {
  #messageListener: ((message: unknown) => void) | undefined;
  #errorListener: ((error: Error) => void) | undefined;
  #exitListener: ((code: number) => void) | undefined;
  terminated = false;

  postMessage(): boolean {
    return true;
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#messageListener = listener;
    queueMicrotask(() => listener({ type: "ready" }));
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListener = listener;
  }

  onExit(listener: (code: number) => void): void {
    this.#exitListener = listener;
  }

  async terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true;
      queueMicrotask(() => this.#exitListener?.(0));
    }
    return 0;
  }

  emit(message: unknown): void {
    this.#messageListener?.(message);
  }

  emitError(error: Error): void {
    this.#errorListener?.(error);
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
    await vi.waitFor(() => expect(authority.diagnosticsAvailable()).toBe(true));
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

  it("quarantines malformed process output, restarts diagnostics, and keeps the response identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-diagnostics-malformed-"));
    roots.push(root);
    const sessions: ControllableDiagnosticsSession[] = [];
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
      workerFactory: () => {
        const session = new ControllableDiagnosticsSession();
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
    servers.push(baseline, diagnosed);

    const diagnosedResponse = invoke(diagnosed);
    await entered.promise;
    expect(sessions).toHaveLength(1);
    sessions[0]!.emit({ type: "not-a-diagnostics-message" });
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(sessions[0]!.terminated).toBe(true);
    release.resolve();

    await expect(diagnosedResponse).resolves.toEqual(await invoke(baseline));
    await vi.waitFor(() => expect(authority.diagnosticsAvailable()).toBe(true));
  });

  it("contains a diagnostics process error such as OOM and keeps the response identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-diagnostics-oom-"));
    roots.push(root);
    const sessions: ControllableDiagnosticsSession[] = [];
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
      workerFactory: () => {
        const session = new ControllableDiagnosticsSession();
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
    servers.push(baseline, diagnosed);

    const diagnosedResponse = invoke(diagnosed);
    await entered.promise;
    sessions[0]!.emitError(new Error("synthetic diagnostics OOM"));
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(sessions[0]!.terminated).toBe(true);
    release.resolve();

    await expect(diagnosedResponse).resolves.toEqual(await invoke(baseline));
    await vi.waitFor(() => expect(authority.diagnosticsAvailable()).toBe(true));
  });

  it("contains an artifact rename failure and preserves the successful response", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-diagnostics-rename-"));
    roots.push(root);
    const runtimeId = "rename-fault-runtime";
    const artifactId = "rename_fault";
    const opaque = (prefix: string, value: string): string =>
      `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
    const sessions: DiagnosticsWorkerSession[] = [];
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
      runtimeId,
      journeyCapturePolicy: {
        snapshot: () => ({
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
    await authority.queryRequestJourneys({ limit: 1 });
    const blockedFinalPath = join(
      root,
      "diagnostics",
      "full-journeys",
      ".inflight",
      opaque("runtime", runtimeId),
      opaque("request", REQUEST_ID),
      "artifacts",
      `${opaque("artifact", artifactId)}.json`,
    );
    await mkdir(blockedFinalPath, { recursive: true });
    const baseline = await startTokenHttpServer({
      runtime: createTokenRuntime({ clientProtocols: [protocol()] }),
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    const diagnosed = await startTokenHttpServer({
      runtime: createTokenRuntime({
        clientProtocols: [protocol(undefined, 0, true)],
      }),
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baseline, diagnosed);

    await expect(invoke(diagnosed)).resolves.toEqual(await invoke(baseline));
    await vi.waitFor(() => expect(sessions.length).toBeGreaterThan(1));
    await rm(blockedFinalPath, { recursive: true, force: true });
    await expect
      .poll(async () => {
        try {
          return (await authority.getRequestJourney({ requestId: REQUEST_ID }))
            .outcome;
        } catch {
          return undefined;
        }
      })
      .toBe("success");
    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect(detail.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId,
        state: "unavailable",
      }),
    );
  });

  it("contains a redactor rejection and preserves the successful response", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-diagnostics-redactor-"));
    roots.push(root);
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: join(root, "diagnostics") },
        root,
      ),
      journeyCapturePolicy: {
        snapshot: () => ({
          allRequestsEnabled: true,
          failedRequestsEnabled: true,
        }),
      },
    });
    authorities.push(authority);
    const baseline = await startTokenHttpServer({
      runtime: createTokenRuntime({ clientProtocols: [protocol()] }),
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    const diagnosed = await startTokenHttpServer({
      runtime: createTokenRuntime({
        clientProtocols: [protocol(undefined, 0, false, true)],
      }),
      diagnostics: authority,
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(baseline, diagnosed);

    await expect(invoke(diagnosed)).resolves.toEqual(await invoke(baseline));
    const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
    expect(detail.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "redaction_fault",
        state: "unavailable",
        reason: "redaction_invalid_json",
      }),
    );
  });
});
