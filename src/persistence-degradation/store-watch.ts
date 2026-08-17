/**
 * Store-side persistence observation (Ticket 23) — the narrow adapters
 * between the three persistent authorities and the degradation authority,
 * plus the fail-open fallback stores used when a store cannot open at
 * serve startup (serve continues, degraded from boot).
 *
 * `observeDiagnosticsStore` wraps a live Runtime Diagnostics store so a
 * persistence fault reports to the degradation authority without changing
 * any producer contract (the fault still propagates exactly as before;
 * producers own their guards).
 *
 * The fallback stores mirror their real counterparts' fail-closed
 * readiness and closed semantics so producers see identical behavior, and
 * expose `schemaVersion: 0` — the manifest source fact that there is no
 * backing store.
 */
import { randomUUID } from "node:crypto";

import {
  assertRuntimeDiagnosticLevel,
  type AnalyticsQuery,
  type AnalyticsQueryResult,
  type CaptureQueryResult,
  type CaptureRangeQueryResult,
  type CaptureRecord,
  type DeepCaptureStore,
  type RequestLedgerEntry,
  type RequestLedgerEvent,
  type RequestLedgerQueryResult,
  type RequestLedgerStore,
  type RuntimeDiagnosticDraft,
  type RuntimeDiagnosticEvent,
  type RuntimeDiagnosticQuery,
  type RuntimeDiagnosticRecord,
  type RuntimeDiagnosticsQueryResult,
  type RuntimeDiagnosticsStore,
} from "@luckytoken/application-control-plane/control-plane";
import { redactDiagnostic } from "../runtime-diagnostics/redaction.js";
import { createLedgerAnalyticsAccumulator } from "../request-ledger/analytics.js";
import type { PersistenceDegradationAuthority } from "./authority.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Wraps a live diagnostics store: a genuine append persistence fault (the
 * store is open and ready) reports to the degradation authority and is
 * rethrown unchanged; the first subsequent successful append demonstrates
 * recovery. Readiness and closed state are mirrored so pre-scrub and
 * post-close faults are never misreported as persistence failures, and
 * producer input faults (invalid level/text) are not persistence failures
 * either — they are validated up front and left to the store.
 */
export function observeDiagnosticsStore(
  store: RuntimeDiagnosticsStore,
  authority: PersistenceDegradationAuthority,
): RuntimeDiagnosticsStore {
  let scrubReady = false;
  let closed = false;
  let hadFailure = false;
  return Object.freeze({
    append(draft: RuntimeDiagnosticDraft): RuntimeDiagnosticRecord {
      // Input-shape faults are producer errors, not persistence failures:
      // mirror the store's cheap validation and delegate without reporting.
      let validInput = false;
      try {
        assertRuntimeDiagnosticLevel(draft.level);
        validInput =
          typeof draft.text === "string" && draft.text.length > 0;
      } catch {
        validInput = false;
      }
      if (!scrubReady || closed || !validInput) {
        return store.append(draft);
      }
      try {
        const record = store.append(draft);
        if (hadFailure) {
          hadFailure = false;
          authority.reportRecovery("diagnostics");
        }
        return record;
      } catch (error) {
        hadFailure = true;
        authority.reportFailure("diagnostics", {
          ...(typeof draft.requestId === "string" &&
          draft.requestId.length > 0 &&
          SAFE_REQUEST_ID.test(draft.requestId)
            ? { requestId: draft.requestId }
            : {}),
        });
        throw error;
      }
    },
    query(query: RuntimeDiagnosticQuery | undefined): RuntimeDiagnosticsQueryResult {
      return store.query(query);
    },
    subscribe(
      listener: (event: RuntimeDiagnosticEvent) => void,
    ): { readonly unsubscribe: () => void } {
      return store.subscribe(listener);
    },
    attachScrub(next: (value: string) => string): void {
      scrubReady = true;
      store.attachScrub(next);
    },
    close(): void {
      closed = true;
      store.close();
    },
    deleteRange(
      fromMs?: number,
      toMs?: number,
    ): { readonly deleted: number } {
      return store.deleteRange(fromMs, toMs);
    },
    countRange(fromMs?: number, toMs?: number): number {
      return store.countRange(fromMs, toMs);
    },
    createBackupSnapshot(signal: AbortSignal): Promise<Uint8Array> {
      return store.createBackupSnapshot(signal);
    },
    schemaVersion: store.schemaVersion,
  });
}

