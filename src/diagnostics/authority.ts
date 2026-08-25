import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import type {
  AnalyticsQuery,
  AnalyticsQueryResult,
  DiagnosticsSubscription,
  RequestArtifactGetInput,
  RequestArtifactReadResult,
  RequestJourneyGetInput,
  RequestJourneyQuery,
  RequestJourneyQueryResult,
  RequestJourneyRecord,
  RequestJourneySubscriber,
  RequestJourneySummary,
  RuntimeEventQuery,
  RuntimeEventQueryResult,
  RuntimeEventRecord,
  RuntimeEventSubscriber,
} from "@luckytoken/application-control-plane/control-plane";
import { decodeTerminalUsageFact } from "@luckytoken/provider-contract/usage";

import {
  type ArtifactObservedObservation,
  type RequestJourneyBeginInput,
  type RequestJourneyLocation,
  type RequestJourneyObservationInput,
  type RequestJourneyObserver,
  type RequestJourneyOutcome,
  type RuntimeEventObservationInput,
} from "./contract.js";
import type {
  DiagnosticsHistoryCounts,
  DiagnosticsHistoryDeleteResult,
  DiagnosticsHistoryRange,
  DiagnosticsManagementAuthority,
} from "./management-contract.js";
import {
  bindDiagnosticsConfiguration,
  type DiagnosticsConfiguration,
} from "./configuration.js";
import {
  redactRequestArtifact,
  type ArtifactRedactionResult,
} from "./artifact-redaction.js";
import { DIAGNOSTICS_WORKER_SOURCE } from "./worker-program.js";

const MAX_OBSERVATIONS_PER_JOURNEY = 512;
const MAX_OBSERVATION_BYTES = 64 * 1_024;
const MAX_ARTIFACT_CHUNK_BYTES = 256 * 1_024;
const MAX_ORDINARY_PENDING_BYTES = 16 * 1_024 * 1_024;
const SUCCESS_ARTIFACT_PENDING_BYTES = 4 * 1_024 * 1_024;
const STEP_DETAIL_PENDING_BYTES = 8 * 1_024 * 1_024;
const NOTICE_ATTEMPT_PENDING_BYTES = 12 * 1_024 * 1_024;
const FAILURE_ARTIFACT_PENDING_BYTES = 14 * 1_024 * 1_024;
const MAX_RESERVED_PENDING_BYTES = 4 * 1_024 * 1_024;
const CLOSE_SEAL_RESERVATION_BYTES = 4 * 1_024;
const RESTART_BACKOFF_MS = [100, 500, 2_000, 10_000, 30_000] as const;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

interface CreateDiagnosticsAuthorityOptions {
  readonly configuration: DiagnosticsConfiguration;
  readonly runtimeId?: string;
  readonly now?: () => number;
  /** @internal System-boundary seam for real Worker fault injection. */
  readonly workerFactory?: DiagnosticsWorkerFactory;
}

/** @internal Owned by the diagnostics system boundary, never the Data Plane. */
export interface DiagnosticsWorkerSession {
  postMessage(message: object): void;
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number) => void): void;
  terminate(): Promise<number>;
}

/** @internal Owned by createDiagnosticsAuthority and diagnostics tests only. */
export type DiagnosticsWorkerFactory = (input: Readonly<{
  source: string;
  workerData: Readonly<{
    directory: string;
    runtimeId: string;
    artifactRetentionAgeMs: number;
    maxArtifactJourneys: number;
  }>;
}>) => DiagnosticsWorkerSession;

const createNodeDiagnosticsWorker: DiagnosticsWorkerFactory = (input) => {
  const worker = new Worker(input.source, {
    eval: true,
    workerData: input.workerData,
  });
  return Object.freeze({
    postMessage(message: object): void {
      worker.postMessage(message);
    },
    onMessage(listener: (message: unknown) => void): void {
      worker.on("message", listener);
    },
    onError(listener: (error: Error) => void): void {
      worker.on("error", listener);
    },
    onExit(listener: (code: number) => void): void {
      worker.on("exit", listener);
    },
    terminate: () => worker.terminate(),
  });
};

interface RequestJourneyAppendMessage {
  readonly type: "append";
  readonly runtimeId: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly time: number;
  readonly messageKind: "begin" | "observation" | "close";
  readonly payload: object;
  readonly artifactBody?: Uint8Array;
}

interface RuntimeEventAppendMessage {
  readonly type: "append";
  readonly runtimeId: string;
  readonly recordId: string;
  readonly sequence: number;
  readonly time: number;
  readonly messageKind: "runtime_event";
  readonly payload: RuntimeEventObservationInput;
}

type AppendMessage = RequestJourneyAppendMessage | RuntimeEventAppendMessage;

interface ArtifactFlight {
  readonly sequence: number;
  readonly time: number;
  descriptor: Omit<ArtifactObservedObservation, "bytes">;
  readonly chunks: Uint8Array[];
  capturedBytes: number;
}

interface JourneyState {
  sequence: number;
  observations: number;
  closed: boolean;
  degraded: boolean;
  artifactBytes: number;
  closeSealReservationBytes: number;
  primaryFailureId?: string;
  finalOutcome?: RequestJourneyOutcome;
  readonly artifacts: Map<string, ArtifactFlight>;
}

type PendingCapacity = "ordinary" | "reserved" | "close_seal";

interface PendingAppend {
  readonly message: AppendMessage;
  readonly bytes: number;
  readonly capacity: PendingCapacity;
}

