import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { AnalyticsResult } from "@token/application-control-plane/control-plane";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsManagementAuthority,
} from "../../src/diagnostics/index.js";
import {
  createExecutionOperation,
  type ExecutionOperation,
} from "../../src/execution.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "89000000-0000-4000-8000-000000000001";
const SESSION_ID = "89000000-0000-4000-8000-000000000002";
const GOAT_REQUEST_ID = "89000000-0000-4000-8000-000000000003";
const CLIENT_TOKEN = "client-semantic-usage-token-canary";

const model: Model<string> = {
  id: "semantic-usage",
  name: "Semantic Usage",
  api: "anthropic-messages",
  provider: "faux",
  baseUrl: "https://semantic-provider.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const terminalUsage: Usage = {
  input: 5,
  cacheRead: 3,
  cacheWrite: 2,
  output: 2,
  reasoning: 1,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const terminalMessage: AssistantMessage = {
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: "text", text: "semantic answer" }],
  usage: terminalUsage,
  stopReason: "stop",
  timestamp: 1_700_000_000_000,
};

interface PiInvocationSnapshot {
  readonly model: Readonly<{
    provider: string;
    api: string;
    id: string;
  }>;
  readonly context: unknown;
  readonly options: Readonly<{
    maxTokens?: number;
    temperature?: number;
    sessionId?: string;
    signalAborted: boolean;
    keys: readonly string[];
  }>;
}

interface WorkOutcomeSnapshot {
  readonly stopReason: AssistantMessage["stopReason"];
  readonly content: AssistantMessage["content"];
  readonly usage: AssistantMessage["usage"];
}

interface RunResult {
  readonly response: Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: string;
  }>;
  readonly piInvocations: readonly PiInvocationSnapshot[];
  readonly workOutcomes: readonly WorkOutcomeSnapshot[];
  readonly analytics?: AnalyticsResult;
}

function terminalStream(
  message: AssistantMessage,
  onTerminal: () => void,
): AssistantMessageEventStream {
  let emitted = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (emitted) return { done: true as const, value: undefined };
        emitted = true;
        onTerminal();
        return {
          done: false as const,
          value: { type: "done" as const, reason: "stop" as const, message },
        };
      },
    }),
  } as AssistantMessageEventStream;
}

