import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  type DiagnosticsWorkerFactory,
} from "../../src/diagnostics/authority.js";
import { parseDiagnosticsConfiguration } from "../../src/diagnostics/configuration.js";

const RUNTIME_ID = "seal-reserve-runtime";
const REQUEST_ID = "80000000-0000-4000-8000-000000000001";

interface WorkerEnvelope {
  readonly type?: string;
  readonly commandId?: number;
  readonly runtimeId?: string;
  readonly requestId?: string;
  readonly sequence?: number;
  readonly messageKind?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly artifactId?: string;
  readonly chunkIndex?: number;
  readonly bytes?: Uint8Array;
}

interface AppendIdentity {
  readonly runtimeId: string;
  readonly requestId: string;
  readonly sequence: number;
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

function createSaturatedReserveHarness(): {
  readonly factory: DiagnosticsWorkerFactory;
  readonly closeSealPosts: () => number;
  readonly closeSealPayload: () => Readonly<Record<string, unknown>> | undefined;
  readonly artifactPosts: () => readonly WorkerEnvelope[];
  readonly artifactChunks: () => readonly WorkerEnvelope[];
  readonly releaseHeld: () => void;
} {
  let messageListener: ((message: unknown) => void) | undefined;
  const held: AppendIdentity[] = [];
  let closeSealPostCount = 0;
  let sealPayload: Readonly<Record<string, unknown>> | undefined;
  const artifacts: WorkerEnvelope[] = [];
  const artifactChunks: WorkerEnvelope[] = [];

  const acknowledge = (message: WorkerEnvelope): void => {
    const identity = appendIdentity(message);
    if (identity !== undefined) {
      messageListener?.({ type: "ack", ...identity });
    }
  };

  const factory: DiagnosticsWorkerFactory = () =>
    Object.freeze({
      postMessage(message: object): void {
        const envelope = message as WorkerEnvelope;
        if (envelope.type === "append") {
          if (
            envelope.messageKind === "observation" &&
            envelope.payload?.kind === "artifact_observed"
          ) {
            artifacts.push(envelope);
          }
          if (envelope.messageKind === "begin") {
            acknowledge(envelope);
            return;
          }
          if (envelope.messageKind === "close") {
            closeSealPostCount += 1;
            sealPayload = envelope.payload;
            acknowledge(envelope);
            return;
          }
          const identity = appendIdentity(envelope);
          if (identity !== undefined) held.push(identity);
          return;
        }
        if (envelope.type === "artifact_chunk") {
          artifactChunks.push(envelope);
          return;
        }
        if (envelope.type === "close") {
          messageListener?.({ type: "result", commandId: envelope.commandId });
        }
      },
      onMessage(listener: (message: unknown) => void): void {
        messageListener = listener;
        listener({ type: "ready" });
      },
      onError(): void {},
      onExit(): void {},
      async terminate(): Promise<number> {
        return 0;
      },
    });

  return {
    factory,
    closeSealPosts: () => closeSealPostCount,
    closeSealPayload: () => sealPayload,
    artifactPosts: () => artifacts,
    artifactChunks: () => artifactChunks,
    releaseHeld: () => {
      for (const identity of held.splice(0)) {
        messageListener?.({ type: "ack", ...identity });
      }
    },
  };
}

describe("Request Journey close-seal reserve", () => {
  it("admits one bounded close seal even when terminal observations saturate their shared pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-seal-reserve-"));
    const harness = createSaturatedReserveHarness();
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
      runtimeId: RUNTIME_ID,
      workerFactory: harness.factory,
    });

    try {
      const observer = authority.begin({
        requestId: REQUEST_ID,
        operationCandidate: "pending",
        transport: "in_process",
        method: "POST",
        path: "/seal-reserve",
        acceptedAt: 1_787_558_400_000,
        cancellation: { caller: "active", shutdown: "not_bound" },
      });

      const messageSizes = [
        ...Array<number>(80).fill(60 * 1_024),
        ...Array<number>(8).fill(16 * 1_024),
        ...Array<number>(8).fill(4 * 1_024),
        ...Array<number>(16).fill(1 * 1_024),
        ...Array<number>(300).fill(128),
      ];
      for (const [index, messageSize] of messageSizes.entries()) {
        observer.observe({
          kind: "failure_detected",
          failureId: `supporting-${index}`,
          role: "supporting",
          classification: "reserve_saturation_probe",
          origin: "Token",
          originPrecision: "exact",
          safeMessage: "x".repeat(messageSize),
          location: {
            phase: "outcome_commit",
            step: "saturate_terminal_reserve",
          },
        });
      }

      expect(() =>
        observer.close({
          outcome: "failed",
          closeReason: "bounded-close-seal".repeat(256),
          lastKnownLocation: {
            phase: "outcome_commit",
            step: "seal_after_reserve_saturation",
          },
        }),
      ).not.toThrow();

      expect(harness.closeSealPosts()).toBe(1);
      expect(harness.closeSealPayload()).toMatchObject({
        outcome: "failed",
        completeness: "degraded",
      });
    } finally {
      harness.releaseHeld();
      await authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sheds success detail and artifact bodies before failure artifact evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-shedding-order-"));
    const harness = createSaturatedReserveHarness();
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: root },
        root,
      ),
      journeyCapturePolicy: {
        snapshot: () => Object.freeze({
          allRequestsEnabled: true,
          failedRequestsEnabled: true,
        }),
      },
      runtimeId: `${RUNTIME_ID}-shedding`,
      workerFactory: harness.factory,
    });

    try {
      const success = authority.begin({
        requestId: "shedding-success-0000-4000-8000-000000000001",
        operationCandidate: "model_generation",
        transport: "in_process",
        method: "POST",
        path: "/shedding/success",
        acceptedAt: 1_787_558_400_000,
        cancellation: { caller: "active", shutdown: "not_bound" },
      });
      for (let index = 0; index < 150; index += 1) {
        success.observe({
          kind: "step_completed",
          stepInstanceId: `detail-${index}`,
          completion: "success",
          location: {
            phase: "lane_request_preparation",
            step: "successful_detail",
            sourcePath: "x".repeat(60 * 1_024),
          },
        });
      }
      success.observe({
        kind: "artifact_observed",
        artifactId: "success-body",
        artifactKind: "client_response_wire",
        state: "captured",
        mediaType: "application/json",
        redaction: "not_required",
        truncated: false,
        bytes: Buffer.from(JSON.stringify({ body: "s".repeat(240 * 1_024) })),
        location: {
          phase: "client_response_preparation",
          step: "construct_client_envelope",
        },
      });
      success.close({
        outcome: "success",
        lastKnownLocation: {
          phase: "outcome_commit",
          step: "commit_success",
        },
      });

      const failed = authority.begin({
        requestId: "shedding-failure-0000-4000-8000-000000000002",
        operationCandidate: "model_generation",
        transport: "in_process",
        method: "POST",
        path: "/shedding/failure",
        acceptedAt: 1_787_558_400_001,
        cancellation: { caller: "active", shutdown: "not_bound" },
      });
      failed.observe({
        kind: "failure_detected",
        failureId: "primary-failure",
        role: "primary",
        classification: "fixture_failure",
        origin: "Token",
        originPrecision: "exact",
        safeMessage: "fixture failed",
        location: {
          phase: "upstream_execution",
          step: "dispatch_provider_transport",
        },
      });
      failed.observe({
        kind: "artifact_observed",
        artifactId: "failure-body",
        artifactKind: "upstream_response_wire",
        state: "captured",
        mediaType: "application/json",
        redaction: "not_required",
        truncated: false,
        bytes: Buffer.from(JSON.stringify({ body: "f".repeat(240 * 1_024) })),
        location: {
          phase: "upstream_execution",
          step: "read_provider_response",
        },
      });
      failed.close({
        outcome: "failed",
        primaryFailureId: "primary-failure",
        lastKnownLocation: {
          phase: "upstream_execution",
          step: "dispatch_provider_transport",
        },
      });

      const posts = harness.artifactPosts();
      const successPost = posts.find(
        (post) => post.requestId === success.requestId,
      );
      expect(successPost?.payload).toMatchObject({
        artifactId: "success-body",
        state: "unavailable",
        reason: "queue_capacity_exhausted",
      });
      const failurePost = posts.find(
        (post) => post.requestId === failed.requestId,
      );
      expect(failurePost?.payload).toMatchObject({
        artifactId: "failure-body",
        state: "captured",
      });
      expect(
        harness
          .artifactChunks()
          .filter((post) => post.artifactId === "failure-body")
          .map((post) => post.bytes?.byteLength),
      ).toEqual([65_536, 65_536, 65_536, expect.any(Number)]);
    } finally {
      harness.releaseHeld();
      await authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
