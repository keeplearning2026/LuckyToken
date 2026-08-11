import { describe, expect, it } from "vitest";

import {
  createOnlineTestPlan,
  OFFLINE_ONLY_PROTOCOL_CASES,
  ONLINE_CONFORMANCE_CASES,
} from "../online/plan.js";

describe("authorized online test plan", () => {
  it("schedules the approved 60 requests without hiding recovery calls", () => {
    const plan = createOnlineTestPlan();

    expect(plan.filter((job) => job.kind === "json")).toHaveLength(36);
    expect(plan.filter((job) => job.kind === "sse")).toHaveLength(14);
    expect(plan.filter((job) => job.kind === "cancel-recovery")).toHaveLength(5);
    expect(
      plan.reduce(
        (total, job) => total + (job.kind === "cancel-recovery" ? 2 : 1),
        0,
      ),
    ).toBe(60);
    expect(new Set(plan.map((job) => job.marker)).size).toBe(plan.length);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.every((job) => Object.isFrozen(job))).toBe(true);
  });

  it("covers the reachable online protocol matrix and names offline-only failures", () => {
    expect(ONLINE_CONFORMANCE_CASES.map((entry) => entry.id)).toEqual([
      "system-controls-json",
      "atomic-sse-events",
      "historical-text",
      "thinking-round-trip",
      "max-tokens-terminal",
      "concurrent-isolation",
      "provider-tool-call-round-trip",
      "tool-result-omitted",
      "tool-result-text",
      "tool-result-error",
      "client-auth-global",
      "client-auth-project",
    ]);
    expect(
      new Set(ONLINE_CONFORMANCE_CASES.flatMap((entry) => entry.covers)),
    ).toEqual(
      new Set([
        "request-controls",
        "messages",
        "thinking",
        "tools",
        "usage-terminal",
        "json",
        "sse",
        "client-auth-scopes",
      ]),
    );
    expect(OFFLINE_ONLY_PROTOCOL_CASES).toEqual(
      expect.arrayContaining([
        "malformed-known-events",
        "unknown-events",
        "terminal-less-eof",
        "retry-and-backoff",
        "utf8-and-chunk-splits",
        "image-capability-gate",
      ]),
    );
    expect(Object.isFrozen(ONLINE_CONFORMANCE_CASES)).toBe(true);
    expect(Object.isFrozen(OFFLINE_ONLY_PROTOCOL_CASES)).toBe(true);
  });
});
