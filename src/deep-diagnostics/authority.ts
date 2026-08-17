/**
 * Deep Diagnostics global capture authority (Ticket 22) — the one global
 * enable/disable state and the per-request observer.
 *
 * State: one immutable enable snapshot, read exactly once at request
 * acceptance. The composition wires `readEnabled` to the registered
 * hot-apply setting `diagnostics.deepCapture.enabled` (settings registry);
 * a request that read `false` never re-reads, and a request that read
 * `true` keeps its `CaptureDecision` until finalize even if the toggle
 * flips while it is in flight. Simultaneous requests are safe because each
 * request owns an immutable decision and capture buffer; the authority owns
 * only one shared persistence-health bit used to report demonstrated
 * recovery after a prior write failure.
 *
 * The observer is protocol-agnostic: bytes + facts in, no IR types. It
 * collects the request body, the prepared response (status/headers/bytes),
 * a bounded ordered timing list, and the failure classification; finalize
 * enqueues the bounded store write (fire-and-forget, never on the response
 * path). A write fault is retried once with the minimal failed-state marker
 * so the failed state stays observable; if that also faults, only the
 * narrow sanitized failure seam (request id + fixed structured code — never
 * a derivative of raw fault text) fires — the model response is never
 * altered.
 */
import type {
  CaptureDraft,
  CaptureFailureDraft,
  CaptureTimingEntry,
  CaptureWriteFailure,
  DeepCaptureStore,
} from "./contract.js";

export interface DeepCaptureAuthorityOptions {
  readonly store: DeepCaptureStore;
  /** Reads the one global enable state; wired to the settings registry by
   *  the composition. Never re-read for an accepted request. */
  readonly readEnabled: () => boolean;
  readonly now?: () => number;
  /**
   * Narrow sanitized write-failure seam: invoked with a request id and a
   * fixed structured code only; never with fault text or any derivative
   * of it. Wired by the composition to the diagnostics Critical surface.
   */
  readonly onWriteFailure?: (fact: CaptureWriteFailure) => void;
  /**
   * Narrow sanitized write-recovery seam (Ticket 23): invoked once with the
   * request id when the first successful store commit after a reported
   * write failure demonstrates the capture store is writable again. Never
   * carries fault text.
   */
  readonly onWriteRecovery?: (fact: { readonly requestId: string }) => void;
}

export interface DeepCaptureBeginInput {
  /** The Ticket 18 Request Ledger request id; never minted here. */
  readonly requestId: string;
  readonly protocolId: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
}

/** Handler-local capture collector: one per accepted request. Every call is
 *  side-effect-free on request handling; finalize never throws. */
export interface DeepCaptureEntry {
  readonly requestId: string;
  /** The immutable acceptance-time decision snapshot. */
  readonly decision: Readonly<{ enabled: boolean; acceptedAt: number }>;
  /** Captures the raw request body (exactly once; later calls ignored). */
  requestBody(body: string): void;
  /** Captures the prepared response facts (exactly once; later calls
   *  ignored). Bytes are the exact sanitized-at-commit artifacts. */
  response(
    status: number,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): void;
  /** Records a bounded failure classification (abort/unhandled paths). */
  fail(classification: string): void;
  /** Enqueues the bounded write off the response path; never throws. */
  finalize(): void;
}

export interface DeepCaptureAuthority {
  begin(input: DeepCaptureBeginInput): DeepCaptureEntry;
}

const MAX_TIMING = 64;

/** Safe disabled entry: used when capture is disabled and when a hostile
 *  authority's begin throws — the request path must never depend on capture
 *  infrastructure. */
export function createNoopCaptureEntry(requestId: string): DeepCaptureEntry {
  return noopEntry(requestId);
}

/** No-op observer: keeps handlers that were not wired a capture authority
 *  safe. It still exposes the decision facts (disabled) so handler code is
 *  uniform. */
function noopEntry(requestId: string): DeepCaptureEntry {
  return Object.freeze({
    requestId,
    decision: Object.freeze({ enabled: false, acceptedAt: 0 }),
    requestBody: () => undefined,
    response: () => undefined,
    fail: () => undefined,
    finalize: () => undefined,
  });
}

export function createNoopDeepCaptureAuthority(): DeepCaptureAuthority {
  return Object.freeze({
    begin: (input: DeepCaptureBeginInput) => noopEntry(input.requestId),
  });
}

