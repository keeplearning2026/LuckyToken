import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  type DiagnosticsWorkerFactory,
  type DiagnosticsWorkerSession,
} from "../../src/diagnostics/authority.js";
import { parseDiagnosticsConfiguration } from "../../src/diagnostics/configuration.js";

const RUNTIME_ID = "worker-nack-runtime";
const REQUEST_ID = "50000000-0000-4000-8000-000000000001";

interface WorkerEnvelope {
  readonly type?: string;
  readonly commandId?: number;
  readonly runtimeId?: string;
  readonly requestId?: string;
  readonly sequence?: number;
  readonly messageKind?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

interface AppendIdentity {
  readonly runtimeId: string;
  readonly requestId: string;
  readonly sequence: number;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function appendIdentity(message: WorkerEnvelope): AppendIdentity | undefined {
  if (
    typeof message.runtimeId !== "string" ||
    typeof message.requestId !== "string" ||
    typeof message.sequence !== "number"
  ) {
    return undefined;
  }
  return {
    runtimeId: message.runtimeId,
    requestId: message.requestId,
    sequence: message.sequence,
  };
}

function sameAppend(
  left: AppendIdentity | undefined,
  right: WorkerEnvelope,
): boolean {
  return (
    left !== undefined &&
    left.runtimeId === right.runtimeId &&
    left.requestId === right.requestId &&
    left.sequence === right.sequence
  );
}

function createNackHarness(): {
  readonly factory: DiagnosticsWorkerFactory;
  readonly waitForBeginAck: () => Promise<void>;
  readonly waitForAppendNack: () => Promise<void>;
  readonly waitForCloseSealAck: () => Promise<void>;
  readonly armObservationFault: () => void;
  readonly closeSealPosts: () => number;
  readonly authorityClosePosts: () => number;
  readonly releasePoisonForCleanup: () => void;
} {
  const beginAck = deferred<void>();
  const appendNack = deferred<void>();
  const closeSealAck = deferred<void>();
  const messageListeners: Array<(message: unknown) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const exitListeners: Array<(code: number) => void> = [];
  let inner: Worker | undefined;
  let begin: AppendIdentity | undefined;
  let poisoned: AppendIdentity | undefined;
  let closeSeal: AppendIdentity | undefined;
  let faultNextObservation = false;
  let closeSealPostCount = 0;
  let authorityClosePostCount = 0;

  const dispatchMessage = (message: unknown): void => {
    for (const listener of messageListeners) listener(message);
  };

  const factory: DiagnosticsWorkerFactory = (input) => {
    if (inner !== undefined) {
      throw new Error("NACK harness expects one Diagnostics Worker generation");
    }
    const worker = new Worker(input.source, {
      eval: true,
      workerData: input.workerData,
    });
    inner = worker;
    worker.on("message", (raw: unknown) => {
      const message = raw as WorkerEnvelope;
      dispatchMessage(raw);
      if (message.type === "ack" && sameAppend(begin, message)) {
        beginAck.resolve();
      }
      if (message.type === "ack" && sameAppend(closeSeal, message)) {
        closeSealAck.resolve();
      }
      if (
        (message.type === "command_error" || message.type === "nack") &&
        message.commandId === undefined &&
        sameAppend(poisoned, message)
      ) {
        appendNack.resolve();
      }
    });
    worker.on("error", (error) => {
      for (const listener of errorListeners) listener(error);
    });
    worker.on("exit", (code) => {
      for (const listener of exitListeners) listener(code);
    });

    const session: DiagnosticsWorkerSession = {
      postMessage(message: object): void {
        const envelope = message as WorkerEnvelope;
        if (envelope.type === "append" && envelope.messageKind === "begin") {
          begin = appendIdentity(envelope);
        }
        if (
          envelope.type === "append" &&
          envelope.messageKind === "observation" &&
          faultNextObservation
        ) {
          faultNextObservation = false;
          poisoned = appendIdentity(envelope);
          worker.postMessage({
            ...envelope,
            // The authority admitted a valid bounded observation. Corrupting
            // only the test Adapter's Worker copy forces the real Worker
            // transaction to roll back and emit its append NACK path.
            payload: { kind: envelope.payload?.kind },
          });
          return;
        }
        if (envelope.type === "append" && envelope.messageKind === "close") {
          closeSealPostCount += 1;
          closeSeal = appendIdentity(envelope);
        } else if (envelope.type === "close") {
          authorityClosePostCount += 1;
        }
        worker.postMessage(message);
      },
      onMessage(listener): void {
        messageListeners.push(listener);
      },
      onError(listener): void {
        errorListeners.push(listener);
      },
      onExit(listener): void {
        exitListeners.push(listener);
      },
      terminate: () => worker.terminate(),
    };
    return Object.freeze(session);
  };

  return {
    factory,
    waitForBeginAck: () => beginAck.promise,
    waitForAppendNack: () => appendNack.promise,
    waitForCloseSealAck: () => closeSealAck.promise,
    armObservationFault: () => {
      faultNextObservation = true;
    },
    closeSealPosts: () => closeSealPostCount,
    authorityClosePosts: () => authorityClosePostCount,
    releasePoisonForCleanup: () => {
      if (poisoned === undefined) return;
      dispatchMessage({ type: "ack", ...poisoned });
    },
  };
}

describe("Request Journey Worker append NACK resilience", () => {
  it("releases a rejected append so its close seal and authority shutdown are not poisoned", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-worker-nack-"));
    const harness = createNackHarness();
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
      runtimeId: RUNTIME_ID,
      workerFactory: harness.factory,
    });
    let closing: Promise<void> | undefined;

    try {
      const observer = authority.begin({
        requestId: REQUEST_ID,
        operationCandidate: "pending",
        transport: "in_process",
        method: "POST",
        path: "/worker-nack",
        acceptedAt: 1_787_558_400_000,
        cancellation: { caller: "active", shutdown: "not_bound" },
      });
      await harness.waitForBeginAck();

      harness.armObservationFault();
      expect(() =>
        observer.observe({
          kind: "step_entered",
          stepInstanceId: "nack-probe",
          location: {
            phase: "http_admission",
            step: "force_real_worker_nack",
          },
        }),
      ).not.toThrow();
      await harness.waitForAppendNack();

      expect(() =>
        observer.close({
          outcome: "failed",
          lastKnownLocation: {
            phase: "http_admission",
            step: "force_real_worker_nack",
          },
        }),
      ).not.toThrow();
      await harness.waitForCloseSealAck();
      expect(harness.closeSealPosts()).toBe(1);

      // close() runs synchronously until its first real wait. Once the NACKed
      // append is released, no pending poison remains, so the Worker close
      // command must cross the factory seam before close() yields.
      closing = authority.close();
      expect(harness.authorityClosePosts()).toBe(1);
      await closing;
    } finally {
      // Current Red retains the NACKed entry. Release only the saved test key
      // so teardown stays deterministic without an elapsed-time assertion.
      harness.releasePoisonForCleanup();
      await (closing ?? authority.close());
      await rm(root, { recursive: true, force: true });
    }
  });
});
