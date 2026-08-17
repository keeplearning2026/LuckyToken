/**
 * Persistence degradation authority (Ticket 23) — the one state machine
 * observing Request Ledger, Runtime Diagnostics, and Deep-capture
 * persistence failures, plus the bounded in-memory Critical fallback.
 *
 * On any persistence failure the authority:
 *  1. records a sanitized **fixed-text** Critical into a bounded in-memory
 *     ring (the "bounded memory" of the acceptance criteria), and
 *  2. writes the same fixed line to stderr, and
 *  3. appends the Critical to the persistent diagnostics store when the
 *     failing authority is the ledger or the capture store — a diagnostics
 *     failure is never re-appended to itself (no recursive re-entry into a
 *     failed store).
 *
 * The fallback chain is strictly ordered and never re-enters a failed
 * store; a failure while writing the fallback itself is dropped (no
 * third-order retry). Every Critical is fixed text plus an optional
 * grammar-safe correlation id — nothing dynamic to redact and no
 * scrub-recursion by construction.
 *
 * State: per-authority `unavailable since`, application-wide
 * `auditUnavailable` (any authority down), and `acknowledged` (user
 * action). Recovery (a demonstrated successful write on a previously
 * failing authority) clears unavailability unconditionally, regardless of
 * acknowledgment; acknowledgment only silences the urgent presentation
 * while the authority is still failing and never claims storage recovered.
 * The state is per-run by design: a new run re-derives truth from store
 * health at startup.
 */
import type {
  PersistenceAuthorityId,
  PersistenceProjection,
  RuntimeDiagnosticRecord,
  RuntimeDiagnosticsStore,
} from "@luckytoken/application-control-plane/control-plane";

export type { PersistenceAuthorityId, PersistenceProjection };

/** Narrow sanitized failure fact. Every string here is already grammar-safe
 *  at its source (a UUID request id, a sha256 message hash, or a fixed
 *  structured code); raw fault text never enters this authority. */
export interface PersistenceFailureFact {
  readonly requestId?: string;
  readonly messageHash?: string;
  readonly code?: "capture-write-failed";
}

export interface PersistenceAuthorityStateEntry {
  readonly authority: PersistenceAuthorityId;
  /** Epoch-ms of the first failure of this run. */
  readonly since: number;
  /** Epoch-ms of the most recent failure. */
  readonly lastFailureTime: number;
}

const INTERNAL_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[0-9a-f]{64}$/iu;

function sanitizeFailureFact(
  fact: PersistenceFailureFact | undefined,
): PersistenceFailureFact | undefined {
  if (fact === undefined) return undefined;
  const requestId =
    typeof fact.requestId === "string" && INTERNAL_REQUEST_ID.test(fact.requestId)
      ? fact.requestId
      : undefined;
  const messageHash =
    typeof fact.messageHash === "string" && SHA256_HEX.test(fact.messageHash)
      ? fact.messageHash
      : undefined;
  const code = fact.code === "capture-write-failed" ? fact.code : undefined;
  return requestId === undefined && messageHash === undefined && code === undefined
    ? undefined
    : Object.freeze({
        ...(requestId === undefined ? {} : { requestId }),
        ...(messageHash === undefined ? {} : { messageHash }),
        ...(code === undefined ? {} : { code }),
      });
}

export interface PersistenceState {
  readonly auditUnavailable: boolean;
  readonly acknowledged: boolean;
  readonly authorities: readonly PersistenceAuthorityStateEntry[];
}

export interface PersistenceDegradationAuthorityOptions {
  readonly now?: () => number;
  /** Bounded in-memory Critical ring capacity; defaults to 100. */
  readonly capacity?: number;
  /** Injectable stderr sink (defaults to process.stderr). */
  readonly stderr?: (line: string) => void;
  /** The persistent diagnostics store. Critical copies are appended for the
   *  ledger/capture authorities; a diagnostics failure is never appended to
   *  itself. Absent when the diagnostics store itself is unavailable. */
  readonly diagnosticsStore?: RuntimeDiagnosticsStore;
  /** Ring record-id source; defaults to an increasing local counter. */
  readonly createRecordId?: () => number;
  /** Invoked on every state transition (failure, recovery, acknowledgment). */
  readonly onStateChange?: (state: PersistenceState) => void;
}

/** Fixed sanitized Critical text per authority: nothing dynamic to redact,
 *  explicitly stating the audit guarantee is unavailable until recovery.
 *  A correlation id may be appended in a grammar-safe suffix. */
const FIXED_CRITICAL_TEXT: Readonly<
  Record<PersistenceAuthorityId, string>
> = Object.freeze({
  requestLedger:
    "LuckyToken Critical: request-ledger persistence unavailable; audit guarantee unavailable until recovery.",
  diagnostics:
    "LuckyToken Critical: runtime-diagnostics persistence unavailable; audit guarantee unavailable until recovery.",
  capture:
    "LuckyToken Critical: deep-capture persistence unavailable; audit guarantee unavailable until recovery.",
});

