import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import type { AnalyticsResult } from "@luckytoken/application-control-plane/control-plane";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  ManagedProviderAuthBindingCapture,
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsManagementAuthority,
} from "../../src/diagnostics/index.js";
import type { ExecutionOperation } from "../../src/execution.js";
import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { identityRequestModelResolver } from "../../src/protocols/anthropic/options.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";
import {
  startLuckyTokenHttpServer,
  type RunningLuckyTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "88000000-0000-4000-8000-000000000001";
const SESSION_ID = "88000000-0000-4000-8000-000000000002";
const PROFILE_ID = "anthropic-native-usage-profile";
const PROVIDER_TOKEN = "anthropic-native-usage-provider-token";
const UPSTREAM_RESPONSE_BODY = JSON.stringify({
  id: "msg_native_usage",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "native answer" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 5,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    output_tokens: 7,
    output_tokens_details: { thinking_tokens: 2 },
  },
});
const UPSTREAM_SSE_BODY = [
  "event: message_start",
  `data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_native_stream_usage",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 1,
      },
    },
  })}`,
  "",
  "event: content_block_start",
  `data: ${JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })}`,
  "",
  "event: content_block_delta",
  `data: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "native stream answer" },
  })}`,
  "",
  "event: content_block_stop",
  `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
  "",
  "event: message_delta",
  `data: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: {
      output_tokens: 7,
      output_tokens_details: { thinking_tokens: 2 },
    },
  })}`,
  "",
  "event: message_stop",
  `data: ${JSON.stringify({ type: "message_stop" })}`,
  "",
].join("\n");

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
  readonly capturedProviders: readonly string[];
  readonly boundProfiles: readonly string[];
  readonly profileAdvances: number;
  readonly modelTouches: readonly string[];
  readonly analytics?: AnalyticsResult;
}

function anthropicModel(): Model<string> {
  return {
    id: "claude-test",
    name: "Claude Test",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://provider.example.com/gateway",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function managedCapture(): ManagedProviderAuthBindingCapture {
  return Object.freeze({
    facts: Object.freeze({
      kind: "managed" as const,
      providerId: "anthropic",
      credentialId: PROFILE_ID,
      authType: "api_key" as const,
      authMethodLabel: "API key",
      displayName: "Anthropic Native Usage",
      credentialGeneration: "credential-generation:anthropic-usage",
      selectionGeneration: "selection-generation:anthropic-usage",
    }),
  });
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

describe("Anthropic Provider Native terminal usage analytics producer", () => {
  it("projects terminal usage without changing Profile execution or either wire", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "luckytoken-anthropic-native-analytics-"),
    );

    async function run(
      mode: "disabled" | "enabled",
      fixture: Readonly<{
        name: "json" | "sse";
        upstreamBody: string;
        contentType: "application/json" | "text/event-stream";
        stream: boolean;
      }> = {
        name: "json",
        upstreamBody: UPSTREAM_RESPONSE_BODY,
        contentType: "application/json",
        stream: false,
      },
    ): Promise<RunResult> {
      const runRoot = join(root, `${fixture.name}-${mode}`);
      let authority: DiagnosticsManagementAuthority | undefined;
      let server: RunningLuckyTokenHttpServer | undefined;
      let unsubscribe: (() => void) | undefined;
      let clock = 1_000;
      const outbound: WireSnapshot[] = [];
      const capturedProviders: string[] = [];
      const boundProfiles: string[] = [];
      const modelTouches: string[] = [];
      let profileAdvances = 0;
      let boundProfile: string | undefined;

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

        const capture = managedCapture();
        const bindings: Pick<
          ProviderAuthBindingAuthority,
          "capture" | "runBound" | "advanceAfterFinal429"
        > = Object.freeze({
          capture: async (providerId: string) => {
            capturedProviders.push(providerId);
            return capture;
          },
          runBound: async <T>(
            requestCapture: ProviderAuthBindingCapture,
            operation: () => Promise<T>,
          ): Promise<T> => {
            if (requestCapture.facts.kind !== "managed") {
              throw new Error("Expected a managed Anthropic Profile");
            }
            boundProfiles.push(requestCapture.facts.credentialId);
            boundProfile = requestCapture.facts.credentialId;
            try {
              return await operation();
            } finally {
              boundProfile = undefined;
            }
          },
          advanceAfterFinal429: async () => {
            profileAdvances += 1;
            return Object.freeze({ outcome: "exhausted" as const });
          },
        });

        const model = anthropicModel();
        const models = new Proxy({} as Models, {
          get(_target, property) {
            if (property === "getModels") {
              return () => {
                modelTouches.push("getModels");
                return [model];
              };
            }
            if (property === "getAuth") {
              return async () => {
                modelTouches.push(`getAuth:${boundProfile}`);
                if (boundProfile !== PROFILE_ID) {
                  throw new Error("Auth must resolve under the captured Profile");
                }
                return {
                  auth: { apiKey: PROVIDER_TOKEN },
                  source: "fixture",
                };
              };
            }
            throw new Error(`Unexpected Pi Models capability: ${String(property)}`);
          },
        });
        const providerFetch: FetchFunction = async (input, init) => {
          const request = new Request(input, init);
          outbound.push({
            url: request.url,
            method: request.method,
            headers: sortedHeaders(request.headers),
            body: await request.text(),
          });
          clock = 2_000;
          return new Response(fixture.upstreamBody, {
            status: 200,
            headers: {
              "content-type": fixture.contentType,
              "request-id": "anthropic-upstream-usage-request",
            },
          });
        };
        const semanticExecution = vi.fn(async () => {
          throw new Error("Semantic Conversion must not execute");
        }) as unknown as ExecutionOperation;
        const handler = createAnthropicMessagesHandler({
          models,
          providerNativeLane: createAnthropicProviderNativeLane({
            models,
            bindings,
            resolveRequestModel: identityRequestModelResolver,
            fetch: providerFetch,
          }),
          executeOperation: semanticExecution,
          maxRequestBytes: 4_096,
          createMessageId: () => "msg_semantic_must_not_render",
          createSessionId: () => SESSION_ID,
          now: () => 1_800_000_000_000,
        });
        const runtime = createLuckyTokenRuntime({ clientProtocols: [handler] });
        server = await startLuckyTokenHttpServer({
          runtime,
          ...(authority === undefined ? {} : { diagnostics: authority }),
          createRequestId: () => REQUEST_ID,
          port: 0,
        });

        const requestBody = JSON.stringify({
          model: "anthropic/claude-test",
          max_tokens: 32,
          messages: [{ role: "user", content: "measure native usage" }],
          ...(fixture.stream ? { stream: true } : {}),
        });
        const response = await fetch(`${server.origin}/v1/messages`, {
          method: "POST",
          headers: {
            authorization: "Bearer client-token",
            "anthropic-version": "2023-06-01",
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
          capturedProviders,
          boundProfiles,
          profileAdvances,
          modelTouches,
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
      expect(enabled.capturedProviders).toEqual(disabled.capturedProviders);
      expect(enabled.boundProfiles).toEqual(disabled.boundProfiles);
      expect(enabled.profileAdvances).toBe(disabled.profileAdvances);
      expect(enabled.modelTouches).toEqual(disabled.modelTouches);

      expect(enabled.response).toMatchObject({
        status: 200,
        headers: {
          "content-length": String(Buffer.byteLength(UPSTREAM_RESPONSE_BODY)),
          "content-type": "application/json",
          "request-id": "anthropic-upstream-usage-request",
          "x-luckytoken-request-id": REQUEST_ID,
        },
        body: UPSTREAM_RESPONSE_BODY,
      });
      expect(enabled.outbound).toHaveLength(1);
      expect(enabled.outbound[0]).toMatchObject({
        url: "https://provider.example.com/gateway/v1/messages",
        method: "POST",
        headers: {
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": PROVIDER_TOKEN,
        },
        body: JSON.stringify({
          model: "claude-test",
          max_tokens: 32,
          messages: [{ role: "user", content: "measure native usage" }],
        }),
      });
      expect(enabled.capturedProviders).toEqual(["anthropic"]);
      expect(enabled.boundProfiles).toEqual([PROFILE_ID]);
      expect(enabled.profileAdvances).toBe(0);
      expect(enabled.modelTouches).toEqual([
        "getModels",
        `getAuth:${PROFILE_ID}`,
      ]);

      expect(enabled.analytics?.totals).toMatchObject({
        total: 1,
        success: 1,
        usageRequests: 1,
        missingUsageRequests: 0,
        speedRequests: 1,
        inputTokens: 5,
        cacheReadTokens: 3,
        outputTokens: 7,
        cacheHitRate: 3 / 8,
        outputTokensPerSecond: 7,
      });

      const sseFixture = {
        name: "sse",
        upstreamBody: UPSTREAM_SSE_BODY,
        contentType: "text/event-stream",
        stream: true,
      } as const;
      const sseDisabled = await run("disabled", sseFixture);
      const sseEnabled = await run("enabled", sseFixture);

      expect(sseEnabled.response).toEqual(sseDisabled.response);
      expect(sseEnabled.outbound).toEqual(sseDisabled.outbound);
      expect(sseEnabled.capturedProviders).toEqual(
        sseDisabled.capturedProviders,
      );
      expect(sseEnabled.boundProfiles).toEqual(sseDisabled.boundProfiles);
      expect(sseEnabled.profileAdvances).toBe(sseDisabled.profileAdvances);
      expect(sseEnabled.modelTouches).toEqual(sseDisabled.modelTouches);
      expect(sseEnabled.response).toMatchObject({
        status: 200,
        headers: {
          "content-length": String(Buffer.byteLength(UPSTREAM_SSE_BODY)),
          "content-type": "text/event-stream",
          "request-id": "anthropic-upstream-usage-request",
          "x-luckytoken-request-id": REQUEST_ID,
        },
        body: UPSTREAM_SSE_BODY,
      });
      expect(sseEnabled.outbound).toHaveLength(1);
      expect(sseEnabled.outbound[0]).toMatchObject({
        url: "https://provider.example.com/gateway/v1/messages",
        method: "POST",
        headers: {
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": PROVIDER_TOKEN,
        },
        body: JSON.stringify({
          model: "claude-test",
          max_tokens: 32,
          messages: [{ role: "user", content: "measure native usage" }],
          stream: true,
        }),
      });
      expect(sseEnabled.capturedProviders).toEqual(["anthropic"]);
      expect(sseEnabled.boundProfiles).toEqual([PROFILE_ID]);
      expect(sseEnabled.profileAdvances).toBe(0);
      expect(sseEnabled.modelTouches).toEqual([
        "getModels",
        `getAuth:${PROFILE_ID}`,
      ]);
      expect(sseEnabled.analytics?.totals).toMatchObject({
        total: 1,
        success: 1,
        usageRequests: 1,
        missingUsageRequests: 0,
        speedRequests: 1,
        inputTokens: 5,
        cacheReadTokens: 3,
        outputTokens: 7,
        cacheHitRate: 3 / 8,
        outputTokensPerSecond: 7,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
