import { describe, expect, it } from "vitest";

import type { RequestLedgerRecord } from "../../packages/application-control-plane/src/ledger-contract.js";
import {
  averageOutputSpeedUnavailableReason,
  deriveRequestStatus,
  formatCacheHitRate,
  formatDuration,
  formatPercent,
  formatTimestamp,
  formatTokenCount,
  formatTokensPerSecond,
  ledgerPhaseLabel,
  projectAverageOutputTokensPerSecond,
  projectRequestLedger,
  projectRequestLedgerDetail,
  projectRequestUsage,
  protocolDisplayName,
} from "../../packages/application-control-plane/src/ledger-projection.js";

/**
 * Ticket 19 projection unit tests: deterministic primary-status derivation,
 * the exact average-output-speed formula with unavailable rules, the
 * canonical-usage display contract, and the list/detail projections. All
 * inputs are ledger records with fixed timestamps; the functions are pure
 * and never touch the renderer.
 */

const clientSessionId = "20000000-0000-4000-8000-000000000031";
const effectiveSessionId = "30000000-0000-4000-8000-000000000032";

/** Overrides may explicitly clear a field (exactOptionalPropertyTypes). */
type RecordOverrides = {
  readonly [K in keyof RequestLedgerRecord]?:
    | RequestLedgerRecord[K]
    | undefined;
};

function record(overrides: RecordOverrides = {}): RequestLedgerRecord {
  const base: RequestLedgerRecord = {
    id: 1,
    requestId: "10000000-0000-4000-8000-000000000001",
    protocolId: "anthropic-messages",
    phase: "terminal-preparation",
    outcome: "success",
    acceptedAt: 1_700_000_000_000,
    executionStartedAt: 1_700_000_001_000,
    terminalAt: 1_700_000_003_000,
    completedAt: 1_700_000_003_010,
    clientHttpStatus: 200,
    externalAlias: "alpha",
    providerId: "commandcode-private",
    realModelId: "claude-fixture",
    clientSessionId,
    effectiveSessionId,
    projectDir: "C:\\Users\\fixture\\projects\\alpha",
  };
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as unknown as RequestLedgerRecord;
}

function completeUsage(overrides: Record<string, unknown> = {}) {
  return {
    api: "commandcode-private",
    input: 5,
    cacheRead: 3,
    cacheWrite: 2,
    output: 100,
    reasoning: 10,
    normalizedTotal: 110,
    cacheHitRate: 0.3,
    completeness: "complete" as const,
    ...overrides,
  };
}

describe("deriveRequestStatus precedence", () => {
  it("maps running to Running regardless of the live phase", () => {
    for (const phase of [
      "accepted",
      "execution",
      "rendering",
      "terminal-preparation",
    ] as const) {
      expect(deriveRequestStatus(record({ phase, outcome: "running" }))).toBe(
        "Running",
      );
    }
  });

  it("maps success to Success", () => {
    expect(deriveRequestStatus(record({ outcome: "success" }))).toBe("Success");
  });

  it("derives Client error / Server error / Failed from the client HTTP status tier", () => {
    expect(
      deriveRequestStatus(record({ outcome: "failed", clientHttpStatus: 400 })),
    ).toBe("Client error");
    expect(
      deriveRequestStatus(record({ outcome: "failed", clientHttpStatus: 499 })),
    ).toBe("Client error");
    expect(
      deriveRequestStatus(record({ outcome: "failed", clientHttpStatus: 500 })),
    ).toBe("Server error");
    expect(
      deriveRequestStatus(record({ outcome: "failed", clientHttpStatus: 599 })),
    ).toBe("Server error");
    // A status outside the client/server tiers is never guessed into a tier.
    expect(
      deriveRequestStatus(record({ outcome: "failed", clientHttpStatus: 399 })),
    ).toBe("Failed");
    expect(
      deriveRequestStatus(record({ outcome: "failed", clientHttpStatus: 100 })),
    ).toBe("Failed");
  });

  it("falls back to Failed when a failed request has no client HTTP status", () => {
    expect(
      deriveRequestStatus(
        record({ outcome: "failed", clientHttpStatus: undefined }),
      ),
    ).toBe("Failed");
  });

  it("maps the remaining terminal outcomes to their primary statuses", () => {
    expect(deriveRequestStatus(record({ outcome: "aborted" }))).toBe("Aborted");
    expect(deriveRequestStatus(record({ outcome: "rejected-auth" }))).toBe(
      "Auth rejected",
    );
    expect(deriveRequestStatus(record({ outcome: "unknown-alias" }))).toBe(
      "Unknown model",
    );
    expect(
      deriveRequestStatus(record({ outcome: "unavailable-alias" })),
    ).toBe("Model unavailable");
    expect(deriveRequestStatus(record({ outcome: "interrupted" }))).toBe(
      "Interrupted",
    );
  });
});

