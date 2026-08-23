import type {
  AnalyticsOptionsResult,
  AnalyticsQuery,
  AnalyticsQueryResult,
  AnalyticsResult,
} from "@luckytoken/application-control-plane/control-plane";
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
  type RequestJourneyLocation,
  type RequestJourneyObserver,
} from "../../src/diagnostics/index.js";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const at = (hours: number, minutes = 0): number =>
  T0 + hours * HOUR + minutes * MINUTE;

const SESSION_ALPHA = "81000000-0000-4000-8000-000000000001";
const SESSION_BETA = "81000000-0000-4000-8000-000000000002";

type FixtureOutcome =
  | "success"
  | "failed"
  | "aborted"
  | "unknown-alias";

interface FutureModelResolvedObservation {
  readonly kind: "model_resolved";
  readonly providerId: string;
  readonly modelId: string;
  readonly location: RequestJourneyLocation;
}

interface FutureRequestIdentityObservation {
  readonly kind: "request_identity_established";
  readonly effectiveSessionId: string;
  readonly clientSessionId?: string;
  readonly location: RequestJourneyLocation;
}

interface FutureProfileAttributedObservation {
  readonly kind: "profile_attributed";
  readonly profileId: string;
  readonly displayName: string;
  readonly location: RequestJourneyLocation;
}

interface FutureTerminalUsageObservation {
  readonly kind: "terminal_usage_observed";
  readonly usage: NormalizedTerminalUsage;
  readonly location: RequestJourneyLocation;
}

interface FutureWorkOutcomeObservation {
  readonly kind: "work_outcome_committed";
  readonly outcome: "success" | "failed" | "aborted";
  readonly requestOutcome?: FixtureOutcome;
  readonly terminalAuthority: string;
  readonly location: RequestJourneyLocation;
}

type FutureObservation =
  | FutureModelResolvedObservation
  | FutureRequestIdentityObservation
  | FutureProfileAttributedObservation
  | FutureTerminalUsageObservation
  | FutureWorkOutcomeObservation;

interface FutureJourneyObserver {
  observe(input: FutureObservation): void;
}

interface FutureAnalyticsAuthority {
  getAnalytics(query: AnalyticsQuery): Promise<AnalyticsQueryResult>;
}

interface FixtureJourney {
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly protocol: "anthropic-messages" | "openai-responses";
  readonly lane?: "local_native" | "provider_native" | "semantic_conversion";
  readonly providerId?: string;
  readonly modelId?: string;
  readonly clientSessionId?: string;
  readonly profile?: {
    readonly profileId: string;
    readonly displayName: string;
  };
  readonly workOutcome: "success" | "failed" | "aborted";
  readonly requestOutcome?: FixtureOutcome;
  readonly journeyOutcome: "success" | "failed" | "aborted";
  readonly usage?: NormalizedTerminalUsage;
  readonly executionDurationMs?: number;
}

function completeUsage(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  reasoning: number,
  api: string,
): NormalizedTerminalUsage {
  const denominator = input + cacheRead + cacheWrite;
  return Object.freeze({
    api,
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    normalizedTotal: input + cacheRead + cacheWrite + output,
    ...(denominator === 0
      ? {}
      : { cacheHitRate: cacheRead / denominator }),
    completeness: "complete",
  });
}

function partialUsage(
  input: number,
  cacheRead: number,
  output: number,
  reason: "failed" | "aborted",
  api: string,
): NormalizedTerminalUsage {
  return Object.freeze({
    api,
    input,
    cacheRead,
    cacheWrite: 0,
    output,
    completeness: "partial",
    reason,
  });
}

function futureObserver(observer: RequestJourneyObserver): FutureJourneyObserver {
  return observer as unknown as FutureJourneyObserver;
}

function requireSummary(result: AnalyticsQueryResult): AnalyticsResult {
  expect(result.command).toBe("summary");
  if (result.command !== "summary") {
    throw new Error("test misuse: expected analytics summary");
  }
  return result;
}

function requireOptions(result: AnalyticsQueryResult): AnalyticsOptionsResult {
  expect(result.command).toBe("options");
  if (result.command !== "options") {
    throw new Error("test misuse: expected analytics options");
  }
  return result;
}