/**
 * Fail-open diagnostics surface when the diagnostics store cannot open at
 * serve startup: serve continues, every Critical append is recorded by the
 * degradation authority (fixed text to stderr and the bounded in-memory
 * ring) and queries are served from that ring — the only records that
 * exist in this mode. Non-critical appends return a sanitized synthetic
 * record but are not persisted, delivered, or queried (the audit-unavailable
 * state is the truth). The same fail-closed readiness gate applies.
 */
export function createUnavailableDiagnosticsStore(
  authority: PersistenceDegradationAuthority,
): RuntimeDiagnosticsStore {
  let scrubReady = false;
  let closed = false;
  let nextId = 0;
  return Object.freeze({
    append(draft: RuntimeDiagnosticDraft): RuntimeDiagnosticRecord {
      if (closed) throw new Error("Runtime Diagnostics store is closed");
      if (!scrubReady) {
        throw new Error(
          "Runtime Diagnostics store is not ready: the credential scrubber must be installed before appends",
        );
      }
      const level = assertRuntimeDiagnosticLevel(draft.level);
      if (typeof draft.text !== "string" || draft.text.length === 0) {
        throw new Error("runtime diagnostic text must be a non-empty string");
      }
      nextId += 1;
      // The one universal redaction choke point still applies to everything
      // this surface hands out.
      const sanitized = redactDiagnostic(
        draft.text,
        draft.details,
        draft.error,
        undefined,
      );
      const requestId =
        typeof draft.requestId === "string" &&
        draft.requestId.length > 0 &&
        SAFE_REQUEST_ID.test(draft.requestId)
          ? draft.requestId
          : undefined;
      if (level === "critical") {
        // The bounded in-memory authority is the terminal sink; the fixed
        // Critical text is the truthful record of this mode.
        authority.reportFailure("diagnostics", {
          ...(requestId === undefined ? {} : { requestId }),
        });
        const record = authority.ring()[0];
        if (record !== undefined) return record;
      }
      return Object.freeze({
        id: nextId,
        level,
        time: Date.now(),
        text: sanitized.text,
        ...(requestId === undefined ? {} : { requestId }),
        ...(sanitized.details === undefined
          ? {}
          : { details: sanitized.details }),
        ...(sanitized.errors === undefined
          ? {}
          : { errors: sanitized.errors }),
      });
    },
    query(query: RuntimeDiagnosticQuery | undefined): RuntimeDiagnosticsQueryResult {
      if (closed) throw new Error("Runtime Diagnostics store is closed");
      const afterId =
        query?.afterId === undefined || !Number.isSafeInteger(query.afterId) || query.afterId < 0
          ? 0
          : query.afterId;
      const limit = Math.min(
        Math.max(
          Number.isSafeInteger(query?.limit) && query?.limit !== undefined
            ? query.limit
            : 100,
          1,
        ),
        1_000,
      );
      // The ring is the only committed surface in this mode: Critical
      // records with id > afterId, ascending (the wire paging convention).
      const eligible = authority
        .ring()
        .filter((record) => record.id > afterId)
        .sort((left, right) => left.id - right.id);
      return Object.freeze({
        records: Object.freeze(eligible.slice(0, limit)),
        hasMore: eligible.length > limit,
      });
    },
    subscribe(
      listener: (event: RuntimeDiagnosticEvent) => void,
    ): { readonly unsubscribe: () => void } {
      void listener;
      // Nothing is committed durably in this mode; live events are not
      // delivered (query remains the truthful surface).
      return Object.freeze({ unsubscribe: () => undefined });
    },
    attachScrub(next: (value: string) => string): void {
      void next;
      scrubReady = true;
    },
    close(): void {
      closed = true;
    },
    deleteRange(): { readonly deleted: number } {
      if (closed) throw new Error("Runtime Diagnostics store is closed");
      return Object.freeze({ deleted: 0 });
    },
    countRange(): number {
      if (closed) throw new Error("Runtime Diagnostics store is closed");
      return 0;
    },
    createBackupSnapshot(): Promise<Uint8Array> {
      return Promise.reject(new Error("Runtime Diagnostics store is unavailable"));
    },
    schemaVersion: 0,
  });
}