interface CommandWaiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export class DiagnosticsUnavailableError extends Error {
  readonly code = "diagnostics_unavailable" as const;
  readonly classification = "diagnostics_storage_unavailable" as const;

  constructor() {
    super("Diagnostics storage is unavailable");
    this.name = "DiagnosticsUnavailableError";
  }
}

function appendKey(message: AppendMessage): string {
  return message.messageKind === "runtime_event"
    ? `runtime_event\u0000${message.runtimeId}\u0000${message.recordId}\u0000${message.sequence}`
    : `request_journey\u0000${message.runtimeId}\u0000${message.requestId}\u0000${message.sequence}`;
}

function acknowledgementKey(message: Readonly<{
  runtimeId?: string;
  requestId?: string;
  recordId?: string;
  sequence?: number;
}>): string | undefined {
  if (
    typeof message.runtimeId !== "string" ||
    !Number.isSafeInteger(message.sequence)
  ) {
    return undefined;
  }
  if (typeof message.recordId === "string") {
    return `runtime_event\u0000${message.runtimeId}\u0000${message.recordId}\u0000${message.sequence}`;
  }
  if (typeof message.requestId === "string") {
    return `request_journey\u0000${message.runtimeId}\u0000${message.requestId}\u0000${message.sequence}`;
  }
  return undefined;
}

function safeByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function messageByteLength(message: AppendMessage): number | undefined {
  const metadataBytes = safeByteLength({
    ...message,
    artifactBody: undefined,
  });
  if (metadataBytes === undefined) return undefined;
  return (
    metadataBytes +
    ("artifactBody" in message ? (message.artifactBody?.byteLength ?? 0) : 0)
  );
}

function boundedUtf8(
  value: unknown,
  maximumBytes: number,
): Readonly<{ value?: string; degraded: boolean }> {
  if (typeof value !== "string") {
    return Object.freeze({ degraded: value !== undefined });
  }
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return Object.freeze({ value, degraded: false });
  }
  let bytes = 0;
  let output = "";
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maximumBytes) break;
    output += codePoint;
    bytes += codePointBytes;
  }
  return Object.freeze({ value: output, degraded: true });
}

const CLOSE_OUTCOMES = new Set<RequestJourneyOutcome>([
  "success",
  "failed",
  "aborted",
  "interrupted",
]);
const CLOSE_PHASES = new Set<RequestJourneyLocation["phase"]>([
  "http_admission",
  "protocol_ingress",
  "request_resolution",
  "lane_request_preparation",
  "upstream_execution",
  "lane_response_processing",
  "client_response_preparation",
  "outcome_commit",
  "http_handoff",
]);
const CLOSE_LANES = new Set<NonNullable<RequestJourneyLocation["lane"]>>([
  "direct",
  "provider_native",
  "semantic_conversion",
]);
const CLOSE_DIRECTIONS = new Set<
  NonNullable<RequestJourneyLocation["direction"]>
>(["client_to_pi", "pi_to_provider", "provider_to_pi", "pi_to_client"]);
const CLOSE_SUBJECTS = new Set<
  NonNullable<RequestJourneyLocation["subject"]>
>([
  "envelope",
  "system",
  "message",
  "content",
  "tool",
  "tool_call",
  "tool_result",
  "reasoning",
  "metadata",
  "usage",
  "stop_reason",
]);

function projectCloseLocation(
  value: unknown,
): Readonly<{ location?: RequestJourneyLocation; degraded: boolean }> {
  if (value === undefined) return Object.freeze({ degraded: false });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({ degraded: true });
  }
  try {
    const input = value as Record<string, unknown>;
    if (!CLOSE_PHASES.has(input.phase as RequestJourneyLocation["phase"])) {
      return Object.freeze({ degraded: true });
    }
    const step = boundedUtf8(input.step, 256);
    if (step.value === undefined || step.value.length === 0) {
      return Object.freeze({ degraded: true });
    }
    let degraded = step.degraded;
    const lane = input.lane;
    const direction = input.direction;
    const subject = input.subject;
    const sourcePath = boundedUtf8(input.sourcePath, 512);
    const attempt = input.attempt;
    if (lane !== undefined && !CLOSE_LANES.has(lane as never)) degraded = true;
    if (
      direction !== undefined &&
      !CLOSE_DIRECTIONS.has(direction as never)
    ) {
      degraded = true;
    }
    if (subject !== undefined && !CLOSE_SUBJECTS.has(subject as never)) {
      degraded = true;
    }
    if (
      attempt !== undefined &&
      (!Number.isSafeInteger(attempt) || (attempt as number) < 0)
    ) {
      degraded = true;
    }
    degraded ||= sourcePath.degraded;
    return Object.freeze({
      location: Object.freeze({
        phase: input.phase as RequestJourneyLocation["phase"],
        step: step.value,
        ...(CLOSE_LANES.has(lane as never)
          ? { lane: lane as NonNullable<RequestJourneyLocation["lane"]> }
          : {}),
        ...(CLOSE_DIRECTIONS.has(direction as never)
          ? {
              direction: direction as NonNullable<
                RequestJourneyLocation["direction"]
              >,
            }
          : {}),
        ...(CLOSE_SUBJECTS.has(subject as never)
          ? {
              subject: subject as NonNullable<
                RequestJourneyLocation["subject"]
              >,
            }
          : {}),
        ...(sourcePath.value === undefined
          ? {}
          : { sourcePath: sourcePath.value }),
        ...(Number.isSafeInteger(attempt) && (attempt as number) >= 0
          ? { attempt: attempt as number }
          : {}),
      }),
      degraded,
    });
  } catch {
    return Object.freeze({ degraded: true });
  }
}

