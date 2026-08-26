import type { Models } from "@earendil-works/pi-ai";
import type { AnalyticsResult } from "@token/application-control-plane/control-plane";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  CodexDirectFetch,
  CodexDirectModelSource,
} from "../../src/codex-direct-seam.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsManagementAuthority,
} from "../../src/diagnostics/index.js";
import type { ExecutionOperation } from "../../src/execution.js";
import { createCodexDirectResponsesLane } from "../../src/integrations/codex/direct-responses.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "87000000-0000-4000-8000-000000000001";
const SESSION_ID = "87000000-0000-4000-8000-000000000002";
const UPSTREAM_RESPONSE_BODY = JSON.stringify({
  id: "resp_direct_usage",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "gpt-native",
  output: [
    {
      type: "message",
      id: "msg_direct_usage",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "native answer", annotations: [] },
      ],
    },
  ],
  usage: {
    input_tokens: 13,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 18,
  },
});

interface WireSnapshot {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface RunResult {
  readonly response: Omit<WireSnapshot, "url" | "method"> & {
    readonly status: number;
  };
  readonly outbound: readonly WireSnapshot[];
  readonly analytics?: AnalyticsResult;
}

function sortedHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...headers.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function stableResponseHeaders(
  headers: Headers,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...headers.entries()]
      .filter(([name]) => name !== "date")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function requireSummary(
  result: Awaited<ReturnType<DiagnosticsManagementAuthority["getAnalytics"]>>,
): AnalyticsResult {
  if (result.command !== "summary") {
    throw new Error("Expected a diagnostics analytics summary");
  }
  return result;
}

describe("Direct Mode terminal usage analytics producer", () => {
  it("projects terminal usage without changing the served or outbound wire", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-direct-mode-analytics-"),
    );

    async function run(
      mode: "disabled" | "enabled",
    ): Promise<RunResult> {
      const runRoot = join(root, mode);
      let authority: DiagnosticsManagementAuthority | undefined;
      let server: RunningTokenHttpServer | undefined;
      let unsubscribe: (() => void) | undefined;
      let clock = 1_000;
      const outbound: WireSnapshot[] = [];

      try {
        if (mode === "enabled") {
          authority = await createDiagnosticsAuthority({
            configuration: parseDiagnosticsConfiguration(
              { directory: join(runRoot, "diagnostics") },
              runRoot,
            ),
            now: () => clock,
          });
        }

        let resolveDurableJourney!: () => void;
        const durableJourney = new Promise<void>((resolve) => {
          resolveDurableJourney = resolve;
        });
        if (authority !== undefined) {
          const subscription = authority.subscribeRequestJourneys((record) => {
            if (record.requestId === REQUEST_ID) resolveDurableJourney();
          });
          unsubscribe = () => subscription.unsubscribe();
        }

        const piModels = new Proxy({} as Models, {
          get() {
            throw new Error("Pi Models must not be touched by Direct Mode");
          },
        });
        const semanticExecution = vi.fn(async () => {
          throw new Error("Semantic Conversion must not execute");
        }) as unknown as ExecutionOperation;
        const directModels: CodexDirectModelSource = Object.freeze({
          has: (modelId: string) => modelId === "gpt-native",
        });
        const directFetch: CodexDirectFetch = async (input, init) => {
          const request = new Request(input, init);
          outbound.push({
            url: request.url,
            method: request.method,
            headers: sortedHeaders(request.headers),
            body: await request.text(),
          });
          clock = 2_000;
          return new Response(UPSTREAM_RESPONSE_BODY, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        };
        const handler = createOpenAIResponsesHandler({
          models: piModels,
          directLane: createCodexDirectResponsesLane({
            models: directModels,
            fetch: directFetch,
          }),
          executeOperation: semanticExecution,
          stateFile: join(runRoot, "responses-state.json"),
          maxRequestBytes: 4_096,
          createSessionId: () => SESSION_ID,
        });
        const runtime = createTokenRuntime({ clientProtocols: [handler] });
        server = await startTokenHttpServer({
          runtime,
          ...(authority === undefined ? {} : { diagnostics: authority }),
          createRequestId: () => REQUEST_ID,
          port: 0,
        });

        const requestBody = JSON.stringify({
          model: "gpt-native",
          input: "measure Direct Mode usage",
        });
        const response = await fetch(`${server.origin}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer client-token",
            "content-type": "application/json",
            "x-client-request-id": SESSION_ID,
          },
          body: requestBody,
        });
        const responseBody = await response.text();

        let analytics: AnalyticsResult | undefined;
        if (authority !== undefined) {
          await durableJourney;
          analytics = requireSummary(
            await authority.getAnalytics({
              version: 3,
              command: "summary",
              from: 0,
              to: Number.MAX_SAFE_INTEGER,
            }),
          );
        }

        expect(semanticExecution).not.toHaveBeenCalled();
        return {
          response: {
            status: response.status,
            headers: stableResponseHeaders(response.headers),
            body: responseBody,
          },
          outbound,
          ...(analytics === undefined ? {} : { analytics }),
        };
      } finally {
        unsubscribe?.();
        await server?.close();
        await authority?.close();
      }
    }

    try {
      const disabled = await run("disabled");
      const enabled = await run("enabled");

      expect(enabled.response).toEqual(disabled.response);
      expect(enabled.outbound).toEqual(disabled.outbound);
      expect(enabled.response).toMatchObject({
        status: 200,
        headers: {
          "content-length": String(Buffer.byteLength(UPSTREAM_RESPONSE_BODY)),
          "content-type": "application/json",
        },
        body: UPSTREAM_RESPONSE_BODY,
      });
      expect(enabled.response.headers).not.toHaveProperty("x-token-request-id");
      expect(enabled.analytics?.totals).toMatchObject({
        total: 1,
        success: 1,
        usageRequests: 1,
        missingUsageRequests: 0,
        speedRequests: 1,
        inputTokens: 8,
        cacheReadTokens: 3,
        outputTokens: 5,
        cacheHitRate: 3 / 11,
        outputTokensPerSecond: 5,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