describe("ledgerPhaseLabel", () => {
  it("labels every live phase", () => {
    expect(ledgerPhaseLabel("accepted")).toBe("Accepted");
    expect(ledgerPhaseLabel("execution")).toBe("Executing");
    expect(ledgerPhaseLabel("rendering")).toBe("Rendering");
    expect(ledgerPhaseLabel("terminal-preparation")).toBe("Terminal prep");
  });
});

describe("protocolDisplayName", () => {
  it("maps known protocol ids to display names", () => {
    expect(protocolDisplayName("anthropic-messages")).toBe(
      "Anthropic Messages",
    );
    expect(protocolDisplayName("openai-responses")).toBe("OpenAI Responses");
  });

  it("renders the raw id for unknown protocols", () => {
    expect(protocolDisplayName("future-protocol")).toBe("future-protocol");
  });
});

describe("formatTimestamp", () => {
  it("is deterministic and uses a fixed local format", () => {
    const first = formatTimestamp(1_700_000_000_000);
    expect(formatTimestamp(1_700_000_000_000)).toBe(first);
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
  });

  it("renders one second of difference", () => {
    expect(formatTimestamp(1_700_000_000_000)).not.toBe(
      formatTimestamp(1_700_000_001_000),
    );
  });
});

describe("formatDuration", () => {
  it("renders seconds with one decimal", () => {
    expect(formatDuration(1_500)).toBe("1.5 s");
    expect(formatDuration(0)).toBe("0.0 s");
    expect(formatDuration(60_000)).toBe("60.0 s");
  });
});

describe("shared analytics display formatters", () => {
  it("formats token counts and raw rates for renderer reuse", () => {
    expect(formatTokenCount(1_200)).toBe("1,200");
    expect(formatPercent(0.75)).toBe("75.0%");
  });
});

describe("formatTokensPerSecond", () => {
  it("renders a validated zero honestly and rounds the rest", () => {
    expect(formatTokensPerSecond(0)).toBe("0 tokens/s");
    expect(formatTokensPerSecond(50)).toBe("50.0 tokens/s");
    expect(formatTokensPerSecond(12.345)).toBe("12.3 tokens/s");
  });
});

describe("formatCacheHitRate", () => {
  it("formats a validated cache-hit rate as a bounded percentage", () => {
    expect(formatCacheHitRate(0.3)).toBe("30.0%");
    expect(formatCacheHitRate(0)).toBe("0.0%");
    expect(formatCacheHitRate(1)).toBe("100.0%");
  });
});

