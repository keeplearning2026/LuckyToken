import { describe, expect, it, vi } from "vitest";

import { createBoundedJsonSnapshot } from "../../src/diagnostics/bounded-json-snapshot.js";
import { beginRequestJourney } from "../../src/http.js";

describe("bounded diagnostics JSON snapshots", () => {
  it("copies own data without invoking conversion hooks or accessors", () => {
    const toJson = vi.fn();
    const getter = vi.fn();
    const input = { kept: "value" } as Record<string, unknown>;
    Object.defineProperties(input, {
      toJSON: { enumerable: false, value: toJson },
      dangerous: { enumerable: true, get: getter },
    });

    const result = createBoundedJsonSnapshot(input);

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(JSON.parse(new TextDecoder().decode(result.bytes))).toEqual({
      kept: "value",
    });
    expect(toJson).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects an oversized synchronous object snapshot with a typed reason", () => {
    const result = createBoundedJsonSnapshot({
      payload: "x".repeat(1 * 1_024 * 1_024 + 1),
    });

    expect(result).toEqual({
      kind: "unavailable",
      reason: "synchronous_json_snapshot_limit_exceeded",
    });
  });

  it("contains cyclic and hostile proxy inputs", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(createBoundedJsonSnapshot(cyclic)).toEqual({
      kind: "unavailable",
      reason: "synchronous_json_snapshot_cycle",
    });

    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile ownKeys trap");
        },
      },
    );
    expect(createBoundedJsonSnapshot(proxy)).toEqual({
      kind: "unavailable",
      reason: "synchronous_json_snapshot_unsupported",
    });
  });

  it("does no JSON work when the request has no diagnostics authority", () => {
    const toJson = vi.fn();
    const value = { safe: true };
    Object.defineProperty(value, "toJSON", { value: toJson });
    const context = beginRequestJourney(undefined, {
      requestId: "bounded-json-noop-0000-4000-8000-000000000001",
      operationCandidate: "pending",
      transport: "in_process",
      method: "POST",
      path: "/noop",
      acceptedAt: 0,
      cancellation: { caller: "active", shutdown: "not_bound" },
    });

    context.journey.openArtifact!({
      artifactId: "noop-json",
      artifactKind: "noop-json",
      mediaType: "application/json",
      location: { phase: "http_admission", step: "noop_json" },
    }).captureJson(value);

    expect(toJson).not.toHaveBeenCalled();
  });
});