export function createDeepCaptureAuthority(
  options: DeepCaptureAuthorityOptions,
): DeepCaptureAuthority {
  const now = options.now ?? Date.now;
  /** Authority-wide persistence health: a failed request cannot later
   *  succeed itself because every capture entry finalizes once. Therefore
   *  the first successful commit by any later entry demonstrates recovery. */
  let hadWriteFailure = false;

  const begin = (input: DeepCaptureBeginInput): DeepCaptureEntry => {
    // Immutable acceptance-time snapshot: the enabled decision and its
    // acceptedAt are read once, before any auth/body work.
    let enabled: boolean;
    try {
      enabled = options.readEnabled() === true;
    } catch {
      enabled = false;
    }
    let acceptedAt: number;
    try {
      const time = now();
      acceptedAt = Number.isSafeInteger(time) && time >= 0 ? time : Date.now();
    } catch {
      acceptedAt = Date.now();
    }
    if (!enabled) return noopEntry(input.requestId);

    const decision = Object.freeze({ enabled: true, acceptedAt });
    const timing: CaptureTimingEntry[] = [
      Object.freeze({ stage: "accepted", time: acceptedAt }),
    ];
    let sawRequestBody = false;
    let sawResponse = false;
    let failure: string | undefined;
    let finalized = false;
    const mark = (stage: string): void => {
      if (timing.length >= MAX_TIMING) return;
      let time: number;
      try {
        const candidate = now();
        time = Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : Date.now();
      } catch {
        time = Date.now();
      }
      timing.push(Object.freeze({ stage, time }));
    };

    const commit = (): void => {
      if (finalized) return;
      finalized = true;
      try {
        const draft: CaptureDraft = {
          requestId: input.requestId,
          protocolId: input.protocolId,
          acceptedAt: decision.acceptedAt,
          ...(failure === undefined ? {} : { failure }),
          ...(sawRequestBody
            ? { requestBody: currentRequestBody }
            : {}),
          ...(sawResponse
            ? { clientHttpStatus: currentStatus, responseHeaders: currentResponseHeaders, responseBody: currentResponseBody }
            : {}),
          requestHeaders: input.requestHeaders,
          ...(timing.length === 0 ? {} : { timing }),
          complete: sawRequestBody && sawResponse,
        };
        options.store.append(draft);
        // Demonstrated recovery: a successful commit after a reported write
        // failure reports recovery exactly once. The seam is guarded so it
        // can never steer the request path.
        if (hadWriteFailure) {
          hadWriteFailure = false;
          try {
            options.onWriteRecovery?.({ requestId: input.requestId });
          } catch {
            // The recovery seam must never affect the request path.
          }
        }
      } catch {
        // First write faulted: retry with the minimal failed-state marker
        // so the failed state stays observable. If that also faults, only
        // the narrow sanitized seam fires (never fault text).
        try {
          const marker: CaptureFailureDraft = {
            requestId: input.requestId,
            protocolId: input.protocolId,
            acceptedAt: decision.acceptedAt,
          };
          options.store.appendFailed(marker);
          if (hadWriteFailure) {
            hadWriteFailure = false;
            try {
              options.onWriteRecovery?.({ requestId: input.requestId });
            } catch {
              // The recovery seam must never affect the request path.
            }
          }
        } catch (retryError) {
          // The narrow seam carries a fixed structured code and the request
          // id only: raw fault text is never persisted, hashed, or echoed
          // (an unkeyed hash of a low-entropy fault string would be
          // offline-enumerable).
          void retryError;
          hadWriteFailure = true;
          try {
            options.onWriteFailure?.({
              requestId: input.requestId,
              code: "capture-write-failed",
            });
          } catch {
            // The diagnostics seam must never affect the request path.
          }
        }
      }
    };

    let currentRequestBody = "";
    let currentStatus = 0;
    let currentResponseHeaders: Readonly<Record<string, string>> = Object.freeze({});
    let currentResponseBody = "";

    return Object.freeze({
      requestId: input.requestId,
      decision,
      requestBody(body: string): void {
        if (sawRequestBody) return;
        sawRequestBody = true;
        currentRequestBody = body;
        mark("request-body");
      },
      response(
        status: number,
        headers: Readonly<Record<string, string>>,
        body: string,
      ): void {
        if (sawResponse) return;
        sawResponse = true;
        currentStatus = status;
        currentResponseHeaders = headers;
        currentResponseBody = body;
        mark("response");
      },
      fail(classification: string): void {
        if (failure === undefined) failure = classification;
      },
      finalize(): void {
        mark("finalize");
        // Fire-and-forget: the bounded write is enqueued off the response
        // path; commit never rejects and never alters the model response.
        void Promise.resolve().then(commit);
      },
    });
  };

  return Object.freeze({ begin });
}