function snapshotInvocation(
  selectedModel: Model<string>,
  context: Context,
  options: ModelsSimpleStreamOptions,
): PiInvocationSnapshot {
  return {
    model: {
      provider: selectedModel.provider,
      api: selectedModel.api,
      id: selectedModel.id,
    },
    context: JSON.parse(JSON.stringify(context)) as unknown,
    options: {
      ...(options.maxTokens === undefined
        ? {}
        : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      signalAborted: options.signal?.aborted === true,
      keys: Object.keys(options).sort(),
    },
  };
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

describe("OpenAI Responses Semantic Conversion terminal usage analytics producer", () => {
  it("publishes normalized Pi terminal usage without changing invocation, render, or work outcome", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-semantic-openai-analytics-"),
    );

    async function run(mode: "disabled" | "enabled"): Promise<RunResult> {
      const runRoot = join(root, mode);
      let authority: DiagnosticsManagementAuthority | undefined;
      let server: RunningTokenHttpServer | undefined;
      let unsubscribe: (() => void) | undefined;
      let diagnosticsClock = 1_000;
      const piInvocations: PiInvocationSnapshot[] = [];
      const workOutcomes: WorkOutcomeSnapshot[] = [];

      try {
        if (mode === "enabled") {
          authority = await createDiagnosticsAuthority({
            configuration: parseDiagnosticsConfiguration(
              { directory: join(runRoot, "diagnostics") },
              runRoot,
            ),
            now: () => diagnosticsClock,
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

        const streamSimple = vi.fn(
          (
            selectedModel: Model<string>,
            context: Context,
            options: ModelsSimpleStreamOptions,
          ) => {
            void options.onPayload?.(
              {
                model: selectedModel.id,
                messages: [],
                stream: true,
                max_tokens: options.maxTokens,
                temperature: options.temperature,
                thinking: { type: "disabled" },
              },
              selectedModel,
            );
            piInvocations.push(
              snapshotInvocation(selectedModel, context, options),
            );
            return terminalStream(terminalMessage, () => {
              diagnosticsClock = 2_000;
            });
          },
        );
        const models = {
          getModels: () => [model],
          streamSimple,
        } as unknown as Models;
        const realExecution = createExecutionOperation();
        const executeOperation: ExecutionOperation = async (...args) => {
          const message = await realExecution(...args);
          workOutcomes.push({
            stopReason: message.stopReason,
            content: message.content,
            usage: message.usage,
          });
          return message;
        };
        const handler = createOpenAIResponsesHandler({
          models,
          executeOperation,
          stateFile: join(runRoot, "responses-state.json"),
          maxRequestBytes: 4_096,
          createResponseId: () => "resp_semantic_usage",
          createSessionId: () => SESSION_ID,
          now: () => 1_700_000_000_000,
        });
        const runtime = createTokenRuntime({ clientProtocols: [handler] });
        server = await startTokenHttpServer({
          runtime,
          ...(authority === undefined ? {} : { diagnostics: authority }),
          createRequestId: () => REQUEST_ID,
          port: 0,
        });

        const response = await fetch(`${server.origin}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${CLIENT_TOKEN}`,
            "content-type": "application/json",
            "x-client-request-id": SESSION_ID,
          },
          body: JSON.stringify({
            model: "faux/semantic-usage",
            instructions: "Answer precisely",
            input: "measure semantic usage",
            max_output_tokens: 32,
            temperature: 0.25,
            store: false,
          }),
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

        expect(streamSimple).toHaveBeenCalledOnce();
        return {
          response: {
            status: response.status,
            headers: stableResponseHeaders(response.headers),
            body: responseBody,
          },
          piInvocations,
          workOutcomes,
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
      expect(enabled.piInvocations).toEqual(disabled.piInvocations);
      expect(enabled.workOutcomes).toEqual(disabled.workOutcomes);
      expect(enabled.piInvocations).toHaveLength(1);
      expect(enabled.piInvocations[0]).toMatchObject({
        model: {
          provider: "faux",
          api: "anthropic-messages",
          id: "semantic-usage",
        },
        context: {
          systemPrompt: "Answer precisely",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "measure semantic usage" }],
            },
          ],
        },
        options: {
          maxTokens: 32,
          temperature: 0.25,
          sessionId: SESSION_ID,
          signalAborted: false,
        },
      });
      const serializedInvocation = JSON.stringify(enabled.piInvocations);
      expect(serializedInvocation).not.toContain(CLIENT_TOKEN);
      expect(serializedInvocation).not.toContain("journey");
      expect(serializedInvocation).not.toContain("observer");
      expect(serializedInvocation).not.toContain("diagnostics");
      expect(enabled.workOutcomes).toEqual([
        {
          stopReason: "stop",
          content: [{ type: "text", text: "semantic answer" }],
          usage: terminalUsage,
        },
      ]);

      expect(enabled.response.status).toBe(200);
      expect(enabled.response.headers).toMatchObject({
        "content-type": "application/json",
        "x-token-request-id": REQUEST_ID,
      });
      const responseBody = JSON.parse(enabled.response.body) as Record<
        string,
        unknown
      >;
      expect(responseBody).toMatchObject({
        id: "resp_semantic_usage",
        object: "response",
        status: "completed",
        model: "faux/semantic-usage",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "semantic answer", annotations: [] },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 1 },
          total_tokens: 12,
        },
      });
      expect(enabled.analytics?.totals).toMatchObject({
        total: 1,
        success: 1,
        usageRequests: 1,
        missingUsageRequests: 0,
        speedRequests: 1,
        inputTokens: 5,
        cacheReadTokens: 3,
        outputTokens: 2,
        cacheHitRate: 3 / 8,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes certified CommandCode Goat usage to the Journey row and Overview analytics", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-commandcode-goat-usage-"),
    );
    const goatModel: Model<string> = {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      provider: "commandcode-goat",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    };
    const goatUsage: Usage = {
      input: 87,
      cacheRead: 0,
      cacheWrite: 0,
      output: 25,
      reasoning: 23,
      totalTokens: 112,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
    const goatTerminal: AssistantMessage = {
      role: "assistant",
      api: goatModel.api,
      provider: goatModel.provider,
      model: goatModel.id,
      content: [{ type: "text", text: "OK" }],
      usage: goatUsage,
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
    };
    let authority: DiagnosticsManagementAuthority | undefined;
    let server: RunningTokenHttpServer | undefined;
    let unsubscribe: (() => void) | undefined;

    try {
      authority = await createDiagnosticsAuthority({
        configuration: parseDiagnosticsConfiguration(
          { directory: join(root, "diagnostics") },
          root,
        ),
        now: () => 2_000,
      });
      let resolveDurableJourney!: () => void;
      const durableJourney = new Promise<void>((resolve) => {
        resolveDurableJourney = resolve;
      });
      const subscription = authority.subscribeRequestJourneys((record) => {
        if (record.requestId === GOAT_REQUEST_ID) resolveDurableJourney();
      });
      unsubscribe = () => subscription.unsubscribe();

      const models = {
        getModels: () => [goatModel],
        streamSimple: (
          selectedModel: Model<string>,
          _context: Context,
          options: ModelsSimpleStreamOptions,
        ) => {
          void options.onPayload?.(
            {
              model: selectedModel.id,
              messages: [],
              stream: true,
              max_tokens: options.maxTokens,
            },
            selectedModel,
          );
          return terminalStream(goatTerminal, () => undefined);
        },
      } as unknown as Models;
      const handler = createOpenAIResponsesHandler({
        models,
        executeOperation: createExecutionOperation(),
        stateFile: join(root, "responses-state.json"),
        maxRequestBytes: 4_096,
        createResponseId: () => "resp_goat_usage",
        createSessionId: () => SESSION_ID,
        now: () => 1_700_000_000_000,
      });
      server = await startTokenHttpServer({
        runtime: createTokenRuntime({ clientProtocols: [handler] }),
        diagnostics: authority,
        createRequestId: () => GOAT_REQUEST_ID,
        port: 0,
      });

      const response = await fetch(`${server.origin}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_TOKEN}`,
          "content-type": "application/json",
          "x-client-request-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "commandcode-goat/deepseek/deepseek-v4-flash",
          input: "measure Goat usage",
          max_output_tokens: 64,
          store: false,
        }),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      await durableJourney;

      const page = await authority.queryRequestJourneys({ limit: 10 });
      expect(page.records).toHaveLength(1);
      expect(page.records[0]?.usage).toEqual({
        terminalClass: "done",
        inputTokens: 87,
        cacheReadTokens: 0,
        outputTokens: 25,
        cacheHitRate: 0,
      });

      const analytics = requireSummary(
        await authority.getAnalytics({
          version: 3,
          command: "summary",
          from: 0,
          to: Number.MAX_SAFE_INTEGER,
        }),
      );
      expect(analytics.totals).toMatchObject({
        total: 1,
        usageRequests: 1,
        missingUsageRequests: 0,
        speedRequests: 0,
        inputTokens: 87,
        cacheReadTokens: 0,
        outputTokens: 25,
      });
    } finally {
      unsubscribe?.();
      await server?.close();
      await authority?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
