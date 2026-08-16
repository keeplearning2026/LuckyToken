import { describe, expect, it } from "vitest";

import {
  projectCaptureDetail,
} from "../src/control-plane-projection.js";

/**
 * Ticket 22 request-detail capture projection: the five truthful capture
 * states derive deterministically from the Control Plane capture query —
 * never from raw capture bytes.
 */
describe("Request-detail capture projection (Ticket 22)", () => {
  it("derives the five capture states with stable labels and value-free detail", () => {
    expect(
      projectCaptureDetail({ state: "no-capture" }),
    ).toEqual({
      state: "no-capture",
      label: "No capture",
      detail: "This request was accepted while deep diagnostics capture was off.",
    });
    expect(
      projectCaptureDetail({
        state: "captured",
        record: {
          requestId: "10000000-0000-4000-8000-000000000001",
          protocolId: "anthropic-messages",
          state: "captured",
          acceptedAt: 1_786_400_000_000,
          capturedAt: 1_786_400_000_003,
        },
      }).label,
    ).toBe("Captured");
    expect(
      projectCaptureDetail({
        state: "partial",
        record: {
          requestId: "10000000-0000-4000-8000-000000000002",
          protocolId: "anthropic-messages",
          state: "partial",
          acceptedAt: 1_786_400_000_000,
          capturedAt: 1_786_400_000_003,
        },
      }).label,
    ).toBe("Partial capture");
    expect(
      projectCaptureDetail({
        state: "failed",
        record: {
          requestId: "10000000-0000-4000-8000-000000000003",
          protocolId: "anthropic-messages",
          state: "failed",
          acceptedAt: 1_786_400_000_000,
          capturedAt: 1_786_400_000_003,
        },
      }).label,
    ).toBe("Capture failed");
    expect(
      projectCaptureDetail({
        state: "expired",
        evictedAt: 1_786_400_000_009,
        evictionReason: "capacity",
      }),
    ).toEqual({
      state: "expired",
      label: "Capture expired",
      detail:
        "The raw capture was evicted by age or capacity; the request record remains.",
    });
  });

  it("never projects capture bytes into the detail surface", () => {
    const projected = projectCaptureDetail({
      state: "captured",
      record: {
        requestId: "10000000-0000-4000-8000-000000000001",
        protocolId: "anthropic-messages",
        state: "captured",
        acceptedAt: 1_786_400_000_000,
        capturedAt: 1_786_400_000_003,
        requestBody: "canary-secret-body-998877",
        responseBody: "canary-secret-response-998877",
        requestHeaders: { authorization: "[REDACTED]" },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("canary-secret");
    expect(Object.keys(projected).sort()).toEqual(["detail", "label", "state"]);
    expect(Object.isFrozen(projected)).toBe(true);
  });
});