function projectCloseSeal(
  input: unknown,
  state: JourneyState,
): Readonly<Record<string, unknown> & { outcome: RequestJourneyOutcome }> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("invalid close input");
    }
    const value = input as Record<string, unknown>;
    const outcome = CLOSE_OUTCOMES.has(value.outcome as RequestJourneyOutcome)
      ? (value.outcome as RequestJourneyOutcome)
      : "interrupted";
    let degraded =
      state.degraded ||
      outcome !== value.outcome ||
      (value.completeness !== undefined && value.completeness !== "complete");
    const closeReason = boundedUtf8(value.closeReason, 512);
    const failureId = boundedUtf8(
      value.primaryFailureId ?? state.primaryFailureId,
      256,
    );
    const location = projectCloseLocation(value.lastKnownLocation);
    degraded ||=
      closeReason.degraded || failureId.degraded || location.degraded;
    return Object.freeze({
      outcome,
      ...(failureId.value === undefined
        ? {}
        : { primaryFailureId: failureId.value }),
      ...(closeReason.value === undefined
        ? {}
        : { closeReason: closeReason.value }),
      ...(location.location === undefined
        ? {}
        : { lastKnownLocation: location.location }),
      completeness: degraded ? "degraded" : "complete",
    });
  } catch {
    return Object.freeze({
      outcome: "interrupted",
      closeReason: "invalid_close_input",
      completeness: "degraded",
    });
  }
}

function copyObservation(
  input: RequestJourneyObservationInput,
): RequestJourneyObservationInput | undefined {
  try {
    if (input.kind === "artifact_observed") return undefined;
    const candidate = input as unknown as Record<string, unknown>;
    let copied: RequestJourneyObservationInput;
    if (input.kind === "terminal_usage_observed") {
      const usage = decodeTerminalUsageFact(candidate.usage);
      if (usage === undefined) return undefined;
      copied = structuredClone({ ...input, usage }) as RequestJourneyObservationInput;
    } else {
      copied = structuredClone(input) as RequestJourneyObservationInput;
    }
    if (
      copied.kind === "model_resolved" &&
      (!isBoundedFact(copied.requestedModel, 1_024) ||
        !isBoundedFact(copied.providerId, 256) ||
        !isBoundedFact(copied.modelId, 256))
    ) {
      return undefined;
    }
    if (
      copied.kind === "request_identity_established" &&
      (!isBoundedFact(copied.effectiveSessionId, 1_024) ||
        (copied.clientSessionId !== undefined &&
          !isBoundedFact(copied.clientSessionId, 1_024)))
    ) {
      return undefined;
    }
    if (
      copied.kind === "profile_attributed" &&
      (!isBoundedFact(copied.profileId, 256) ||
        !isBoundedFact(copied.displayName, 512))
    ) {
      return undefined;
    }
    if (
      copied.kind === "work_outcome_committed" &&
      copied.requestOutcome !== undefined &&
      !REQUEST_ANALYTICS_OUTCOMES.has(copied.requestOutcome)
    ) {
      return undefined;
    }
    const length = safeByteLength(copied);
    if (length === undefined || length > MAX_OBSERVATION_BYTES) return undefined;
    return copied;
  } catch {
    return undefined;
  }
}

function isBoundedFact(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

const REQUEST_ANALYTICS_OUTCOMES = new Set([
  "success",
  "failed",
  "aborted",
  "rejected-auth",
  "unknown-alias",
  "unavailable-alias",
] as const);

const RUNTIME_EVENT_LEVELS = new Set<RuntimeEventObservationInput["level"]>([
  "info",
  "warning",
  "error",
  "critical",
]);

function copyRuntimeEvent(
  input: RuntimeEventObservationInput,
): RuntimeEventObservationInput | undefined {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return undefined;
    }
    const candidate = input as unknown as Record<string, unknown>;
    if (
      !RUNTIME_EVENT_LEVELS.has(
        candidate.level as RuntimeEventObservationInput["level"],
      ) ||
      typeof candidate.classification !== "string" ||
      candidate.classification.length === 0 ||
      typeof candidate.safeMessage !== "string" ||
      candidate.safeMessage.length === 0
    ) {
      return undefined;
    }
    const copied = Object.freeze({
      level: candidate.level as RuntimeEventObservationInput["level"],
      classification: candidate.classification,
      safeMessage: candidate.safeMessage,
    });
    const length = safeByteLength(copied);
    if (length === undefined || length > MAX_OBSERVATION_BYTES) return undefined;
    return copied;
  } catch {
    return undefined;
  }
}

function isReservedMessage(message: AppendMessage): boolean {
  if (message.messageKind === "runtime_event") return false;
  if (message.messageKind === "close") return true;
  if (message.messageKind !== "observation") return false;
  const kind = (message.payload as RequestJourneyObservationInput).kind;
  return (
    kind === "failure_detected" ||
    kind === "terminal_usage_observed" ||
    kind === "work_outcome_committed" ||
    kind === "client_response_prepared" ||
    kind === "handoff_observed"
  );
}