function safeTime(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must return a non-negative safe integer`);
  }
  return value;
}

export function createPersistenceDegradationAuthority(
  options: PersistenceDegradationAuthorityOptions = {},
): PersistenceDegradationAuthority {
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? 100;
  const writeStderr =
    options.stderr ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const diagnosticsStore = options.diagnosticsStore;
  let nextId = 0;
  const createRecordId =
    options.createRecordId ??
    (() => {
      nextId += 1;
      return nextId;
    });
  const listeners = new Set<(state: PersistenceState) => void>();

  /** Bounded in-memory Critical ring (newest first). */
  const ring: RuntimeDiagnosticRecord[] = [];
  const authorities = new Map<
    PersistenceAuthorityId,
    PersistenceAuthorityStateEntry
  >();
  let acknowledged = false;

  const currentState = (): PersistenceState =>
    Object.freeze({
      auditUnavailable: authorities.size > 0,
      acknowledged,
      authorities: Object.freeze(
        [...authorities.values()].map((entry) => Object.freeze({ ...entry })),
      ),
    });

  const notify = (): void => {
    const state = currentState();
    try {
      options.onStateChange?.(state);
    } catch {
      // Persistence fallback reporting is terminal: presentation failures
      // can never escape back into the model-serving path.
    }
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // One observer cannot prevent the remaining observers or mutate the
        // authoritative degradation state.
      }
    }
  };

  /** Fixed Critical record into the bounded ring; returns the record. */
  const recordCritical = (
    authority: PersistenceAuthorityId,
    fact: PersistenceFailureFact | undefined,
    time: number,
  ): RuntimeDiagnosticRecord => {
    const suffix =
      typeof fact?.requestId === "string" && fact.requestId.length > 0
        ? ` (request: ${fact.requestId})`
        : "";
    const record: RuntimeDiagnosticRecord = Object.freeze({
      id: createRecordId(),
      level: "critical",
      time,
      text: `${FIXED_CRITICAL_TEXT[authority]}${suffix}`,
      ...(typeof fact?.requestId === "string" && fact.requestId.length > 0
        ? { requestId: fact.requestId }
        : {}),
    });
    ring.unshift(record);
    if (ring.length > capacity) ring.pop();
    return record;
  };

  const authority: PersistenceDegradationAuthority = {
    reportFailure(
      authorityId: PersistenceAuthorityId,
      fact?: PersistenceFailureFact,
    ): void {
      const sanitizedFact = sanitizeFailureFact(fact);
      let time: number;
      try {
        time = safeTime(now(), "persistence degradation clock");
      } catch {
        time = Date.now();
      }
      const existing = authorities.get(authorityId);
      authorities.set(authorityId, Object.freeze({
        authority: authorityId,
        since: existing?.since ?? time,
        lastFailureTime: time,
      }));
      // 1. Bound in-memory Critical (always; the terminal sink).
      const record = recordCritical(authorityId, sanitizedFact, time);
      // 2. stderr (always; the second terminal sink). Fixed text + safe
      //    correlation suffix only — never fault text.
      try {
        writeStderr(`${record.text}\n`);
      } catch {
        // The bounded ring remains the terminal in-memory sink. A broken
        // stderr stream must not replace an otherwise valid model result.
      }
      // 3. The persistent diagnostics store — only when the failing
      //    authority is NOT the diagnostics store, so a failed store is
      //    never re-entered recursively. A throwing diagnostics append is
      //    dropped (no third-order retry).
      if (
        authorityId !== "diagnostics" &&
        diagnosticsStore !== undefined
      ) {
        try {
          diagnosticsStore.append({
            level: "critical",
            text: record.text,
            ...(sanitizedFact?.requestId === undefined
              ? {}
              : { requestId: sanitizedFact.requestId }),
            details: Object.freeze({
              ...(sanitizedFact?.messageHash === undefined
                ? {}
                : { messageHash: sanitizedFact.messageHash }),
              ...(sanitizedFact?.code === undefined
                ? {}
                : { code: sanitizedFact.code }),
            }),
          });
        } catch {
          // The diagnostics store is itself failing; the Critical already
          // reached the ring and stderr. No recursion, no retry.
        }
      }
      notify();
    },
    reportRecovery(authorityId: PersistenceAuthorityId): void {
      // Recovery is demonstrated by a successful write on a previously
      // failing authority; an authority that never failed has no recovery
      // transition.
      if (!authorities.delete(authorityId)) return;
      if (authorities.size === 0) acknowledged = false;
      notify();
    },
    acknowledge(): "ok" | "unchanged" {
      if (authorities.size === 0) return "unchanged";
      acknowledged = true;
      notify();
      return "ok";
    },
    state(): PersistenceState {
      return currentState();
    },
    projection(): PersistenceProjection | undefined {
      if (authorities.size === 0) return undefined;
      return Object.freeze({
        auditUnavailable: true,
        acknowledged,
        authorities: Object.freeze(
          [...authorities.values()].map((entry) =>
            Object.freeze({ authority: entry.authority, since: entry.since }),
          ),
        ),
      });
    },
    ring(): readonly RuntimeDiagnosticRecord[] {
      return Object.freeze([...ring]);
    },
    subscribe(
      listener: (state: PersistenceState) => void,
    ): { readonly unsubscribe: () => void } {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  return Object.freeze(authority);
}

/** One persistence authority: failures feed the fallback chain and the
 *  state machine; recovery is demonstrated by a subsequent successful write
 *  (reported through each store's narrow recovery seam). */
export interface PersistenceDegradationAuthority {
  reportFailure(
    authority: PersistenceAuthorityId,
    fact?: PersistenceFailureFact,
  ): void;
  reportRecovery(authority: PersistenceAuthorityId): void;
  /** Silences only the urgent presentation while an authority is still
   *  failing; returns "unchanged" when nothing is unavailable. */
  acknowledge(): "ok" | "unchanged";
  state(): PersistenceState;
  /** Status projection; undefined when every authority is healthy. */
  projection(): PersistenceProjection | undefined;
  /** Bounded in-memory Critical records (newest first). */
  ring(): readonly RuntimeDiagnosticRecord[];
  subscribe(
    listener: (state: PersistenceState) => void,
  ): { readonly unsubscribe: () => void };
}