describe("projectRequestUsage display contract", () => {
  it("projects absent usage as unavailable", () => {
    const projection = projectRequestUsage(undefined);
    expect(projection.present).toBe(false);
    expect(projection.completeness).toBe("Unavailable");
    expect(projection.reason).toBe(
      "No terminal usage recorded for this request",
    );
    expect(projection.input).toBe("-");
    expect(projection.cacheRead).toBe("-");
    expect(projection.cacheWrite).toBe("-");
    expect(projection.output).toBe("-");
    expect(projection.normalizedTotal).toBeUndefined();
    expect(projection.cacheHitRate).toBeUndefined();
  });

  it("keeps every known component visible for partial usage with its reason", () => {
    const projection = projectRequestUsage({
      api: "anthropic-messages",
      input: 7,
      cacheRead: 1,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      completeness: "partial",
      reason: "aborted",
    });
    expect(projection.completeness).toBe("Partial");
    expect(projection.reason).toBe("aborted");
    // Known components are facts: never replaced by `-`.
    expect(projection.input).toBe("7");
    expect(projection.cacheRead).toBe("1");
    expect(projection.cacheWrite).toBe("0");
    expect(projection.output).toBe("0");
    expect(projection.reasoning).toBe("0");
    // A rate is never inferred from cacheRead alone (Cache Hit is the
    // validated percentage; partial snapshots carry no rate).
    expect(projection.cacheHitRate).toBeUndefined();
    // Validated-only fields stay absent for non-complete snapshots.
    expect(projection.normalizedTotal).toBeUndefined();
  });

  it("keeps the reason and known components for unavailable usage", () => {
    const projection = projectRequestUsage({
      api: "faux",
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      completeness: "unavailable",
      reason: "usage_absent",
    });
    expect(projection.completeness).toBe("Unavailable");
    expect(projection.reason).toBe("usage_absent");
    expect(projection.input).toBe("-");
    expect(projection.cacheRead).toBe("-");
    expect(projection.cacheWrite).toBe("-");
    expect(projection.output).toBe("-");
    expect(projection.normalizedTotal).toBeUndefined();
    expect(projection.cacheHitRate).toBeUndefined();
  });

  it("shows validated numbers and the percentage rate for complete usage", () => {
    const projection = projectRequestUsage(completeUsage());
    expect(projection.present).toBe(true);
    expect(projection.completeness).toBe("Complete");
    expect(projection.input).toBe("5");
    expect(projection.cacheRead).toBe("3");
    expect(projection.cacheWrite).toBe("2");
    expect(projection.output).toBe("100");
    expect(projection.reasoning).toBe("10");
    expect(projection.normalizedTotal).toBe("110");
    // Product Hit is cacheRead / (input + cacheRead), independent of
    // cacheWrite and of the persisted legacy normalized rate.
    expect(projection.cacheHitRate).toBe("37.5%");
  });

  it("renders a validated zero cache-hit rate honestly", () => {
    const projection = projectRequestUsage(
      completeUsage({ input: 5, cacheRead: 0, cacheWrite: 2, cacheHitRate: 0 }),
    );
    expect(projection.cacheHitRate).toBe("0.0%");
  });
});