function ordinaryAdmissionLimit(
  message: AppendMessage,
  state: JourneyState | undefined,
): number {
  if (
    message.messageKind === "observation" &&
    (message.payload as RequestJourneyObservationInput).kind ===
      "artifact_observed"
  ) {
    if (message.artifactBody === undefined) {
      return MAX_ORDINARY_PENDING_BYTES;
    }
    return state?.finalOutcome === "success"
      ? SUCCESS_ARTIFACT_PENDING_BYTES
      : FAILURE_ARTIFACT_PENDING_BYTES;
  }
  if (message.messageKind !== "observation") {
    return MAX_ORDINARY_PENDING_BYTES;
  }
  const kind = (message.payload as RequestJourneyObservationInput).kind;
  if (kind === "step_entered" || kind === "step_completed") {
    return STEP_DETAIL_PENDING_BYTES;
  }
  if (kind === "conversion_notice_observed" || kind === "attempt_observed") {
    return NOTICE_ATTEMPT_PENDING_BYTES;
  }
  return MAX_ORDINARY_PENDING_BYTES;
}

function combineArtifactChunks(
  chunks: readonly Uint8Array[],
  byteLength: number,
): Uint8Array | undefined {
  if (byteLength === 0) return undefined;
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export async function createDiagnosticsAuthority(
  options: CreateDiagnosticsAuthorityOptions,
): Promise<DiagnosticsManagementAuthority> {
  const configuration = bindDiagnosticsConfiguration(options.configuration);
  const runtimeId = options.runtimeId ?? randomUUID();
  const now = options.now ?? Date.now;
  const workerFactory = options.workerFactory ?? createNodeDiagnosticsWorker;
  const pending = new Map<string, PendingAppend>();
  const journeys = new Map<string, JourneyState>();
  const commands = new Map<number, CommandWaiter>();
  const requestJourneySubscribers = new Set<RequestJourneySubscriber>();
  const runtimeEventSubscribers = new Set<RuntimeEventSubscriber>();
  let ordinaryPendingBytes = 0;
  let reservedPendingBytes = 0;
  let closeSealReservedBytes = 0;
  let worker: DiagnosticsWorkerSession | undefined;
  let ready = false;
  let closed = false;
  let permanentlyUnavailable = false;
  let nextCommandId = 0;
  let nextRuntimeEventSequence = 0;
  let restartIndex = 0;
  let flightArtifactBytes = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let readyResolve: (() => void) | undefined;
  let readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const subscribe = <Listener>(
    listeners: Set<Listener>,
    listener: Listener,
  ): DiagnosticsSubscription => {
    if (typeof listener !== "function") {
      return Object.freeze({ unsubscribe: () => undefined });
    }
    listeners.add(listener);
    let subscribed = true;
    return Object.freeze({
      unsubscribe(): void {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      },
    });
  };

  const publish = <Record, Listener extends (record: Record) => unknown>(
    listeners: Set<Listener>,
    record: Record,
  ): void => {
    queueMicrotask(() => {
      const delivery = [...listeners];
      for (const listener of delivery) {
        if (!listeners.has(listener)) continue;
        try {
          Promise.resolve(listener(record)).catch(() => undefined);
        } catch {
          // Subscriber code is outside diagnostics authority and cannot
          // affect other subscribers, persistence, or observed work.
        }
      }
    });
  };

  const clearSubscribers = (): void => {
    requestJourneySubscribers.clear();
    runtimeEventSubscribers.clear();
  };

  const releaseJourneyFlight = (state: JourneyState): void => {
    flightArtifactBytes = Math.max(0, flightArtifactBytes - state.artifactBytes);
    state.artifactBytes = 0;
    state.artifacts.clear();
  };

  const releaseJourneyCloseSeal = (state: JourneyState): void => {
    if (state.closeSealReservationBytes === 0) return;
    closeSealReservedBytes = Math.max(
      0,
      closeSealReservedBytes - state.closeSealReservationBytes,
    );
    state.closeSealReservationBytes = 0;
  };

  const clearPendingCapacity = (): void => {
    pending.clear();
    ordinaryPendingBytes = 0;
    reservedPendingBytes = 0;
    closeSealReservedBytes = 0;
  };

  const becomePermanentlyUnavailable = (): void => {
    if (permanentlyUnavailable) return;
    permanentlyUnavailable = true;
    ready = false;
    for (const state of journeys.values()) {
      state.closed = true;
      state.degraded = true;
      releaseJourneyFlight(state);
      releaseJourneyCloseSeal(state);
    }
    journeys.clear();
    clearPendingCapacity();
    rejectCommands(new DiagnosticsUnavailableError());
    readyResolve?.();
  };

  const postPending = (): void => {
    if (!ready || worker === undefined) return;
    for (const entry of pending.values()) worker.postMessage(entry.message);
  };

  const rejectCommands = (reason: unknown): void => {
    for (const waiter of commands.values()) waiter.reject(reason);
    commands.clear();
  };

  const startWorker = (): void => {
    if (closed) return;
    ready = false;
    let next: DiagnosticsWorkerSession;
    try {
      next = workerFactory({
        source: DIAGNOSTICS_WORKER_SOURCE,
        workerData: {
          directory: configuration.directory,
          runtimeId,
          artifactRetentionAgeMs: configuration.artifactRetentionAgeMs,
          maxArtifactJourneys: configuration.maxArtifactJourneys,
        },
      });
    } catch {
      becomePermanentlyUnavailable();
      return;
    }
    worker = next;
    next.onMessage((raw: unknown) => {
      const message = raw as {
        readonly type: string;
        readonly commandId?: number;
        readonly runtimeId?: string;
        readonly requestId?: string;
        readonly recordId?: string;
        readonly sequence?: number;
        readonly value?: unknown;
        readonly message?: string;
        readonly classification?: string;
        readonly publication?:
          | Readonly<{
              kind: "request_journey";
              record: RequestJourneySummary;
            }>
          | Readonly<{
              kind: "runtime_event";
              record: RuntimeEventRecord;
            }>;
      };
      if (message.type === "startup_failure") {
        becomePermanentlyUnavailable();
        return;
      }
      if (message.type === "ready") {
        ready = true;
        readyResolve?.();
        postPending();
        return;
      }
      if (message.type === "ack" || message.type === "nack") {
        const key = acknowledgementKey(message);
        if (key === undefined) return;
        const entry = pending.get(key);
        if (entry !== undefined) {
          pending.delete(key);
          if (entry.capacity === "ordinary") {
            ordinaryPendingBytes = Math.max(
              0,
              ordinaryPendingBytes - entry.bytes,
            );
          } else if (entry.capacity === "reserved") {
            reservedPendingBytes = Math.max(
              0,
              reservedPendingBytes - entry.bytes,
            );
          } else {
            closeSealReservedBytes = Math.max(
              0,
              closeSealReservedBytes - CLOSE_SEAL_RESERVATION_BYTES,
            );
          }
          if (message.type === "ack") {
            restartIndex = 0;
            if (
              entry.message.messageKind === "close" &&
              message.publication?.kind === "request_journey"
            ) {
              publish(requestJourneySubscribers, message.publication.record);
            } else if (
              entry.message.messageKind === "runtime_event" &&
              message.publication?.kind === "runtime_event"
            ) {
              publish(runtimeEventSubscribers, message.publication.record);
            }
          } else if (entry.message.messageKind !== "runtime_event") {
            const state = journeys.get(entry.message.requestId);
            if (state !== undefined) state.degraded = true;
          }
        }
        return;
      }
      if (message.commandId !== undefined) {
        const waiter = commands.get(message.commandId);
        if (waiter === undefined) return;
        commands.delete(message.commandId);
        if (message.type === "command_error") {
          waiter.reject(new Error(message.message ?? "Diagnostics Worker command failed"));
        } else {
          waiter.resolve(message.value);
        }
      }
    });
    next.onError(() => {
      if (!ready) readyResolve?.();
    });
    next.onExit((code) => {
      if (worker === next) worker = undefined;
      ready = false;
      if (closed) return;
      if (permanentlyUnavailable) return;
      rejectCommands(new Error(`Diagnostics Worker exited (${code})`));
      const delay = RESTART_BACKOFF_MS[Math.min(restartIndex, RESTART_BACKOFF_MS.length - 1)]!;
      restartIndex += 1;
      readyPromise = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      restartTimer = setTimeout(startWorker, delay);
      restartTimer.unref();
    });
  };

  const admit = (message: AppendMessage, state?: JourneyState): boolean => {
    const bytes = messageByteLength(message);
    if (bytes === undefined) {
      if (state !== undefined) state.degraded = true;
      return false;
    }
    if (message.messageKind === "close") {
      if (state !== undefined) state.degraded = true;
      return false;
    }
    const reserved = isReservedMessage(message);
    if (
      (reserved &&
        reservedPendingBytes + closeSealReservedBytes + bytes >
          MAX_RESERVED_PENDING_BYTES) ||
      (!reserved &&
        ordinaryPendingBytes + bytes > ordinaryAdmissionLimit(message, state))
    ) {
      if (state !== undefined) state.degraded = true;
      return false;
    }
    const key = appendKey(message);
    if (pending.has(key)) {
      if (state !== undefined) state.degraded = true;
      return false;
    }
    pending.set(key, {
      message,
      bytes,
      capacity: reserved ? "reserved" : "ordinary",
    });
    if (reserved) reservedPendingBytes += bytes;
    else ordinaryPendingBytes += bytes;
    if (ready && worker !== undefined) worker.postMessage(message);
    return true;
  };

  const reserveCloseSeal = (state: JourneyState): boolean => {
    if (
      reservedPendingBytes +
        closeSealReservedBytes +
        CLOSE_SEAL_RESERVATION_BYTES >
      MAX_RESERVED_PENDING_BYTES
    ) {
      return false;
    }
    state.closeSealReservationBytes = CLOSE_SEAL_RESERVATION_BYTES;
    closeSealReservedBytes += CLOSE_SEAL_RESERVATION_BYTES;
    return true;
  };

  const admitCloseSeal = (
    message: RequestJourneyAppendMessage,
    state: JourneyState,
  ): boolean => {
    if (
      message.messageKind !== "close" ||
      state.closeSealReservationBytes !== CLOSE_SEAL_RESERVATION_BYTES
    ) {
      state.degraded = true;
      return false;
    }
    const bytes = messageByteLength(message);
    const key = appendKey(message);
    if (
      bytes === undefined ||
      bytes > CLOSE_SEAL_RESERVATION_BYTES ||
      pending.has(key)
    ) {
      state.degraded = true;
      return false;
    }
    pending.set(key, { message, bytes, capacity: "close_seal" });
    state.closeSealReservationBytes = 0;
    if (ready && worker !== undefined) worker.postMessage(message);
    return true;
  };

  const noOpObserver = (requestId: string): RequestJourneyObserver =>
    Object.freeze({
      requestId,
      observe: () => undefined,
      close: () => undefined,
    });

  const begin = (input: RequestJourneyBeginInput): RequestJourneyObserver => {
    let suppliedRequestId = "unavailable";
    let openingState: JourneyState | undefined;
    try {
      if (typeof input === "object" && input !== null) {
        const candidate = (input as { readonly requestId?: unknown }).requestId;
        if (typeof candidate === "string") suppliedRequestId = candidate;
      }
      if (
        closed ||
        permanentlyUnavailable ||
        !SAFE_REQUEST_ID.test(suppliedRequestId) ||
        journeys.has(suppliedRequestId)
      ) {
        return noOpObserver(suppliedRequestId);
      }
      const copied = structuredClone(input) as RequestJourneyBeginInput;
      const state: JourneyState = {
        sequence: 0,
        observations: 0,
        closed: false,
        degraded: false,
        artifactBytes: 0,
        closeSealReservationBytes: 0,
        artifacts: new Map(),
      };
      openingState = state;
      if (!reserveCloseSeal(state)) {
        return noOpObserver(copied.requestId);
      }
      journeys.set(copied.requestId, state);
      const beginMessage: AppendMessage = {
        type: "append",
        runtimeId,
        requestId: copied.requestId,
        sequence: state.sequence,
        time: copied.acceptedAt,
        messageKind: "begin",
        payload: copied,
      };
      if (!admit(beginMessage, state)) {
        journeys.delete(copied.requestId);
        releaseJourneyCloseSeal(state);
        return noOpObserver(copied.requestId);
      }

      const observer: RequestJourneyObserver = {
        requestId: copied.requestId,
        observe(observation): void {
          try {
            if (closed || permanentlyUnavailable || state.closed) return;
            state.sequence += 1;
            if (state.observations >= MAX_OBSERVATIONS_PER_JOURNEY) {
              state.degraded = true;
              return;
            }
            if (observation.kind === "artifact_observed") {
              const suppliedDescriptor = structuredClone({
                ...observation,
                bytes: undefined,
              }) as Omit<ArtifactObservedObservation, "bytes">;
              const descriptor = Object.freeze({
                ...suppliedDescriptor,
                // Producer redaction claims are not authoritative. Only the
                // diagnostics-owned redactor may set this persisted fact.
                redaction: "not_required",
              }) satisfies Omit<ArtifactObservedObservation, "bytes">;
              const descriptorBytes = safeByteLength(descriptor);
              if (
                descriptorBytes === undefined ||
                descriptorBytes > MAX_OBSERVATION_BYTES
              ) {
                state.degraded = true;
                return;
              }
              const existing = state.artifacts.get(descriptor.artifactId);
              if (existing !== undefined) {
                flightArtifactBytes -= existing.capturedBytes;
                state.artifactBytes -= existing.capturedBytes;
                existing.chunks.length = 0;
                existing.capturedBytes = 0;
                existing.descriptor = Object.freeze({
                  ...descriptor,
                  state: "unavailable",
                  redaction: "failed",
                  capturedBytes: 0,
                  reason:
                    existing.descriptor.artifactKind === descriptor.artifactKind
                      ? "redaction_multiple_chunks_unsupported"
                      : "artifact_kind_changed",
                });
                state.degraded = true;
                state.observations += 1;
                return;
              }
              const flight: ArtifactFlight = {
                sequence: state.sequence,
                time: now(),
                descriptor,
                chunks: [],
                capturedBytes: 0,
              };
              state.artifacts.set(descriptor.artifactId, flight);
              const source = observation.bytes;
              if (source === undefined) {
                if (
                  descriptor.state === "captured" ||
                  descriptor.state === "partial"
                ) {
                  flight.descriptor = Object.freeze({
                    ...descriptor,
                    state: "unavailable",
                    redaction: "failed",
                    capturedBytes: 0,
                    reason: "artifact_body_missing",
                  });
                  state.degraded = true;
                }
                state.observations += 1;
                return;
              }
              const accepted = Math.min(
                source.byteLength,
                MAX_ARTIFACT_CHUNK_BYTES,
                Math.max(
                  0,
                  configuration.maxJourneyArtifactBytes - state.artifactBytes,
                ),
                Math.max(0, 64 * 1_024 * 1_024 - flightArtifactBytes),
              );
              const ownedSource = new Uint8Array(accepted);
              if (accepted > 0) ownedSource.set(source.subarray(0, accepted));
              const originalBytes =
                descriptor.originalBytes ?? source.byteLength;
              let redaction: ArtifactRedactionResult;
              try {
                redaction = redactRequestArtifact({
                  artifactKind: descriptor.artifactKind,
                  ...(descriptor.mediaType === undefined
                    ? {}
                    : { mediaType: descriptor.mediaType }),
                  bytes: ownedSource,
                  originalBytes,
                  sourceTruncated:
                    descriptor.truncated === true ||
                    accepted < source.byteLength ||
                    accepted < originalBytes,
                });
              } catch {
                redaction = Object.freeze({
                  kind: "unavailable",
                  redaction: "failed",
                  reason: "redaction_failed",
                });
              }
              if (redaction.kind === "unavailable") {
                flight.descriptor = Object.freeze({
                  ...descriptor,
                  state: "unavailable",
                  redaction: redaction.redaction,
                  originalBytes,
                  capturedBytes: 0,
                  truncated: descriptor.truncated === true,
                  reason: redaction.reason,
                });
                if (redaction.redaction === "failed") state.degraded = true;
                state.observations += 1;
                return;
              }
              flight.descriptor = Object.freeze({
                ...descriptor,
                redaction: redaction.redaction,
                originalBytes,
                capturedBytes: redaction.bytes.byteLength,
                truncated: redaction.truncated,
              });
              flight.chunks.push(redaction.bytes);
              flight.capturedBytes = redaction.bytes.byteLength;
              state.artifactBytes += redaction.bytes.byteLength;
              flightArtifactBytes += redaction.bytes.byteLength;
              state.observations += 1;
              return;
            }
            const snapshot = copyObservation(observation);
            if (snapshot === undefined) {
              state.degraded = true;
              return;
            }
            state.observations += 1;
            const admitted = admit(
              {
                type: "append",
                runtimeId,
                requestId: copied.requestId,
                sequence: state.sequence,
                time: now(),
                messageKind: "observation",
                payload: snapshot,
              },
              state,
            );
            if (
              admitted &&
              snapshot.kind === "failure_detected" &&
              snapshot.role === "primary"
            ) {
              if (state.primaryFailureId === undefined) {
                state.primaryFailureId = snapshot.failureId;
              } else {
                state.degraded = true;
              }
            }
          } catch {
            state.degraded = true;
          }
        },
        close(closeInput): void {
          let closeSequence: number | undefined;
          let sealAdmitted = false;
          try {
            if (closed || permanentlyUnavailable || state.closed) return;
            state.closed = true;
            let closePayload = projectCloseSeal(closeInput, state);
            state.finalOutcome = closePayload.outcome;
            const successfulArtifactsDisabled =
              closePayload.outcome === "success" &&
              !configuration.successArtifacts.enabled;
            for (const flight of state.artifacts.values()) {
              const originalBytes =
                flight.descriptor.originalBytes ?? flight.capturedBytes;
              const unavailable =
                flight.descriptor.state === "unavailable" ||
                flight.descriptor.state === "not_applicable";
              const truncated = flight.descriptor.truncated === true;
              const descriptor = Object.freeze({
                ...flight.descriptor,
                state: successfulArtifactsDisabled
                  ? "unavailable"
                  : unavailable
                    ? flight.descriptor.state
                    : truncated
                    ? "partial"
                    : flight.descriptor.state,
                capturedBytes: flight.capturedBytes,
                originalBytes,
                redaction: flight.descriptor.redaction ?? "not_required",
                truncated,
                ...(successfulArtifactsDisabled
                  ? { reason: "success_artifacts_disabled" }
                  : {}),
              }) satisfies Omit<ArtifactObservedObservation, "bytes">;
              const artifactBody = successfulArtifactsDisabled
                ? undefined
                : combineArtifactChunks(
                    flight.chunks,
                    flight.capturedBytes,
                  );
              const message: AppendMessage = {
                type: "append",
                runtimeId,
                requestId: copied.requestId,
                sequence: flight.sequence,
                time: flight.time,
                messageKind: "observation",
                payload: descriptor,
                ...(artifactBody === undefined ? {} : { artifactBody }),
              };
              if (!admit(message, state)) {
                admit(
                  {
                    type: message.type,
                    runtimeId: message.runtimeId,
                    requestId: message.requestId,
                    sequence: message.sequence,
                    time: message.time,
                    messageKind: message.messageKind,
                    payload: Object.freeze({
                      ...descriptor,
                      state: "unavailable",
                      reason: "queue_capacity_exhausted",
                    }),
                  },
                  state,
                );
              }
              flightArtifactBytes = Math.max(
                0,
                flightArtifactBytes - flight.capturedBytes,
              );
              state.artifactBytes -= flight.capturedBytes;
            }
            state.artifacts.clear();
            state.artifactBytes = 0;
            state.sequence += 1;
            closeSequence = state.sequence;
            if (state.degraded && closePayload.completeness !== "degraded") {
              closePayload = Object.freeze({
                ...closePayload,
                completeness: "degraded",
              });
            }
            const closeMessage: AppendMessage = {
              type: "append",
              runtimeId,
              requestId: copied.requestId,
              sequence: state.sequence,
              time: now(),
              messageKind: "close",
              payload: closePayload,
            };
            sealAdmitted = admitCloseSeal(closeMessage, state);
            if (!sealAdmitted) {
              sealAdmitted = admitCloseSeal(
                {
                  ...closeMessage,
                  payload: Object.freeze({
                    outcome: "interrupted",
                    closeReason: "close_seal_projection_failed",
                    completeness: "degraded",
                  }),
                },
                state,
              );
            }
          } catch {
            state.degraded = true;
            if (
              !sealAdmitted &&
              state.closeSealReservationBytes ===
                CLOSE_SEAL_RESERVATION_BYTES
            ) {
              if (closeSequence === undefined) {
                state.sequence += 1;
                closeSequence = state.sequence;
              }
              admitCloseSeal(
                {
                  type: "append",
                  runtimeId,
                  requestId: copied.requestId,
                  sequence: closeSequence,
                  time: now(),
                  messageKind: "close",
                  payload: Object.freeze({
                    outcome: "interrupted",
                    closeReason: "close_seal_projection_failed",
                    completeness: "degraded",
                  }),
                },
                state,
              );
            }
          } finally {
            releaseJourneyFlight(state);
            releaseJourneyCloseSeal(state);
            journeys.delete(copied.requestId);
          }
        },
      };
      openingState = undefined;
      return Object.freeze(observer);
    } catch {
      if (openingState !== undefined) {
        journeys.delete(suppliedRequestId);
        releaseJourneyFlight(openingState);
        releaseJourneyCloseSeal(openingState);
      }
      return noOpObserver(suppliedRequestId);
    }
  };

  const command = async (message: object): Promise<unknown> => {
    if (closed) throw new Error("Diagnostics authority is closed");
    if (permanentlyUnavailable) throw new DiagnosticsUnavailableError();
    await readyPromise;
    if (permanentlyUnavailable) throw new DiagnosticsUnavailableError();
    if (worker === undefined || !ready) {
      throw new DiagnosticsUnavailableError();
    }
    const commandId = ++nextCommandId;
    const result = new Promise<unknown>((resolve, reject) => {
      commands.set(commandId, { resolve, reject });
    });
    worker.postMessage({ ...message, commandId });
    return result;
  };

  startWorker();

  const authority: DiagnosticsManagementAuthority = {
    begin,
    diagnosticsAvailable(): boolean {
      return !closed && !permanentlyUnavailable;
    },
    observeRuntime(input: RuntimeEventObservationInput): void {
      try {
        if (closed || permanentlyUnavailable) return;
        const snapshot = copyRuntimeEvent(input);
        if (snapshot === undefined) return;
        const sequence = nextRuntimeEventSequence;
        nextRuntimeEventSequence += 1;
        admit({
          type: "append",
          runtimeId,
          recordId: randomUUID(),
          sequence,
          time: now(),
          messageKind: "runtime_event",
          payload: snapshot,
        });
      } catch {
        // Runtime Events are diagnostics-owned observation only. Invalid
        // producer input, clocks, identifiers, or queue state fail open.
      }
    },
    async queryRequestJourneys(
      query?: RequestJourneyQuery,
    ): Promise<RequestJourneyQueryResult> {
      return (await command({ type: "query", query })) as RequestJourneyQueryResult;
    },
    async getRequestJourney(
      input: RequestJourneyGetInput,
    ): Promise<RequestJourneyRecord> {
      return (await command({
        type: "get",
        requestId: input.requestId,
      })) as RequestJourneyRecord;
    },
    async getRequestArtifact(
      input: RequestArtifactGetInput,
    ): Promise<RequestArtifactReadResult> {
      if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
        throw new RangeError("Artifact offset must be a non-negative safe integer");
      }
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit <= 0 ||
        input.limit > MAX_ARTIFACT_CHUNK_BYTES
      ) {
        throw new RangeError(
          `Artifact limit must be between 1 and ${MAX_ARTIFACT_CHUNK_BYTES}`,
        );
      }
      return (await command({
        type: "get_artifact",
        requestId: input.requestId,
        artifactId: input.artifactId,
        offset: input.offset,
        limit: input.limit,
      })) as RequestArtifactReadResult;
    },
    async queryRuntimeEvents(
      query?: RuntimeEventQuery,
    ): Promise<RuntimeEventQueryResult> {
      return (await command({
        type: "query_runtime_events",
        query,
      })) as RuntimeEventQueryResult;
    },
    async getAnalytics(
      query: AnalyticsQuery,
    ): Promise<AnalyticsQueryResult> {
      return (await command({
        type: "get_analytics",
        query,
      })) as AnalyticsQueryResult;
    },
    async createBackupSnapshot(signal: AbortSignal): Promise<Uint8Array> {
      signal.throwIfAborted();
      const snapshot = await command({ type: "create_backup_snapshot" });
      signal.throwIfAborted();
      if (!(snapshot instanceof Uint8Array)) {
        throw new Error("Diagnostics backup snapshot is invalid");
      }
      return snapshot;
    },
    async deleteHistory(
      range: DiagnosticsHistoryRange,
    ): Promise<DiagnosticsHistoryDeleteResult> {
      return (await command({
        type: "delete_history",
        range,
      })) as DiagnosticsHistoryDeleteResult;
    },
    async countHistory(
      range: DiagnosticsHistoryRange,
    ): Promise<DiagnosticsHistoryCounts> {
      return (await command({
        type: "count_history",
        range,
      })) as DiagnosticsHistoryCounts;
    },
    subscribeRequestJourneys(
      listener: RequestJourneySubscriber,
    ): DiagnosticsSubscription {
      return subscribe(requestJourneySubscribers, listener);
    },
    subscribeRuntimeEvents(
      listener: RuntimeEventSubscriber,
    ): DiagnosticsSubscription {
      return subscribe(runtimeEventSubscribers, listener);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      for (const state of journeys.values()) {
        state.closed = true;
        releaseJourneyFlight(state);
        releaseJourneyCloseSeal(state);
      }
      journeys.clear();
      if (permanentlyUnavailable) {
        const unavailableWorker = worker;
        worker = undefined;
        if (unavailableWorker !== undefined) {
          await unavailableWorker.terminate().catch(() => undefined);
        }
        clearPendingCapacity();
        clearSubscribers();
        return;
      }
      const deadline = Date.now() + 2_000;
      while (pending.size > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (permanentlyUnavailable) {
        const unavailableWorker = worker;
        worker = undefined;
        if (unavailableWorker !== undefined) {
          await unavailableWorker.terminate().catch(() => undefined);
        }
        clearPendingCapacity();
        clearSubscribers();
        return;
      }
      const activeWorker = worker;
      if (activeWorker === undefined) {
        clearPendingCapacity();
        clearSubscribers();
        return;
      }
      const commandId = ++nextCommandId;
      const result = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        commands.set(commandId, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
      activeWorker.postMessage({ type: "close", commandId });
      await result;
      await activeWorker.terminate().catch(() => undefined);
      worker = undefined;
      clearPendingCapacity();
      clearSubscribers();
      rejectCommands(new Error("Diagnostics authority is closed"));
    },
  };
  return Object.freeze(authority);
}

export type { CreateDiagnosticsAuthorityOptions };
