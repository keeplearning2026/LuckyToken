import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { DIAGNOSTICS_WORKER_SOURCE } from "../../src/diagnostics/worker-program.js";

interface WorkerMessage {
  readonly type?: string;
  readonly commandId?: number;
  readonly requestId?: string;
  readonly sequence?: number;
  readonly value?: unknown;
}

describe("Diagnostics Worker abnormal-close invariant", () => {
  it("transactionally replaces a supporting-only primary reference with a degraded fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-worker-failure-invariant-"));
    const runtimeId = "worker-failure-runtime";
    const requestId = "78000000-0000-4000-8000-000000000001";
    const worker = new Worker(DIAGNOSTICS_WORKER_SOURCE, {
      eval: true,
      workerData: {
        directory: root,
        runtimeId,
        artifactRetentionAgeMs: 604_800_000,
        maxArtifactJourneys: 1_000,
        maxArtifactDiskBytes: 5_368_709_120,
        maxJsonArtifactBytes: 64 * 1_024 * 1_024,
        maxJourneyArtifactBytes: 512 * 1_024 * 1_024,
      },
    });
    const received: WorkerMessage[] = [];
    const waiters: Array<{
      readonly predicate: (message: WorkerMessage) => boolean;
      readonly resolve: (message: WorkerMessage) => void;
    }> = [];
    worker.on("message", (raw: unknown) => {
      const message = raw as WorkerMessage;
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index === -1) {
        received.push(message);
        return;
      }
      waiters.splice(index, 1)[0]!.resolve(message);
    });
    const next = (
      predicate: (message: WorkerMessage) => boolean,
    ): Promise<WorkerMessage> => {
      const index = received.findIndex(predicate);
      if (index !== -1) return Promise.resolve(received.splice(index, 1)[0]!);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    };
    const append = async (
      sequence: number,
      messageKind: "begin" | "observation" | "close",
      payload: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      worker.postMessage({
        type: "append",
        runtimeId,
        requestId,
        sequence,
        time: 1_790_000_000_000 + sequence,
        messageKind,
        payload,
      });
      await next(
        (message) =>
          message.type === "ack" &&
          message.requestId === requestId &&
          message.sequence === sequence,
      );
    };

    try {
      await next((message) => message.type === "ready");
      await append(0, "begin", {
        operationCandidate: "model_generation",
        transport: "in_process",
        method: "POST",
        path: "/probe",
        acceptedAt: 1_790_000_000_000,
        cancellation: { caller: "active", shutdown: "not_bound" },
      });
      await append(1, "observation", {
        kind: "failure_detected",
        failureId: "supporting-only",
        role: "supporting",
        classification: "provider_http_429",
        origin: "provider",
        originPrecision: "external_boundary",
        safeMessage: "The provider rate-limited one attempt.",
        location: {
          phase: "upstream_execution",
          lane: "provider_native",
          step: "classify_provider_response",
          attempt: 1,
        },
      });
      await append(2, "close", {
        outcome: "failed",
        completeness: "complete",
        primaryFailureId: "supporting-only",
        lastKnownLocation: {
          phase: "outcome_commit",
          step: "commit_request_outcome",
        },
      });

      worker.postMessage({ type: "get", commandId: 1, requestId });
      const result = await next(
        (message) => message.type === "result" && message.commandId === 1,
      );
      expect(result.value).toMatchObject({
        requestId,
        outcome: "failed",
        completeness: "degraded",
        diagnosis: {
          evidence: "fallback",
          classification: "request_failed_without_specific_cause",
          origin: "unknown",
          originPrecision: "boundary",
          location: {
            phase: "outcome_commit",
            step: "commit_request_outcome",
          },
        },
        incident: {
          primaryFailureId: `${requestId}:request_failed_without_specific_cause`,
        },
      });

      worker.postMessage({ type: "close", commandId: 2 });
      await next(
        (message) =>
          (message.type === "closed" || message.type === "result") &&
          message.commandId === 2,
      );
    } finally {
      await worker.terminate();
      await rm(root, { recursive: true, force: true });
    }
  });
});
