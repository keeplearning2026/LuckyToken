import { describe, expect, it } from "vitest";

import {
  decodeCaptureEvent,
  decodeCaptureQuery,
  decodeCaptureQueryResult,
  decodeCaptureRecord,
} from "../../packages/application-control-plane/src/wire-capture.js";
import {
  parseDeepDiagnosticsConfiguration,
  bindDeepDiagnosticsConfiguration,
} from "../../src/deep-diagnostics/index.js";

/**
 * Ticket 22 unit contract seam: strict allowlist wire codecs (unknown keys
 * and out-of-bounds values are rejected, never projected) and the versioned
 * configuration snapshot ownership contract.
 */

const REQUEST_ID = "10000000-0000-4000-8000-000000000001";

function validRecord(): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    protocolId: "anthropic-messages",
    state: "captured",
    acceptedAt: 1_786_400_000_000,
    capturedAt: 1_786_400_000_003,
    clientHttpStatus: 200,
    requestBody: '{"note":"safe"}',
    responseBody: '{"content":"ok"}',
    requestHeaders: { authorization: "[REDACTED]", "content-type": "application/json" },
    responseHeaders: { "content-type": "application/json" },
    timing: [
      { stage: "accepted", time: 1_786_400_000_000 },
      { stage: "finalize", time: 1_786_400_000_003 },
    ],
  };
}

