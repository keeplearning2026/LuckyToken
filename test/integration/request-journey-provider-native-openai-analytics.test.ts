import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import type { AnalyticsResult } from "@luckytoken/application-control-plane/control-plane";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsManagementAuthority,
} from "../../src/diagnostics/index.js";
import type { ExecutionOperation } from "../../src/execution.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "88000000-0000-4000-8000-000000000001";
const SESSION_ID = "88000000-0000-4000-8000-000000000002";
const PROFILE_ID = "openai-profile-usage";
const PROVIDER_TOKEN = "provider-openai-token-usage-canary";
const CLIENT_TOKEN = "client-openai-token-usage-canary";
const UPSTREAM_RESPONSE_BODY = JSON.stringify({
  id: "resp_provider_native_usage",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "gpt-native",
  output: [
    {
      type: "message",
      id: "msg_provider_native_usage",
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

interface ProviderRunFacts {
  readonly bindingEvents: readonly string[];
  readonly modelEvents: readonly string[];
  readonly semanticExecutionCount: number;
}

interface RunResult {
  readonly response: Omit<WireSnapshot, "url" | "method"> & {
    readonly status: number;
  };
  readonly outbound: readonly WireSnapshot[];
  readonly provider: ProviderRunFacts;
  readonly analytics?: AnalyticsResult;
}

interface ActiveUpstreamRun {
  readonly outbound: WireSnapshot[];
  readonly responseStarted: () => void;
}

function sortedNodeHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | readonly string[]] =>
        entry[1] !== undefined
      )
      .map(([name, value]) => [
        name,
        typeof value === "string" ? value : value.join(", "),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
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

function openAIModel(upstreamOrigin: string): Model<string> {
  return {
    id: "gpt-native",
    name: "GPT Native",
    api: "openai-responses",
    provider: "openai",
    baseUrl: `${upstreamOrigin}/v1`,
    headers: { "x-provider-static": "provider-owned" },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function requireSummary(
  result: Awaited<ReturnType<DiagnosticsManagementAuthority["getAnalytics"]>>,
): AnalyticsResult {
  if (result.command !== "summary") {
    throw new Error("Expected a diagnostics analytics summary");
  }
  return result;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

describe("Provider Native OpenAI Responses terminal usage analytics producer", () => {
  it("publishes confirmed upstream usage without changing wire, attempts, Profile, or result", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-provider-native-openai-analytics-"),
    );
    let activeRun: ActiveUpstreamRun | undefined;
    const upstreamServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const run = activeRun;
      if (run === undefined) {
        response.writeHead(503).end();
        return;
      }
      run.outbound.push({
        url: `http://${request.headers.host}${request.url ?? ""}`,
        method: request.method ?? "",
        headers: sortedNodeHeaders(request.headers),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      run.responseStarted();
      response.writeHead(200, {
        "content-length": String(Buffer.byteLength(UPSTREAM_RESPONSE_BODY)),
        "content-type": "application/json",
        "request-id": "provider-success-request",
      });
      response.end(UPSTREAM_RESPONSE_BODY);
    });

    try {
      const upstreamOrigin = await listen(upstreamServer);

      async function run(mode: "disabled" | "enabled"): Promise<RunResult> {
        const runRoot = join(root, mode);
        let authority: DiagnosticsManagementAuthority | undefined;
        let server: RunningLuckyTokenHttpServer | undefined;
        let unsubscribe: (() => void) | undefined;
        let clock = 1_000;
        const outbound: WireSnapshot[] = [];
        const bindingEvents: string[] = [];
        const modelEvents: string[] = [];

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

          activeRun = {
            outbound,
            responseStarted: () => {
              clock = 2_000;
            },
          };
          const model = openAIModel(upstreamOrigin);
          const capture: ProviderAuthBindingCapture = Object.freeze({
            facts: Object.freeze({
              kind: "managed" as const,
              providerId: "openai",
              credentialId: PROFILE_ID,
              authType: "api_key" as const,
              authMethodLabel: "API key",
              displayName: "OpenAI Usage Profile",
              credentialGeneration: "credential-generation:usage",
              selectionGeneration: "selection-generation:usage",
            }),
          });
          const bindings: Pick<
            ProviderAuthBindingAuthority,
            "capture" | "runBound" | "advanceAfterFinal429"
          > = Object.freeze({
            capture: async (providerId: string) => {
              bindingEvents.push(`capture:${providerId}`);
              return capture;
            },
            runBound: async <T>(
              boundCapture: ProviderAuthBindingCapture,
              operation: () => Promise<T>,
            ): Promise<T> => {
              bindingEvents.push(
                `runBound:${boundCapture.facts.kind === "managed"
                  ? boundCapture.facts.credentialId
                  : "environment"}`,
              );
              return operation();
            },
            advanceAfterFinal429: async () => {
              bindingEvents.push("advanceAfterFinal429");
              throw new Error("A successful response must not advance Profile");
            },
          });
          const models = new Proxy({} as Models, {
            get(_target, property) {
              if (property === "getModels") {
                return () => {
                  modelEvents.push("getModels");
                  return [model];
                };
              }
              if (property === "getAuth") {
                return async () => {
                  modelEvents.push("getAuth");
                  return {
                    auth: { apiKey: PROVIDER_TOKEN },
                    source: "fixture",
                  };
                };
              }
              throw new Error(
                `Unexpected Pi Models capability: ${String(property)}`,
              );
            },
          });
          const semanticExecutionSpy = vi.fn(async () => {
            throw new Error("Semantic Conversion must not execute");
          });
          const semanticExecution =
            semanticExecutionSpy as unknown as ExecutionOperation;
          const providerNativeLane = createProviderNativeResponses({
            models,
            bindings,
            fetch: globalThis.fetch as FetchFunction,
          });
          const handler = createOpenAIResponsesHandler({
            models,
            providerNativeLane,
            executeOperation: semanticExecution,
            stateFile: join(runRoot, "responses-state.json"),
            maxRequestBytes: 4_096,
            createSessionId: () => SESSION_ID,
          });
          const runtime = createLuckyTokenRuntime({ clientProtocols: [handler] });
          server = await startLuckyTokenHttpServer({
            runtime,
            ...(authority === undefined ? {} : { diagnostics: authority }),
            createRequestId: () => REQUEST_ID,
            port: 0,
          });

          const requestBody = JSON.stringify({
            model: "openai/gpt-native",
            input: "measure provider native usage",
            store: false,
          });
          const response = await fetch(`${server.origin}/v1/responses`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${CLIENT_TOKEN}`,
              cookie: "client-cookie-must-not-forward",
              "content-type": "application/json",
              "x-client-request-id": SESSION_ID,
              "x-provider-static": "client-must-not-win",
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

          return {
            response: {
              status: response.status,
              headers: stableResponseHeaders(response.headers),
              body: responseBody,
            },
            outbound,
            provider: {
              bindingEvents,
              modelEvents,
              semanticExecutionCount: semanticExecutionSpy.mock.calls.length,
            },
            ...(analytics === undefined ? {} : { analytics }),
          };
        } finally {
          activeRun = undefined;
          unsubscribe?.();
          await server?.close();
          await authority?.close();
        }
      }

      const disabled = await run("disabled");
      const enabled = await run("enabled");

      expect(enabled.response).toEqual(disabled.response);
      expect(enabled.outbound).toEqual(disabled.outbound);
      expect(enabled.provider).toEqual(disabled.provider);
      expect(enabled.provider).toEqual({
        bindingEvents: [
          "capture:openai",
          `runBound:${PROFILE_ID}`,
        ],
        modelEvents: ["getModels", "getAuth"],
        semanticExecutionCount: 0,
      });
      expect(enabled.outbound).toHaveLength(1);
      expect(enabled.outbound[0]).toMatchObject({
        url: `${upstreamOrigin}/v1/responses`,
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${PROVIDER_TOKEN}`,
          "content-type": "application/json",
          session_id: SESSION_ID,
          "x-client-request-id": SESSION_ID,
          "x-provider-static": "provider-owned",
        },
        body: JSON.stringify({
          model: "gpt-native",
          input: "measure provider native usage",
          store: false,
        }),
      });
      expect(enabled.outbound[0]?.headers).not.toHaveProperty("cookie");
      expect(enabled.outbound[0]?.headers.authorization).not.toBe(CLIENT_TOKEN);
      expect(enabled.response).toMatchObject({
        status: 200,
        headers: {
          "content-length": String(Buffer.byteLength(UPSTREAM_RESPONSE_BODY)),
          "content-type": "application/json",
          "request-id": "provider-success-request",
          "x-luckytoken-request-id": REQUEST_ID,
        },
        body: UPSTREAM_RESPONSE_BODY,
      });
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
      await Promise.allSettled([
        closeServer(upstreamServer),
        rm(root, { recursive: true, force: true }),
      ]);
    }
  });
});