/**
 * Fail-open Request Ledger surface when the ledger store cannot open at
 * serve startup: every request still receives a safe unique request id
 * (the x-luckytoken-request-id header contract holds), transitions are
 * no-ops, and queries are empty — the ledger simply records nothing while
 * the audit-unavailable state is visible.
 */
export function createUnavailableRequestLedgerStore(
  createRequestId: () => string = randomUUID,
): RequestLedgerStore {
  let closed = false;
  const noopEntry = (): RequestLedgerEntry => {
    let requestId = createRequestId();
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
      requestId = randomUUID();
    }
    return Object.freeze({
      requestId,
      aliasCaptured: () => undefined,
      authorized: () => undefined,
      modelResolved: () => undefined,
      executing: () => undefined,
      rendering: () => undefined,
      terminal: () => undefined,
      terminalUsage: () => undefined,
      notice: () => undefined,
      attempt: () => undefined,
      fail: () => undefined,
      completed: () => undefined,
    });
  };
  return Object.freeze({
    begin(): RequestLedgerEntry {
      return noopEntry();
    },
    query(): RequestLedgerQueryResult {
      if (closed) throw new Error("Request Ledger store is closed");
      return Object.freeze({ records: Object.freeze([]), hasMore: false });
    },
    analyze(query: AnalyticsQuery): AnalyticsQueryResult {
      return createLedgerAnalyticsAccumulator(query).finish();
    },
    subscribe(
      listener: (event: RequestLedgerEvent) => void,
    ): { readonly unsubscribe: () => void } {
      void listener;
      return Object.freeze({ unsubscribe: () => undefined });
    },
    attachScrub(): void {
      // Nothing is persisted in this mode; the scrubber has nothing to
      // scrub. Accepted so the composition's attach flow is uniform.
    },
    close(): void {
      closed = true;
    },
    deleteRange(): { readonly deleted: number } {
      if (closed) throw new Error("Request Ledger store is closed");
      return Object.freeze({ deleted: 0 });
    },
    countRange(): number {
      if (closed) throw new Error("Request Ledger store is closed");
      return 0;
    },
    createBackupSnapshot(): Promise<Uint8Array> {
      return Promise.reject(new Error("Request Ledger store is unavailable"));
    },
    schemaVersion: 0,
  });
}

/**
 * Fail-open Deep-capture surface when the capture store cannot open at
 * serve startup: appends fail closed (truthfully — nothing can be
 * persisted), which the capture authority's existing retry/failure seam
 * reports through the degradation authority; queries answer no-capture.
 */
export function createUnavailableDeepCaptureStore(): DeepCaptureStore {
  let closed = false;
  let scrubReady = false;
  return Object.freeze({
    append(): CaptureRecord {
      if (closed) throw new Error("Deep Diagnostics capture store is closed");
      if (!scrubReady) {
        throw new Error(
          "Deep Diagnostics capture store is not ready: the credential scrubber must be installed before appends",
        );
      }
      throw new Error("Deep Diagnostics capture store is unavailable");
    },
    appendFailed(): CaptureRecord {
      if (closed) throw new Error("Deep Diagnostics capture store is closed");
      if (!scrubReady) {
        throw new Error(
          "Deep Diagnostics capture store is not ready: the credential scrubber must be installed before appends",
        );
      }
      throw new Error("Deep Diagnostics capture store is unavailable");
    },
    query(): CaptureQueryResult {
      return Object.freeze({ state: "no-capture" });
    },
    queryRange(): CaptureRangeQueryResult {
      return Object.freeze({ records: Object.freeze([]), hasMore: false });
    },
    subscribe(
      listener: (event: never) => void,
    ): { readonly unsubscribe: () => void } {
      void listener;
      return Object.freeze({ unsubscribe: () => undefined });
    },
    attachScrub(): void {
      scrubReady = true;
    },
    close(): void {
      closed = true;
    },
    deleteRange(): { readonly deleted: number } {
      if (closed) throw new Error("Deep Diagnostics capture store is closed");
      return Object.freeze({ deleted: 0 });
    },
    countRange(): number {
      if (closed) throw new Error("Deep Diagnostics capture store is closed");
      return 0;
    },
    createBackupSnapshot(): Promise<Uint8Array> {
      return Promise.reject(new Error("Deep Diagnostics capture store is unavailable"));
    },
    schemaVersion: 0,
  });
}