/**
 * Independent worked fixture for [10:00, 15:00):
 *
 *  A 10:00 anthropic/claude-x semantic success, Complete (5,3,2,2,r1),
 *    execution 120s, but the overall Journey later fails Client rendering.
 *  B 11:30 anthropic/claude-x provider-native failed, Partial, execution 30s.
 *  C 12:00 commandcode-private/cc-mini local success, Complete (4,0,0,3,r0),
 *    execution 60s.
 *  D 13:00 openai/gpt-r semantic aborted, Partial, execution 45s.
 *  E 14:00 unresolved OpenAI request, unknown-alias, no execution/usage.
 *  F 15:00 is exactly the exclusive upper bound and must not participate.
 *
 * Therefore totals are 5 requests: success=2, failed=1, aborted=1, other=1;
 * Complete usage sums are input=9, cacheRead=3, cacheWrite=2, output=5,
 * reasoning=1, normalized=19; cache hit is 3/(9+3)=0.25 and throughput is
 * 5 output / (120+60)s.
 */
describe("Request Journey Worker analytics projection", () => {
  it("aggregates typed Journey facts without the legacy Request Ledger store", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-journey-analytics-"));
    let authority: DiagnosticsAuthority | undefined;
    let clock = 100_000;

    const appendJourney = (fixture: FixtureJourney): void => {
      if (authority === undefined) throw new Error("test authority is unavailable");
      clock += 10;
      const observer = authority.begin({
        requestId: fixture.requestId,
        operationCandidate: "pending",
        transport: "http",
        method: "POST",
        path:
          fixture.protocol === "anthropic-messages"
            ? "/v1/messages"
            : "/v1/responses",
        acceptedAt: fixture.acceptedAt,
        cancellation: { caller: "active", shutdown: "not_bound" },
      });
      observer.observe({
        kind: "step_completed",
        stepInstanceId: `${fixture.requestId}:resolve_route`,
        completion: "success",
        operation: "model_generation",
        protocol: fixture.protocol,
        location: { phase: "protocol_ingress", step: "resolve_route" },
      });
      const next = futureObserver(observer);
      if (fixture.clientSessionId !== undefined) {
        next.observe({
          kind: "request_identity_established",
          effectiveSessionId: fixture.clientSessionId,
          clientSessionId: fixture.clientSessionId,
          location: {
            phase: "protocol_ingress",
            step: "establish_request_identity",
          },
        });
      }
      if (fixture.providerId !== undefined && fixture.modelId !== undefined) {
        next.observe({
          kind: "model_resolved",
          providerId: fixture.providerId,
          modelId: fixture.modelId,
          location: {
            phase: "request_resolution",
            step:
              fixture.lane === "local_native"
                ? "recognize_local_model"
                : "resolve_public_model",
            ...(fixture.lane === "local_native"
              ? { lane: "local_native" as const }
              : {}),
          },
        });
      }
      if (fixture.lane !== undefined) {
        observer.observe({
          kind: "lane_committed",
          lane: fixture.lane,
          location: {
            phase: "request_resolution",
            lane: fixture.lane,
            step: "commit_lane",
          },
        });
      }
      if (fixture.profile !== undefined && fixture.lane !== undefined) {
        next.observe({
          kind: "profile_attributed",
          profileId: fixture.profile.profileId,
          displayName: fixture.profile.displayName,
          location: {
            phase: "lane_request_preparation",
            lane: fixture.lane,
            step:
              fixture.lane === "local_native"
                ? "resolve_local_credential"
                : fixture.lane === "provider_native"
                  ? "capture_provider_profile"
                  : "capture_semantic_profile",
            attempt: 1,
          },
        });
      }
      if (
        fixture.executionDurationMs !== undefined &&
        fixture.lane !== undefined
      ) {
        clock += 10;
        observer.observe({
          kind: "step_entered",
          stepInstanceId: `${fixture.requestId}:execution`,
          location: {
            phase: "upstream_execution",
            lane: fixture.lane,
            step:
              fixture.lane === "local_native"
                ? "dispatch_local_transport"
                : fixture.lane === "provider_native"
                  ? "dispatch_provider_native"
                  : "create_pi_stream",
          },
        });
        clock += fixture.executionDurationMs;
      }
      if (fixture.usage !== undefined && fixture.lane !== undefined) {
        next.observe({
          kind: "terminal_usage_observed",
          usage: fixture.usage,
          location: {
            phase:
              fixture.lane === "semantic_conversion"
                ? "upstream_execution"
                : "lane_response_processing",
            lane: fixture.lane,
            step:
              fixture.lane === "semantic_conversion"
                ? "normalize_terminal_usage"
                : fixture.lane === "local_native"
                  ? "observe_local_usage"
                  : "observe_provider_native_usage",
            subject: "usage",
          },
        });
      }
      const outcomeLocation: RequestJourneyLocation = {
        phase: "outcome_commit",
        ...(fixture.lane === undefined ? {} : { lane: fixture.lane }),
        step: "commit_request_outcome",
      };
      next.observe({
        kind: "work_outcome_committed",
        outcome: fixture.workOutcome,
        ...(fixture.requestOutcome === undefined
          ? {}
          : { requestOutcome: fixture.requestOutcome }),
        terminalAuthority:
          fixture.lane === "semantic_conversion"
            ? "pi_execution"
            : fixture.lane === undefined
              ? "request_resolution"
              : `${fixture.lane}_lane`,
        location: outcomeLocation,
      });
      clock += 1;
      observer.close({
        outcome: fixture.journeyOutcome,
        lastKnownLocation: {
          phase: "http_handoff",
          step: "write_http_response",
        },
      });
    };

    try {
      authority = await createDiagnosticsAuthority({
        configuration: parseDiagnosticsConfiguration(
          { directory: join(root, "diagnostics") },
          root,
        ),
        now: () => clock,
      });

      // Submit B before A so Profile option selection must use acceptedAt,
      // not record id or append order.
      appendJourney({
        requestId: "82000000-0000-4000-8000-000000000002",
        acceptedAt: at(11, 30),
        protocol: "anthropic-messages",
        lane: "provider_native",
        providerId: "anthropic",
        modelId: "claude-x",
        clientSessionId: SESSION_ALPHA,
        profile: {
          profileId: "profile-anthropic",
          displayName: "Anthropic Current",
        },
        workOutcome: "failed",
        journeyOutcome: "failed",
        usage: partialUsage(7, 1, 0, "failed", "anthropic-messages"),
        executionDurationMs: 30_000,
      });
      appendJourney({
        requestId: "82000000-0000-4000-8000-000000000001",
        acceptedAt: at(10),
        protocol: "anthropic-messages",
        lane: "semantic_conversion",
        providerId: "anthropic",
        modelId: "claude-x",
        clientSessionId: SESSION_ALPHA,
        profile: {
          profileId: "profile-anthropic",
          displayName: "Anthropic Old",
        },
        workOutcome: "success",
        requestOutcome: "success",
        // A later Client rendering failure must not rewrite Pi work success.
        journeyOutcome: "failed",
        usage: completeUsage(5, 3, 2, 2, 1, "anthropic-messages"),
        executionDurationMs: 120_000,
      });
      appendJourney({
        requestId: "82000000-0000-4000-8000-000000000003",
        acceptedAt: at(12),
        protocol: "anthropic-messages",
        lane: "local_native",
        providerId: "commandcode-private",
        modelId: "cc-mini",
        clientSessionId: SESSION_BETA,
        workOutcome: "success",
        journeyOutcome: "success",
        usage: completeUsage(4, 0, 0, 3, 0, "local-responses"),
        executionDurationMs: 60_000,
      });
      appendJourney({
        requestId: "82000000-0000-4000-8000-000000000004",
        acceptedAt: at(13),
        protocol: "openai-responses",
        lane: "semantic_conversion",
        providerId: "openai",
        modelId: "gpt-r",
        clientSessionId: SESSION_BETA,
        profile: {
          profileId: "profile-openai",
          displayName: "OpenAI Production",
        },
        workOutcome: "aborted",
        journeyOutcome: "aborted",
        usage: partialUsage(2, 1, 0, "aborted", "responses"),
        executionDurationMs: 45_000,
      });
      appendJourney({
        requestId: "82000000-0000-4000-8000-000000000005",
        acceptedAt: at(14),
        protocol: "openai-responses",
        workOutcome: "failed",
        requestOutcome: "unknown-alias",
        journeyOutcome: "failed",
      });
      appendJourney({
        requestId: "82000000-0000-4000-8000-000000000006",
        acceptedAt: at(15),
        protocol: "openai-responses",
        lane: "semantic_conversion",
        providerId: "boundary-provider",
        modelId: "boundary-model",
        clientSessionId: SESSION_ALPHA,
        workOutcome: "success",
        journeyOutcome: "success",
        usage: completeUsage(900, 900, 900, 900, 900, "boundary"),
        executionDurationMs: 1,
      });

      const analytics = authority as unknown as FutureAnalyticsAuthority;
      const range = { from: at(10), to: at(15) } as const;
      const totalsResult = requireSummary(
        await analytics.getAnalytics({
          version: 2,
          command: "summary",
          ...range,
          series: { granularity: "hour" },
        }),
      );
      const { outputTokensPerSecond, ...stableTotals } = totalsResult.totals;
      expect(stableTotals).toEqual({
        total: 5,
        success: 2,
        failed: 1,
        aborted: 1,
        other: 1,
        pending: 0,
        successRate: 0.4,
        failureRate: 0.2,
        abortRate: 0.2,
        participating: 2,
        totalRequests: 5,
        excluded: 3,
        inputTokens: 9,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        outputTokens: 5,
        reasoningTokens: 1,
        normalizedTokenTotal: 19,
        cacheHitNumerator: 3,
        cacheHitDenominator: 12,
        cacheHitRate: 0.25,
      });
      expect(outputTokensPerSecond).toBeCloseTo(5 / 180, 12);
      expect(totalsResult.buckets?.map((bucket) => ({
        start: bucket.start,
        end: bucket.end,
        total: bucket.summary.total,
      }))).toEqual([
        { start: at(10), end: at(11), total: 1 },
        { start: at(11), end: at(12), total: 1 },
        { start: at(12), end: at(13), total: 1 },
        { start: at(13), end: at(14), total: 1 },
        { start: at(14), end: at(15), total: 1 },
      ]);

      const provider = requireSummary(
        await analytics.getAnalytics({
          version: 2,
          command: "summary",
          ...range,
          groupBy: "provider",
        }),
      );
      expect(provider.rows?.map((row) => ({
        value: row.value,
        total: row.summary.total,
        success: row.summary.success,
        failed: row.summary.failed,
        aborted: row.summary.aborted,
        other: row.summary.other,
      }))).toEqual([
        {
          value: "anthropic",
          total: 2,
          success: 1,
          failed: 1,
          aborted: 0,
          other: 0,
        },
        {
          value: "commandcode-private",
          total: 1,
          success: 1,
          failed: 0,
          aborted: 0,
          other: 0,
        },
        {
          value: "openai",
          total: 1,
          success: 0,
          failed: 0,
          aborted: 1,
          other: 0,
        },
        {
          value: null,
          total: 1,
          success: 0,
          failed: 0,
          aborted: 0,
          other: 1,
        },
      ]);

      const model = requireSummary(
        await analytics.getAnalytics({
          version: 2,
          command: "summary",
          ...range,
          groupBy: "model",
        }),
      );
      expect(model.rows?.map((row) => [row.value, row.summary.total])).toEqual([
        ["claude-x", 2],
        ["cc-mini", 1],
        ["gpt-r", 1],
        [null, 1],
      ]);

      const protocol = requireSummary(
        await analytics.getAnalytics({
          version: 2,
          command: "summary",
          ...range,
          groupBy: "protocol",
        }),
      );
      expect(protocol.rows?.map((row) => ({
        value: row.value,
        total: row.summary.total,
        success: row.summary.success,
        failed: row.summary.failed,
        aborted: row.summary.aborted,
        other: row.summary.other,
      }))).toEqual([
        {
          value: "anthropic-messages",
          total: 3,
          success: 2,
          failed: 1,
          aborted: 0,
          other: 0,
        },
        {
          value: "openai-responses",
          total: 2,
          success: 0,
          failed: 0,
          aborted: 1,
          other: 1,
        },
      ]);

      const outcome = requireSummary(
        await analytics.getAnalytics({
          version: 2,
          command: "summary",
          ...range,
          groupBy: "outcome",
        }),
      );
      expect(outcome.rows?.map((row) => [row.value, row.summary.total])).toEqual([
        ["success", 2],
        ["aborted", 1],
        ["failed", 1],
        ["unknown-alias", 1],
      ]);

      const session = requireSummary(
        await analytics.getAnalytics({
          version: 2,
          command: "summary",
          ...range,
          filters: { sessions: [SESSION_ALPHA] },
        }),
      );
      expect(session.totals).toMatchObject({
        total: 2,
        success: 1,
        failed: 1,
        participating: 1,
        excluded: 1,
        inputTokens: 5,
        outputTokens: 2,
      });

      const options = requireOptions(
        await analytics.getAnalytics({
          version: 2,
          command: "options",
          ...range,
        }),
      );
      expect(options).toEqual({
        version: 2,
        command: "options",
        providers: ["anthropic", "commandcode-private", "openai"],
        profiles: [
          {
            profileId: "profile-anthropic",
            displayName: "Anthropic Current",
            providerId: "anthropic",
          },
          {
            profileId: "profile-openai",
            displayName: "OpenAI Production",
            providerId: "openai",
          },
        ],
        models: ["cc-mini", "claude-x", "gpt-r"],
        protocols: ["anthropic-messages", "openai-responses"],
        sessions: [SESSION_ALPHA, SESSION_BETA],
        outcomes: ["aborted", "failed", "success", "unknown-alias"],
      });
    } finally {
      await authority?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
