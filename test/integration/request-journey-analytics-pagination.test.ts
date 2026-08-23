import type {
  AnalyticsOptionsResult,
  AnalyticsResult,
} from "@luckytoken/application-control-plane/control-plane";
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsManagementAuthority,
  type RequestJourneyObserver,
} from "../../src/diagnostics/index.js";
import type {
  DiagnosticsWorkerFactory,
  DiagnosticsWorkerSession,
} from "../../src/diagnostics/authority.js";
import { DIAGNOSTICS_WORKER_SOURCE } from "../../src/diagnostics/worker-program.js";

const T0 = 1_800_100_000_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

interface JourneyFixture {
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly protocol: "anthropic-messages" | "openai-responses";
  readonly providerId?: string;
  readonly modelId?: string;
  readonly clientSessionId?: string;
  readonly profile?: Readonly<{
    profileId: string;
    displayName: string;
  }>;
  readonly workOutcome: "success" | "failed" | "aborted";
  readonly requestOutcome?: "success" | "failed" | "aborted" | "unknown-alias";
  readonly journeyOutcome: "success" | "failed" | "aborted";
  readonly usage?: NormalizedTerminalUsage;
}

function completeUsage(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  reasoning: number,
): NormalizedTerminalUsage {
  const denominator = input + cacheRead + cacheWrite;
  return Object.freeze({
    api: "analytics-pagination",
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

function partialUsage(): NormalizedTerminalUsage {
  return Object.freeze({
    api: "analytics-pagination",
    input: 900,
    cacheRead: 900,
    cacheWrite: 900,
    output: 900,
    completeness: "partial",
    reason: "failed",
  });
}

function appendJourney(
  authority: DiagnosticsManagementAuthority,
  fixture: JourneyFixture,
): void {
  const observer: RequestJourneyObserver = authority.begin({
    requestId: fixture.requestId,
    operationCandidate: "pending",
    transport: "in_process",
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
    stepInstanceId: `${fixture.requestId}:route`,
    completion: "success",
    operation: "model_generation",
    protocol: fixture.protocol,
    location: { phase: "protocol_ingress", step: "resolve_route" },
  });
  if (fixture.providerId !== undefined && fixture.modelId !== undefined) {
    observer.observe({
      kind: "model_resolved",
      providerId: fixture.providerId,
      modelId: fixture.modelId,
      location: {
        phase: "request_resolution",
        step: "resolve_public_model",
      },
    });
  }
  if (fixture.clientSessionId !== undefined) {
    observer.observe({
      kind: "request_identity_established",
      effectiveSessionId: fixture.clientSessionId,
      clientSessionId: fixture.clientSessionId,
      location: {
        phase: "protocol_ingress",
        step: "establish_request_identity",
      },
    });
  }
  if (fixture.profile !== undefined) {
    observer.observe({
      kind: "profile_attributed",
      profileId: fixture.profile.profileId,
      displayName: fixture.profile.displayName,
      location: {
        phase: "lane_request_preparation",
        step: "capture_semantic_profile",
      },
    });
  }
  if (fixture.usage !== undefined) {
    observer.observe({
      kind: "terminal_usage_observed",
      usage: fixture.usage,
      location: {
        phase: "upstream_execution",
        step: "normalize_terminal_usage",
      },
    });
  }
  observer.observe({
    kind: "work_outcome_committed",
    outcome: fixture.workOutcome,
    ...(fixture.requestOutcome === undefined
      ? {}
      : { requestOutcome: fixture.requestOutcome }),
    terminalAuthority: "pagination_fixture",
    location: { phase: "outcome_commit", step: "commit_request_outcome" },
  });
  observer.close({ outcome: fixture.journeyOutcome });
}

function twoRowAnalyticsPageWorkerFactory(): DiagnosticsWorkerFactory {
  return (input): DiagnosticsWorkerSession => {
    const worker = new Worker(input.source, {
      eval: true,
      workerData: { ...input.workerData, analyticsPageSize: 2 },
    });
    return Object.freeze({
      postMessage: (message: object) => worker.postMessage(message),
      onMessage: (listener: (message: unknown) => void) =>
        worker.on("message", listener),
      onError: (listener: (error: Error) => void) => worker.on("error", listener),
      onExit: (listener: (code: number) => void) => worker.on("exit", listener),
      terminate: () => worker.terminate(),
    });
  };
}

function summary(result: Awaited<ReturnType<DiagnosticsManagementAuthority["getAnalytics"]>>): AnalyticsResult {
  expect(result.command).toBe("summary");
  if (result.command !== "summary") throw new Error("expected analytics summary");
  return result;
}

function options(result: Awaited<ReturnType<DiagnosticsManagementAuthority["getAnalytics"]>>): AnalyticsOptionsResult {
  expect(result.command).toBe("options");
  if (result.command !== "options") throw new Error("expected analytics options");
  return result;
}

describe("Request Journey analytics bounded pagination", () => {
  it("aggregates and sorts incrementally across Worker pages without retaining all Journey rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-analytics-pages-"));
    let authority: DiagnosticsManagementAuthority | undefined;
    try {
      authority = await createDiagnosticsAuthority({
        configuration: parseDiagnosticsConfiguration({ directory: root }, root),
        runtimeId: "57000000-0000-4000-8000-000000000001",
        now: () => T0,
        workerFactory: twoRowAnalyticsPageWorkerFactory(),
      });
      const fixtures: readonly JourneyFixture[] = [
        {
          requestId: "57000000-0000-4000-8000-000000000002",
          acceptedAt: T0,
          protocol: "anthropic-messages",
          providerId: "anthropic",
          modelId: "claude-x",
          clientSessionId: "session-b",
          profile: { profileId: "profile-shared", displayName: "Old Name" },
          workOutcome: "success",
          requestOutcome: "success",
          journeyOutcome: "success",
          usage: completeUsage(2, 1, 0, 1, 0),
        },
        {
          requestId: "57000000-0000-4000-8000-000000000003",
          acceptedAt: T0 + 30 * MINUTE,
          protocol: "openai-responses",
          providerId: "openai",
          modelId: "gpt-x",
          clientSessionId: "session-a",
          workOutcome: "failed",
          requestOutcome: "failed",
          journeyOutcome: "failed",
          usage: partialUsage(),
        },
        {
          requestId: "57000000-0000-4000-8000-000000000004",
          acceptedAt: T0 + HOUR,
          protocol: "anthropic-messages",
          providerId: "anthropic",
          modelId: "claude-x",
          clientSessionId: "session-b",
          profile: {
            profileId: "profile-shared",
            displayName: "Current Name",
          },
          workOutcome: "success",
          requestOutcome: "success",
          journeyOutcome: "success",
          usage: completeUsage(3, 0, 1, 2, 1),
        },
        {
          requestId: "57000000-0000-4000-8000-000000000005",
          acceptedAt: T0 + HOUR + 30 * MINUTE,
          protocol: "openai-responses",
          workOutcome: "failed",
          requestOutcome: "unknown-alias",
          journeyOutcome: "failed",
        },
        {
          requestId: "57000000-0000-4000-8000-000000000006",
          acceptedAt: T0 + HOUR + 45 * MINUTE,
          protocol: "openai-responses",
          providerId: "openai",
          modelId: "gpt-x",
          clientSessionId: "session-a",
          workOutcome: "aborted",
          requestOutcome: "aborted",
          journeyOutcome: "aborted",
        },
      ];
      for (const fixture of fixtures) appendJourney(authority, fixture);
      await authority.queryRequestJourneys({ limit: 10 });

      const result = summary(
        await authority.getAnalytics({
          version: 2,
          command: "summary",
          from: T0,
          to: T0 + 2 * HOUR,
          groupBy: "provider",
          series: { granularity: "hour" },
        }),
      );
      expect(result.totals).toMatchObject({
        total: 5,
        success: 2,
        failed: 1,
        aborted: 1,
        other: 1,
        participating: 2,
        excluded: 3,
        inputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
        outputTokens: 3,
        reasoningTokens: 1,
        normalizedTokenTotal: 10,
        cacheHitNumerator: 1,
        cacheHitDenominator: 6,
      });
      expect(result.rows?.map((row) => [
        row.value,
        row.summary.total,
        row.summary.success,
        row.summary.failed,
        row.summary.aborted,
        row.summary.other,
      ])).toEqual([
        ["anthropic", 2, 2, 0, 0, 0],
        ["openai", 2, 0, 1, 1, 0],
        [null, 1, 0, 0, 0, 1],
      ]);
      expect(result.buckets?.map((bucket) => bucket.summary.total)).toEqual([
        2,
        3,
      ]);

      const optionResult = options(
        await authority.getAnalytics({
          version: 2,
          command: "options",
          from: T0,
          to: T0 + 2 * HOUR,
        }),
      );
      expect(optionResult).toMatchObject({
        providers: ["anthropic", "openai"],
        profiles: [
          {
            profileId: "profile-shared",
            displayName: "Current Name",
            providerId: "anthropic",
          },
        ],
        models: ["claude-x", "gpt-x"],
        protocols: ["anthropic-messages", "openai-responses"],
        sessions: ["session-a", "session-b"],
        outcomes: ["aborted", "failed", "success", "unknown-alias"],
      });
      expect(DIAGNOSTICS_WORKER_SOURCE).not.toMatch(
        /rows\.push\(\.\.\.page\)/u,
      );
    } finally {
      await authority?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