describe("projectAverageOutputTokensPerSecond", () => {
  it("is unavailable without usage or with Unavailable usage", () => {
    expect(projectAverageOutputTokensPerSecond(record())).toBeUndefined();
    expect(
      projectAverageOutputTokensPerSecond(
        record({
          terminalUsage: {
            ...completeUsage({
              completeness: "unavailable",
              reason: "usage_absent",
              normalizedTotal: undefined,
              cacheHitRate: undefined,
            }),
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("shows the speed from a Partial snapshot's known output component", () => {
    // Worked example: a snapshot is Partial solely because the cache
    // semantics are unreported (component_unreported); its output
    // component is still a known safe count. 100 output tokens over
    // (2000 ms / 1000) = 2 s → 50 tokens/s. This is a single-request
    // display fact — never token-analytics aggregation.
    expect(
      projectAverageOutputTokensPerSecond(
        record({
          terminalUsage: {
            ...completeUsage({
              completeness: "partial",
              reason: "component_unreported",
              normalizedTotal: undefined,
              cacheHitRate: undefined,
            }),
          },
        }),
      ),
    ).toBe(50);
  });

  it("is unavailable when either timing endpoint is missing", () => {
    const base = {
      terminalUsage: completeUsage(),
    };
    expect(
      projectAverageOutputTokensPerSecond(
        record({ ...base, terminalAt: undefined }),
      ),
    ).toBeUndefined();
    expect(
      projectAverageOutputTokensPerSecond(
        record({ ...base, executionStartedAt: undefined }),
      ),
    ).toBeUndefined();
  });

  it("is unavailable for zero or negative durations", () => {
    const base = {
      terminalUsage: completeUsage(),
    };
    // Same-millisecond snapshot: zero duration.
    expect(
      projectAverageOutputTokensPerSecond(
        record({ ...base, terminalAt: 1_700_000_001_000 }),
      ),
    ).toBeUndefined();
    // Mis-ordered snapshot: negative duration.
    expect(
      projectAverageOutputTokensPerSecond(
        record({
          ...base,
          terminalAt: 1_700_000_000_500,
        }),
      ),
    ).toBeUndefined();
  });

  it("computes output / duration in seconds exactly", () => {
    // 100 output tokens over (2000 ms / 1000) = 2 s → 50 tokens/s.
    expect(
      projectAverageOutputTokensPerSecond(
        record({ terminalUsage: completeUsage() }),
      ),
    ).toBe(50);
  });

  it("renders a validated zero output as an honest zero", () => {
    expect(
      projectAverageOutputTokensPerSecond(
        record({
          terminalUsage: completeUsage({ output: 0, normalizedTotal: 10 }),
        }),
      ),
    ).toBe(0);
  });
});

describe("averageOutputSpeedUnavailableReason", () => {
  it("explains when no terminal usage was recorded", () => {
    expect(averageOutputSpeedUnavailableReason(record())).toBe(
      "No terminal usage recorded for this request",
    );
  });

it("keeps the usage reason for Unavailable usage", () => {
    expect(
      averageOutputSpeedUnavailableReason(
        record({
          terminalUsage: {
            ...completeUsage({
              completeness: "unavailable",
              reason: "usage_absent",
              normalizedTotal: undefined,
              cacheHitRate: undefined,
            }),
          },
        }),
      ),
    ).toBe("usage_absent");
  });

  it("is undefined for a Partial snapshot with a known output", () => {
    expect(
      averageOutputSpeedUnavailableReason(
        record({
          terminalUsage: {
            ...completeUsage({
              completeness: "partial",
              reason: "component_unreported",
              normalizedTotal: undefined,
              cacheHitRate: undefined,
            }),
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("names missing timestamps and invalid durations", () => {
    const base = { terminalUsage: completeUsage() };
    expect(
      averageOutputSpeedUnavailableReason(
        record({ ...base, executionStartedAt: undefined }),
      ),
    ).toBe("Timestamps missing");
    expect(
      averageOutputSpeedUnavailableReason(
        record({ ...base, terminalAt: 1_700_000_001_000 }),
      ),
    ).toBe("Invalid duration");
  });

  it("is undefined when the speed is valid", () => {
    expect(
      averageOutputSpeedUnavailableReason(
        record({ terminalUsage: completeUsage() }),
      ),
    ).toBeUndefined();
  });
});

describe("projectRequestLedger list projection", () => {
  it("projects every acceptance field for a full record", () => {
    const projection = projectRequestLedger(
      record({
        terminalUsage: completeUsage(),
        facts: {
          notices: [{ adapter: "anthropic", direction: "request", code: "X", action: "ignore" }],
          attempts: [
            { attempt: 1, classification: "http", stage: "dispatch", status: 429, retryable: true },
            { attempt: 2, classification: "http", stage: "dispatch", status: 200, retryable: false },
          ],
          persistenceWarnings: 1,
        },
      }),
    );
    expect(projection.id).toBe(1);
    expect(projection.requestId).toBe("10000000-0000-4000-8000-000000000001");
    expect(projection.protocolId).toBe("anthropic-messages");
    expect(projection.protocolName).toBe("Anthropic Messages");
    expect(projection.alias).toBe("alpha");
    expect(projection.providerId).toBe("commandcode-private");
    expect(projection.realModelId).toBe("claude-fixture");
    expect(projection.status).toBe("Success");
    expect(projection.clientHttpStatus).toBe(200);
    expect(projection.phase).toBe("terminal-preparation");
    expect(projection.phaseLabel).toBe("Terminal prep");
    expect(projection.acceptedAt).toBe(1_700_000_000_000);
    expect(projection.completedAt).toBe(1_700_000_003_010);
    expect(projection.clientSessionId).toBe(clientSessionId);
    expect(projection.projectDir).toBe("C:\\Users\\fixture\\projects\\alpha");
    expect(projection.duration).toBe("2.0 s");
    expect(projection.speed).toBe("50.0 tokens/s");
    expect(projection.attemptCount).toBe(2);
    expect(projection.noticeCount).toBe(1);
    expect(projection.persistenceWarnings).toBe(1);
  });

  it("renders `-` for missing client values and never leaks the effective session", () => {
    const projection = projectRequestLedger(
      record({
        clientSessionId: undefined,
        effectiveSessionId: undefined,
        projectDir: undefined,
        externalAlias: undefined,
        providerId: undefined,
        realModelId: undefined,
        completedAt: undefined,
      }),
    );
    expect(projection.clientSessionId).toBe("-");
    expect(projection.projectDir).toBe("-");
    expect(projection.alias).toBe("-");
    expect(projection.providerId).toBe("-");
    expect(projection.realModelId).toBe("-");
    expect(projection.completedAt).toBeUndefined();
    expect(projection.duration).toBe("2.0 s");
    expect(projection.speed).toBe("-");
    // The effective identity has no field in the list projection.
    expect("effectiveSessionId" in projection).toBe(false);
  });

  it("projects a running row with its live phase label", () => {
    const projection = projectRequestLedger(
      record({ phase: "execution", outcome: "running", terminalAt: undefined }),
    );
    expect(projection.status).toBe("Running");
    expect(projection.phaseLabel).toBe("Executing");
    expect(projection.duration).toBe("-");
    expect(projection.speed).toBe("-");
  });
});

describe("projectRequestLedgerDetail", () => {
  it("preserves every raw fact under its own field", () => {
    const failure = {
      classification: "http",
      stage: "dispatch",
      messageHash: "ab".repeat(32),
    };
    const detail = projectRequestLedgerDetail(
      record({
        facts: {
          piStopReason: "max_tokens",
          failure,
          notices: [
            {
              adapter: "anthropic",
              direction: "response",
              code: "degraded-field",
              jsonPath: "$.usage",
              action: "degrade",
            },
          ],
          attempts: [
            { attempt: 1, classification: "http", stage: "dispatch", status: 429, retryable: true },
          ],
          persistenceWarnings: 2,
        },
      }),
    );
    expect(detail.outcome).toBe("success");
    expect(detail.phase).toBe("terminal-preparation");
    expect(detail.clientHttpStatus).toBe(200);
    expect(detail.piStopReason).toBe("max_tokens");
    expect(detail.failure).toEqual(failure);
    expect(detail.notices).toHaveLength(1);
    expect(detail.attempts).toHaveLength(1);
    expect(detail.persistenceWarnings).toBe(2);
  });

  it("keeps the effective session identity as its own labeled field", () => {
    const detail = projectRequestLedgerDetail(record());
    expect(detail.effectiveSessionId).toBe(effectiveSessionId);
    expect(detail.clientSessionId).toBe(clientSessionId);
    expect(detail.executionStartedAt).toBe(1_700_000_001_000);
    expect(detail.terminalAt).toBe(1_700_000_003_000);
    expect(detail.executionDurationMs).toBe(2_000);
    expect(detail.totalDurationMs).toBe(3_010);
  });

  it("omits durations when either endpoint is missing", () => {
    const detail = projectRequestLedgerDetail(
      record({ executionStartedAt: undefined, completedAt: undefined }),
    );
    expect(detail.executionDurationMs).toBeUndefined();
    expect(detail.totalDurationMs).toBeUndefined();
  });
});
