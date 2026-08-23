import type { FetchFunction } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDiagnosticsAuthority,
  DiagnosticsUnavailableError,
  type DiagnosticsWorkerFactory,
} from "../../src/diagnostics/authority.js";
import { parseDiagnosticsConfiguration } from "../../src/diagnostics/configuration.js";
import type { DiagnosticsAuthority } from "../../src/diagnostics/index.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";
import { createCommandCodeTestRuntime } from "../support/commandcode-serving.js";

const REQUEST_ID = "70000000-0000-4000-8000-000000000001";
const SESSION_ID = "70000000-0000-4000-8000-000000000002";
const PROBE_REQUEST_ID = "70000000-0000-4000-8000-000000000003";
const FACTORY_CANARY = "diagnostics-worker-construction-canary-07f2c9";

interface HttpSnapshot {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly bodyBase64: string;
  readonly outbound: readonly Readonly<{
    url: string;
    method: string;
    bodyBase64: string;
  }>[];
}

function providerResponse(): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({
        type: "text-delta",
        id: "0",
        text: "worker construction did not interfere",
      }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      }),
      "",
    ].join("\n"),
  );
}

function sortedStableHeaders(
  headers: Headers,
): readonly (readonly [string, string])[] {
  return Array.from(headers.entries())
    .filter(([name]) => name.toLowerCase() !== "date")
    .sort(([left], [right]) => left.localeCompare(right));
}

describe("Diagnostics Worker construction fail-open", () => {
  const roots: string[] = [];
  const authorities: DiagnosticsAuthority[] = [];
  const servers: RunningLuckyTokenHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      authorities.splice(0).map((authority) => authority.close()),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function exchange(
    diagnostics?: DiagnosticsAuthority,
  ): Promise<HttpSnapshot> {
    const outbound: Array<{
      url: string;
      method: string;
      bodyBase64: string;
    }> = [];
    const fetchProvider: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      outbound.push({
        url: request.url,
        method: request.method,
        bodyBase64: Buffer.from(await request.arrayBuffer()).toString("base64"),
      });
      return providerResponse();
    };
    const runtime = createCommandCodeTestRuntime({
      clientApiKey: "fixture-client-key",
      commandCodeApiKey: "fixture-provider-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch: fetchProvider,
      modelId: "claude-fixture",
      createMessageId: () => "msg_worker_construction_fail_open",
      createSessionId: () => SESSION_ID,
      now: () => 1_787_558_400_000,
    });
    const server = await startLuckyTokenHttpServer({
      runtime,
      ...(diagnostics === undefined ? {} : { diagnostics }),
      createRequestId: () => REQUEST_ID,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-client-key",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-fixture",
        max_tokens: 32,
        messages: [
          { role: "user", content: "worker construction must fail open" },
        ],
      }),
    });
    return Object.freeze({
      status: response.status,
      headers: sortedStableHeaders(response.headers),
      bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64"),
      outbound: Object.freeze(outbound.map((entry) => Object.freeze(entry))),
    });
  }

  it("preserves real HTTP serving and exposes typed unavailability when Worker construction throws synchronously", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-diagnostics-worker-construction-"),
    );
    roots.push(root);
    let factoryCalls = 0;
    const throwingFactory: DiagnosticsWorkerFactory = () => {
      factoryCalls += 1;
      throw new Error(FACTORY_CANARY);
    };

    const creation = createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration(
        { directory: root },
        root,
      ),
      workerFactory: throwingFactory,
    });
    await expect(creation).resolves.toBeDefined();
    const authority = await creation;
    authorities.push(authority);
    expect(factoryCalls).toBe(1);

    const observer = authority.begin({
      requestId: PROBE_REQUEST_ID,
      operationCandidate: "pending",
      transport: "in_process",
      method: "POST",
      path: "/v1/messages",
      acceptedAt: 1_787_558_400_000,
      cancellation: { caller: "active", shutdown: "not_bound" },
    });
    expect(observer.requestId).toBe(PROBE_REQUEST_ID);
    expect(() =>
      observer.observe({
        kind: "step_entered",
        stepInstanceId: "worker-construction-probe",
        location: {
          phase: "http_admission",
          step: "worker_construction_probe",
        },
      }),
    ).not.toThrow();
    expect(() => observer.close({ outcome: "success" })).not.toThrow();
    expect(() =>
      authority.observeRuntime({
        level: "critical",
        classification: "diagnostics_storage_unavailable",
        safeMessage: "Diagnostics storage is unavailable",
      }),
    ).not.toThrow();

    const baseline = await exchange();
    const degraded = await exchange(authority);
    expect(degraded).toEqual(baseline);
    expect(degraded.status).toBe(200);
    expect(degraded.headers).toContainEqual([
      "x-luckytoken-request-id",
      REQUEST_ID,
    ]);
    expect(JSON.stringify(degraded)).not.toContain(FACTORY_CANARY);

    const managementFailures = await Promise.all([
      authority.queryRequestJourneys({ limit: 10 }).then(
        () => undefined,
        (error: unknown) => error,
      ),
      authority.getRequestJourney({ requestId: REQUEST_ID }).then(
        () => undefined,
        (error: unknown) => error,
      ),
      authority
        .getRequestArtifact({
          requestId: REQUEST_ID,
          artifactId: "client-request-wire",
          offset: 0,
          limit: 256,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ]);
    for (const failure of managementFailures) {
      expect(failure).toBeInstanceOf(DiagnosticsUnavailableError);
      expect(failure).toMatchObject({
        name: "DiagnosticsUnavailableError",
        code: "diagnostics_unavailable",
        classification: "diagnostics_storage_unavailable",
      });
    }

    await expect(authority.close()).resolves.toBeUndefined();
    authorities.splice(authorities.indexOf(authority), 1);
  });
});
