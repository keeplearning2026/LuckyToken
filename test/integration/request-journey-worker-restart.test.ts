import { mkdtemp, rm } from "node:fs/promises";
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

const RUNTIME_ID = "worker-restart-runtime";
const REQUEST_ID = "60000000-0000-4000-8000-000000000001";

interface WorkerEnvelope {
  readonly type?: string;
  readonly runtimeId?: string;
  readonly requestId?: string;
  readonly sequence?: number;
  readonly messageKind?: string;
}

interface AppendIdentity {
  readonly runtimeId: string;
  readonly requestId: string;
  readonly sequence: number;
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
  identity: AppendIdentity | undefined,
  message: WorkerEnvelope,
): boolean {
  return (
    identity !== undefined &&
    identity.runtimeId === message.runtimeId &&
    identity.requestId === message.requestId &&
    identity.sequence === message.sequence
  );
}

function createRestartHarness(): {
  readonly factory: DiagnosticsWorkerFactory;
  readonly waitForFirstBeginAck: () => Promise<void>;
  readonly waitForCommittedUnacknowledgedEvent: () => Promise<void>;
  readonly waitForFirstExit: () => Promise<void>;
  readonly waitForSecondGeneration: () => Promise<void>;
  readonly waitForSecondReady: () => Promise<void>;
  readonly waitForReplayAck: () => Promise<void>;
  readonly waitForCloseAck: () => Promise<void>;
  readonly armCommittedUnacknowledgedExit: () => void;
  readonly generationCount: () => number;
  readonly replayPostCount: () => number;
} {
  const firstBeginAck = deferred();
  const committedUnacknowledgedEvent = deferred();
  const firstExit = deferred();
  const secondGeneration = deferred();
  const secondReady = deferred();
  const replayAck = deferred();
  const closeAck = deferred();
  let generations = 0;
  let armExit = false;
  let firstBegin: AppendIdentity | undefined;
  let committedEvent: AppendIdentity | undefined;
  let terminalClose: AppendIdentity | undefined;
  let replayPosts = 0;

  const factory: DiagnosticsWorkerFactory = (input) => {
    generations += 1;
    const generation = generations;
    if (generation > 2) {
      throw new Error("Restart harness expects exactly two Worker generations");
    }
    const worker = new Worker(input.source, {
      eval: true,
      workerData: input.workerData,
    });
    const messageListeners: Array<(message: unknown) => void> = [];
    const errorListeners: Array<(error: Error) => void> = [];
    const exitListeners: Array<(code: number) => void> = [];
    const dispatchMessage = (message: unknown): void => {
      for (const listener of messageListeners) listener(message);
    };

    if (generation === 2) secondGeneration.resolve();
    worker.on("message", (raw: unknown) => {
      const message = raw as WorkerEnvelope;
      if (
        generation === 1 &&
        message.type === "ack" &&
        armExit &&
        sameAppend(committedEvent, message)
      ) {
        // The real Worker posts ACK only after COMMIT. Withhold that ACK from
        // the authority, then terminate this generation so its pending entry
        // must be replayed under the same runtimeId.
        armExit = false;
        committedUnacknowledgedEvent.resolve();
        void worker.terminate();
        return;
      }

      dispatchMessage(raw);
      if (
        generation === 1 &&
        message.type === "ack" &&
        sameAppend(firstBegin, message)
      ) {
        firstBeginAck.resolve();
      }
      if (generation === 2 && message.type === "ready") {
        secondReady.resolve();
      }
      if (
        generation === 2 &&
        message.type === "ack" &&
        sameAppend(committedEvent, message)
      ) {
        replayAck.resolve();
      }
      if (
        generation === 2 &&
        message.type === "ack" &&
        sameAppend(terminalClose, message)
      ) {
        closeAck.resolve();
      }
    });
    worker.on("error", (error) => {
      for (const listener of errorListeners) listener(error);
    });
    worker.on("exit", (code) => {
      for (const listener of exitListeners) listener(code);
      if (generation === 1) firstExit.resolve();
    });

    const session: DiagnosticsWorkerSession = {
      postMessage(message: object): void {
        const envelope = message as WorkerEnvelope;
        if (
          generation === 1 &&
          envelope.type === "append" &&
          envelope.messageKind === "begin"
        ) {
          firstBegin = appendIdentity(envelope);
        }
        if (
          generation === 1 &&
          envelope.type === "append" &&
          envelope.messageKind === "observation" &&
          armExit
        ) {
          committedEvent = appendIdentity(envelope);
        }
        if (
          generation === 2 &&
          envelope.type === "append" &&
          envelope.messageKind === "observation" &&
          sameAppend(committedEvent, envelope)
        ) {
          replayPosts += 1;
        }
        if (
          generation === 2 &&
          envelope.type === "append" &&
          envelope.messageKind === "close"
        ) {
          terminalClose = appendIdentity(envelope);
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
    waitForFirstBeginAck: () => firstBeginAck.promise,
    waitForCommittedUnacknowledgedEvent: () =>
      committedUnacknowledgedEvent.promise,
    waitForFirstExit: () => firstExit.promise,
    waitForSecondGeneration: () => secondGeneration.promise,
    waitForSecondReady: () => secondReady.promise,
    waitForReplayAck: () => replayAck.promise,
    waitForCloseAck: () => closeAck.promise,
    armCommittedUnacknowledgedExit: () => {
      armExit = true;
    },
    generationCount: () => generations,
    replayPostCount: () => replayPosts,
  };
}

describe("Request Journey same-runtime Worker replay", () => {
  it("replays a committed unacknowledged event exactly once without interrupting the active Journey", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-worker-restart-"));
    const harness = createRestartHarness();
    let now = 1_787_644_800_000;
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
      runtimeId: RUNTIME_ID,
      now: () => now++,
      workerFactory: harness.factory,
    });

    try {
      const observer = authority.begin({
        requestId: REQUEST_ID,
        operationCandidate: "pending",
        transport: "in_process",
        method: "POST",
        path: "/worker-restart",
        acceptedAt: 1_787_644_800_000,
        cancellation: { caller: "active", shutdown: "not_bound" },
      });
      await harness.waitForFirstBeginAck();

      harness.armCommittedUnacknowledgedExit();
      observer.observe({
        kind: "step_entered",
        stepInstanceId: "restart-probe",
        location: {
          phase: "upstream_execution",
          step: "commit_before_worker_exit",
        },
      });
      await harness.waitForCommittedUnacknowledgedEvent();
      await harness.waitForFirstExit();
      await harness.waitForSecondGeneration();
      await harness.waitForSecondReady();
      await harness.waitForReplayAck();

      expect(harness.generationCount()).toBe(2);
      expect(harness.replayPostCount()).toBe(1);
      const active = await authority.getRequestJourney({
        requestId: REQUEST_ID,
      });
      expect(active).toMatchObject({
        runtimeId: RUNTIME_ID,
        requestId: REQUEST_ID,
        outcome: "running",
        completeness: "complete",
      });
      expect(active.closedAt).toBeUndefined();
      expect(active.timeline).toHaveLength(1);
      expect(active.timeline[0]).toMatchObject({
        runtimeId: RUNTIME_ID,
        requestId: REQUEST_ID,
        sequence: 1,
        observation: {
          kind: "step_entered",
          stepInstanceId: "restart-probe",
        },
      });

      observer.close({
        outcome: "success",
        lastKnownLocation: {
          phase: "upstream_execution",
          step: "commit_before_worker_exit",
        },
      });
      await harness.waitForCloseAck();
      const closed = await authority.getRequestJourney({
        requestId: REQUEST_ID,
      });
      expect(closed).toMatchObject({
        runtimeId: RUNTIME_ID,
        requestId: REQUEST_ID,
        outcome: "success",
        completeness: "complete",
      });
      expect(closed.closedAt).toEqual(expect.any(Number));
      expect(closed.timeline).toEqual(active.timeline);
    } finally {
      await authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