describe("Deep Diagnostics wire codecs (Ticket 22)", () => {
  it("decodes a committed capture record exactly and freezes it", () => {
    const decoded = decodeCaptureRecord(validRecord());
    expect(decoded).toEqual({
      requestId: REQUEST_ID,
      protocolId: "anthropic-messages",
      state: "captured",
      acceptedAt: 1_786_400_000_000,
      capturedAt: 1_786_400_000_003,
      clientHttpStatus: 200,
      requestBody: '{"note":"safe"}',
      responseBody: '{"content":"ok"}',
      requestHeaders: {
        authorization: "[REDACTED]",
        "content-type": "application/json",
      },
      responseHeaders: { "content-type": "application/json" },
      timing: [
        { stage: "accepted", time: 1_786_400_000_000 },
        { stage: "finalize", time: 1_786_400_000_003 },
      ],
    });
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it("rejects records with unknown keys, malformed ids, or out-of-bounds values", () => {
    expect(
      decodeCaptureRecord({ ...validRecord(), extra: "must-not-project" }),
    ).toBeUndefined();
    expect(
      decodeCaptureRecord({ ...validRecord(), requestId: "not-a-uuid" }),
    ).toBeUndefined();
    expect(
      decodeCaptureRecord({ ...validRecord(), state: "no-capture" }),
    ).toBeUndefined();
    expect(
      decodeCaptureRecord({ ...validRecord(), clientHttpStatus: 42 }),
    ).toBeUndefined();
    expect(
      decodeCaptureRecord({ ...validRecord(), failure: "x".repeat(200) }),
    ).toBeUndefined();
    expect(
      decodeCaptureRecord({
        ...validRecord(),
        timing: [{ stage: "accepted" }],
      }),
    ).toBeUndefined();
    expect(
      decodeCaptureRecord({ ...validRecord(), requestHeaders: { cookie: 7 } }),
    ).toBeUndefined();
  });

  it("decodes query results with state/record/eviction coherence", () => {
    const captured = decodeCaptureQueryResult({
      state: "captured",
      record: validRecord(),
    });
    expect(captured?.state).toBe("captured");
    expect(captured?.record?.requestId).toBe(REQUEST_ID);

    const expired = decodeCaptureQueryResult({
      state: "expired",
      evictedAt: 1_786_400_000_009,
      evictionReason: "capacity",
    });
    expect(expired).toMatchObject({
      state: "expired",
      evictedAt: 1_786_400_000_009,
      evictionReason: "capacity",
    });

    const none = decodeCaptureQueryResult({ state: "no-capture" });
    expect(none?.state).toBe("no-capture");
    expect(none?.record).toBeUndefined();

    // Incoherent results are rejected: committed states without a record,
    // expired without eviction facts, records on non-committed states.
    expect(decodeCaptureQueryResult({ state: "captured" })).toBeUndefined();
    expect(decodeCaptureQueryResult({ state: "expired" })).toBeUndefined();
    expect(
      decodeCaptureQueryResult({ state: "no-capture", record: validRecord() }),
    ).toBeUndefined();
    expect(
      decodeCaptureQueryResult({
        state: "captured",
        record: validRecord(),
        evictionReason: "age",
      }),
    ).toBeUndefined();
  });

  it("decodes the query by request id only", () => {
    expect(decodeCaptureQuery({ requestId: REQUEST_ID })).toEqual({
      requestId: REQUEST_ID,
    });
    expect(decodeCaptureQuery(undefined)).toBeUndefined();
    expect(decodeCaptureQuery({})).toBeUndefined();
    expect(decodeCaptureQuery({ requestId: "bad", extra: 1 })).toBeUndefined();
  });

  it("decodes the typed capture event with narrow facts only", () => {
    const event = decodeCaptureEvent({
      type: "capture_state_changed",
      fact: {
        requestId: REQUEST_ID,
        protocolId: "anthropic-messages",
        state: "partial",
        acceptedAt: 1_786_400_000_000,
        clientHttpStatus: 401,
      },
    });
    expect(event).toEqual({
      type: "capture_state_changed",
      fact: {
        requestId: REQUEST_ID,
        protocolId: "anthropic-messages",
        state: "partial",
        acceptedAt: 1_786_400_000_000,
        clientHttpStatus: 401,
      },
    });
    // Unknown fact keys, bodies, and malformed shapes are rejected.
    expect(
      decodeCaptureEvent({
        type: "capture_state_changed",
        fact: {
          requestId: REQUEST_ID,
          protocolId: "anthropic-messages",
          state: "captured",
          acceptedAt: 1_786_400_000_000,
          requestBody: "must-not-project",
        },
      }),
    ).toBeUndefined();
    expect(
      decodeCaptureEvent({
        type: "capture_state_changed",
        fact: { requestId: "bad", protocolId: "p", state: "captured", acceptedAt: 0 },
      }),
    ).toBeUndefined();
    expect(decodeCaptureEvent({ type: "other" })).toBeUndefined();
  });
});

describe("Deep Diagnostics configuration snapshot ownership", () => {
  it("parses defaults and bounds, and binds only capture-owned snapshots", () => {
    const parsed = parseDeepDiagnosticsConfiguration({}, "C:\\app");
    expect(parsed).toMatchObject({
      directory: "C:\\app\\state\\deep-diagnostics",
      enabled: false,
      maxCaptureBytes: 4 * 1024 * 1024,
      retentionAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxCaptures: 1_000,
    });
    expect(bindDeepDiagnosticsConfiguration(parsed)).toBe(parsed);

    const custom = parseDeepDiagnosticsConfiguration(
      {
        directory: "state/capture",
        enabled: true,
        maxCaptureBytes: 2_048,
        retentionAgeMs: 60_000,
        maxCaptures: 5,
      },
      "C:\\app",
    );
    expect(custom).toMatchObject({
      directory: "C:\\app\\state\\capture",
      enabled: true,
      maxCaptureBytes: 2_048,
      retentionAgeMs: 60_000,
      maxCaptures: 5,
    });

    expect(() => parseDeepDiagnosticsConfiguration({ unknown: 1 }, "C:\\app")).toThrow(
      /unknown/u,
    );
    expect(() =>
      parseDeepDiagnosticsConfiguration({ maxCaptures: 0 }, "C:\\app"),
    ).toThrow(/integer between 1 and 100000/u);
    expect(() =>
      parseDeepDiagnosticsConfiguration({ enabled: "yes" }, "C:\\app"),
    ).toThrow(/boolean/u);
    expect(() => bindDeepDiagnosticsConfiguration({ directory: "x" })).toThrow(
      /not a capture-owned snapshot/u,
    );
  });
});
