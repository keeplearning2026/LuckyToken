import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Models,
  Usage,
} from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Auth } from "../../src/auth.js";
import type {
  ConversionNotice,
  InvocationDiagnostics,
  InvocationDiagnosticsFactory,
} from "../../src/invocation-diagnostics/index.js";
import {
  createRequestLedgerStoreFactory,
  parseRequestLedgerConfiguration,
  type RequestLedgerRecord,
  type RequestLedgerStore,
} from "../../src/request-ledger/index.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createResponseSessionState } from "../../src/protocols/openai-responses/session-state.js";
import { resolveUsageSemantics } from "../../src/providers/usage-declarations.js";
import { createExecutionOperation } from "../../src/execution.js";
import { createCommandCodeServingTestComposition } from "../support/commandcode-serving.js";

/**
 * Ticket 20 seam: controlled Provider terminal outcomes observed through the
 * real Request Ledger public query. The handler is real, the Request Ledger
 * store is real, the usage-semantics declarations and the terminal-usage
 * normalizer are the production ones; the terminal `AssistantMessage` is
 * delivered by a scripted terminal stream (stub rows), by the real
 * CommandCode private provider over a scripted upstream (commandcode rows),
 * or by the real deterministic `faux` provider (faux rows).
 *
 * Expected totals and rates are independent worked examples (Ticket 20 AC),
 * never the production formula.
 */

const auth: Auth = {
  resolve: async () => ({ authorized: true, effectiveSessionId: "session" }),
};

let requestIdCounter = 0;
function requestId(): string {
  requestIdCounter += 1;
  return `10000000-0000-4000-8000-0000000002${String(requestIdCounter).padStart(2, "0")}`;
}

function model(api: string): Model<string> {
  return {
    id: "model",
    name: "model",
    api,
    provider: "provider",
    baseUrl: "https://provider.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100,
    maxTokens: 10,
  };
}

function usage(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  options: { reasoning?: number; totalTokens?: number } = {},
): Usage {
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    totalTokens: options.totalTokens ?? input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function message(
  api: string,
  usageValue: Usage,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    api,
    provider: "provider",
    model: "model",
    content: [{ type: "text", text: "complete" }],
    usage: usageValue,
    stopReason,
    timestamp: 1,
  };
}

function terminalStream(
  value: AssistantMessage,
  kind: "done" | "error" = "done",
  reason: "stop" | "length" | "toolUse" | "deferred" | "aborted" | "error" = "stop",
): AssistantMessageEventStream {
  let emitted = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (emitted) return { done: true as const, value: undefined };
        emitted = true;
        return {
          done: false as const,
          value:
            kind === "done"
              ? { type: "done" as const, reason, message: value }
              : {
                  type: "error" as const,
                  reason: reason as "aborted" | "error",
                  error: value,
                },
        };
      },
    }),
  } as AssistantMessageEventStream;
}

function anthropicRequest(modelSelector = "provider/model", content = "hello"): Request {
  return new Request("https://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelSelector,
      max_tokens: 10,
      messages: [{ role: "user", content }],
    }),
  });
}

describe("Ticket 20 terminal usage through the real Request Ledger", () => {
  const roots: string[] = [];
  const stores: RequestLedgerStore[] = [];

  afterEach(async () => {
    stores.splice(0).forEach((store) => store.close());
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function ledgerFixture() {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-terminal-usage-"));
    roots.push(root);
    const configuration = parseRequestLedgerConfiguration(
      { directory: "state/request-ledger" },
      root,
    );
    const store = await createRequestLedgerStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
      scrub: (value) => value,
      createRequestId: requestId,
    }).open();
    stores.push(store);
    return store;
  }

  async function stubFixture(
    api: string,
    stream: AssistantMessageEventStream,
    options: { invocationDiagnostics?: InvocationDiagnosticsFactory } = {},
  ) {
    const store = await ledgerFixture();
    const selected = model(api);
    const models = {
      getModels: () => [selected],
      streamSimple: () => stream,
    } as unknown as Models;
    const handler = createAnthropicMessagesHandler({
      models,
      auth,
      requestLedger: store,
      maxRequestBytes: 1024,
      now: () => 1_700_000_000_000,
      executeOperation: createExecutionOperation(resolveUsageSemantics),
      ...(options.invocationDiagnostics === undefined
        ? {}
        : { invocationDiagnostics: options.invocationDiagnostics }),
    });
    return { store, handler };
  }

  function records(store: RequestLedgerStore): Array<RequestLedgerRecord> {
    return store.query(undefined).records as Array<RequestLedgerRecord>;
  }

  describe("complete snapshots (stub terminal, declared api)", () => {
    it("records the independent total and rate for uncached usage (E1)", async () => {
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(message("faux", usage(5, 0, 0, 2), "stop")),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(200);
      const record = records(store).find((entry) => entry.outcome === "success");
      expect(record!.terminalUsage).toMatchObject({
        api: "faux",
        completeness: "complete",
        input: 5,
        cacheRead: 0,
        cacheWrite: 0,
        output: 2,
        normalizedTotal: 7,
        cacheHitRate: 0,
      });
      expect(record!.terminalUsage!.reasoning).toBeUndefined();
      expect(record!.terminalUsage!.reason).toBeUndefined();
      expect(record!.terminalUsage!.evidence).toContain("faux.ts");
    });

    it("keeps a zero cache rate distinct from an absent rate (E2/E3)", async () => {
      // E2: cache read 3 + write 2 over a 10-token input side -> rate 0.3,
      // total 12; reasoning 1 is a subset of output 2 and is never added.
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(
          message(
            "faux",
            usage(5, 3, 2, 2, { reasoning: 1, totalTokens: 12 }),
            "stop",
          ),
        ),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "complete",
        input: 5,
        cacheRead: 3,
        cacheWrite: 2,
        output: 2,
        reasoning: 1,
        normalizedTotal: 12,
      });
      expect(snapshot.cacheHitRate).toBeCloseTo(0.3, 10);
    });

    it("derives no cache rate when the input-side denominator is zero (E9)", async () => {
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(message("faux", usage(0, 0, 0, 5), "stop")),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "complete",
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 5,
        normalizedTotal: 5,
      });
      expect(snapshot.cacheHitRate).toBeUndefined();
    });
  });

  describe("partial and unavailable snapshots (stub terminal)", () => {
    it("surfaces the IR absence encoding as Partial usage_absent", async () => {
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(message("faux", usage(0, 0, 0, 0), "stop")),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "partial",
        reason: "usage_absent",
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      });
      expect(snapshot.normalizedTotal).toBeUndefined();
      expect(snapshot.cacheHitRate).toBeUndefined();
    });

    it("keeps captured components visible on a failed terminal", async () => {
      const failed = message("faux", usage(7, 1, 0, 2), "error");
      failed.errorMessage = "upstream exploded";
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(failed, "error", "error"),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(502);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "failed",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "partial",
        reason: "failed",
        input: 7,
        cacheRead: 1,
        cacheWrite: 0,
        output: 2,
      });
      expect(snapshot.normalizedTotal).toBeUndefined();
      expect(snapshot.cacheHitRate).toBeUndefined();
    });

    it("keeps the pre-abort input snapshot visible on an aborted terminal (E8)", async () => {
      // Anthropic-style abort after message_start: input/cache known,
      // output still 0. Nothing is zeroed or repaired.
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(message("faux", usage(7, 1, 0, 0), "aborted"), "error", "aborted"),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(500);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "aborted",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "partial",
        reason: "aborted",
        input: 7,
        cacheRead: 1,
        cacheWrite: 0,
        output: 0,
      });
      expect(snapshot.normalizedTotal).toBeUndefined();
      expect(snapshot.cacheHitRate).toBeUndefined();
    });

    it("marks an unsupported deferred terminal as unavailable with visible components", async () => {
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(
          message("faux", usage(0, 0, 0, 0), "deferred"),
          "done",
          "deferred",
        ),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(500);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "failed",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "unavailable",
        reason: "unsupported_terminal",
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      });
      expect(snapshot.normalizedTotal).toBeUndefined();
    });

    it("never infers completeness for an undeclared api, whatever the values", async () => {
      const { store, handler } = await stubFixture(
        "custom-unknown",
        terminalStream(message("custom-unknown", usage(5, 3, 2, 2), "stop")),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        api: "custom-unknown",
        completeness: "partial",
        reason: "undeclared_semantics",
        input: 5,
        cacheRead: 3,
        cacheWrite: 2,
        output: 2,
      });
      expect(snapshot.normalizedTotal).toBeUndefined();
      expect(snapshot.evidence).toBeUndefined();
    });
  });

  describe("real CommandCode private provider (scripted upstream)", () => {
    async function commandCodeFixture(upstream: string[]) {
      const store = await ledgerFixture();
      const fixtureFetch: FetchFunction = async () =>
        new Response(upstream.join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      const composition = createCommandCodeServingTestComposition({
        clientApiKey: "fixture-client-key",
        commandCodeApiKey: "fixture-commandcode-key",
        commandCodeBaseUrl: "https://fixture.commandcode.test/nested/base",
        fetch: fixtureFetch,
        modelId: "claude-fixture",
        createMessageId: () => "msg_fixture",
        createSessionId: () => "00000000-0000-4000-8000-000000000002",
        now: () => 1_786_400_000_000,
        requestLedger: store,
      });
      return { store, runtime: composition.runtime };
    }

    const commandCodeRequest = (): Request =>
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-fixture",
          max_tokens: 64,
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

    it("records a complete terminal usage from a committed finish (uncached)", async () => {
      // Worked example: wire input 3, output 4, total 7 -> total 7,
      // rate 0/3 = 0, complete.
      const { store, runtime } = await commandCodeFixture([
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "Hello." }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        }),
        "",
      ]);

      const response = await runtime.handle(commandCodeRequest());

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        api: "commandcode-private",
        completeness: "complete",
        input: 3,
        cacheRead: 0,
        cacheWrite: 0,
        output: 4,
        normalizedTotal: 7,
        cacheHitRate: 0,
      });
      expect(snapshot.evidence).toContain("semantic.ts");
    });

    it("partitions validated cache read/write tokens into the total and rate", async () => {
      // Worked example: wire input 12 (including cache), cache read 4,
      // cache write 3, output 2, total 14 -> input 5, total 14,
      // rate 4/12 ~= 0.3333, complete.
      const { store, runtime } = await commandCodeFixture([
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "Hello." }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 12,
            outputTokens: 2,
            totalTokens: 14,
            inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 3 },
          },
        }),
        "",
      ]);

      const response = await runtime.handle(commandCodeRequest());

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "complete",
        input: 5,
        cacheRead: 4,
        cacheWrite: 3,
        output: 2,
        normalizedTotal: 14,
      });
      expect(snapshot.cacheHitRate).toBeCloseTo(4 / 12, 10);
    });

    it("records validated reasoning as an output subset that never enters the total", async () => {
      // Worked example: input 4, output 6 (of which reasoning 3), total 10
      // -> total stays 10, rate 0/4 = 0, complete.
      const { store, runtime } = await commandCodeFixture([
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "Hello." }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 4,
            outputTokens: 6,
            totalTokens: 10,
            outputTokenDetails: { reasoningTokens: 3 },
          },
        }),
        "",
      ]);

      const response = await runtime.handle(commandCodeRequest());

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "complete",
        input: 4,
        cacheRead: 0,
        cacheWrite: 0,
        output: 6,
        reasoning: 3,
        normalizedTotal: 10,
        cacheHitRate: 0,
      });
    });

    it("surfaces absent finish usage as Partial usage_absent with zero components", async () => {
      const { store, runtime } = await commandCodeFixture([
        JSON.stringify({ type: "text-start", id: "0" }),
        JSON.stringify({ type: "text-delta", id: "0", text: "Hello." }),
        JSON.stringify({ type: "text-end", id: "0" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
        "",
      ]);

      const response = await runtime.handle(commandCodeRequest());

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "partial",
        reason: "usage_absent",
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      });
      expect(snapshot.normalizedTotal).toBeUndefined();
    });

    it("records a failed upstream terminal as Partial failed", async () => {
      const { store, runtime } = await commandCodeFixture([
        JSON.stringify({
          type: "error",
          error: { message: "upstream exploded" },
        }),
        "",
      ]);

      const response = await runtime.handle(commandCodeRequest());

      expect(response.status).toBe(502);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "failed",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        completeness: "partial",
        reason: "failed",
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      });
      expect(snapshot.normalizedTotal).toBeUndefined();
    });
  });

  describe("real deterministic faux provider", () => {
    async function fauxFixture(
      selector: string,
      options: { tokensPerSecond?: number } = {},
    ) {
      const store = await ledgerFixture();
      const faux = fauxProvider({
        api: "faux",
        models: [{ id: "faux-model" }],
        ...(options.tokensPerSecond === undefined
          ? {}
          : { tokensPerSecond: options.tokensPerSecond }),
      });
      const models = createModels();
      models.setProvider(faux.provider);
      const handler = createAnthropicMessagesHandler({
        models,
        auth,
        requestLedger: store,
        maxRequestBytes: 1024,
        now: () => 1_700_000_000_000,
        executeOperation: createExecutionOperation(resolveUsageSemantics),
      });
      return { store, handler, faux };
    }

    it("records complete usage whose components match the deterministic simulation", async () => {
      // Worked example: the serialized prompt is "user:hello" (10 chars,
      // estimate = ceil(10/4) = 3 input-side tokens); the response text
      // "hello world" (11 chars) estimates ceil(11/4) = 3 output tokens.
      // First request of the session: no cache read, full prompt written to
      // the simulated cache -> input 3, cacheRead 0, cacheWrite 3, output 3,
      // total 9, rate 0/6 = 0, complete.
      const { store, handler, faux } = await fauxFixture("faux/faux-model");
      faux.setResponses([fauxAssistantMessage("hello world")]);

      const response = await handler.handle(anthropicRequest("faux/faux-model"));

      expect(response.status).toBe(200);
      const snapshot = records(store).find(
        (entry) => entry.outcome === "success",
      )!.terminalUsage!;
      expect(snapshot).toMatchObject({
        api: "faux",
        completeness: "complete",
        input: 3,
        cacheRead: 0,
        cacheWrite: 3,
        output: 3,
        normalizedTotal: 9,
        cacheHitRate: 0,
      });
    });

    it("derives a full cache hit on the second identical request", async () => {
      // Worked example: same "user:hello" prompt again -> cacheRead 3,
      // cacheWrite 0, input 0, output 3, total 6, rate 3/3 = 1, complete.
      const { store, handler, faux } = await fauxFixture("faux/faux-model");
      faux.setResponses([
        fauxAssistantMessage("hello world"),
        fauxAssistantMessage("hello world"),
      ]);

      const first = await handler.handle(anthropicRequest("faux/faux-model"));
      const second = await handler.handle(anthropicRequest("faux/faux-model"));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      // The query is newest-first: snapshots[0] is the second request (full
      // cache hit), snapshots[1] is the first request (cache write).
      const snapshots = records(store)
        .filter((entry) => entry.outcome === "success")
        .map((entry) => entry.terminalUsage!);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toMatchObject({
        completeness: "complete",
        input: 0,
        cacheRead: 3,
        cacheWrite: 0,
        output: 3,
        normalizedTotal: 6,
        cacheHitRate: 1,
      });
      expect(snapshots[1]).toMatchObject({
        completeness: "complete",
        input: 3,
        cacheRead: 0,
        cacheWrite: 3,
        output: 3,
        normalizedTotal: 9,
        cacheHitRate: 0,
      });
    });

    it("records a caller abort that races the terminal as aborted without a snapshot", async () => {
      // The abort lands while the simulated stream is still scheduling its
      // first chunk, so no Pi terminal ever materializes: the ledger keeps
      // the truthful aborted outcome and no terminal-usage snapshot (a
      // snapshot exists only when a trustworthy Pi terminal occurred). The
      // abort-with-captured-components case is covered deterministically by
      // the stub E8 row above.
      const { store, handler, faux } = await fauxFixture("faux/faux-model", {
        tokensPerSecond: 1,
      });
      faux.setResponses([fauxAssistantMessage("hello world")]);
      const controller = new AbortController();
      const request = new Request("https://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer client",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "faux/faux-model",
          max_tokens: 10,
          messages: [{ role: "user", content: "hello" }],
        }),
        signal: controller.signal,
      });
      const responsePromise = handler.handle(request).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort(new Error("client disconnected"));
      await responsePromise;

      const record = records(store).find(
        (entry) => entry.outcome === "aborted",
      );
      expect(record).toBeDefined();
      expect(record!.terminalUsage).toBeUndefined();
    });
  });

  describe("fail-open Client Wire usage (Ticket 20 additive)", () => {
    /** Invocation Diagnostics seam that captures the response notices. */
    function capturingDiagnosticsFactory(): {
      factory: InvocationDiagnosticsFactory;
      notices: ConversionNotice[];
    } {
      const notices: ConversionNotice[] = [];
      const invocation: InvocationDiagnostics = Object.freeze({
        requestId: "00000000-0000-4000-8000-000000000000",
        notice: (notice: ConversionNotice) => notices.push(notice),
        attempt: () => undefined,
        checkpoint: () => undefined,
        succeed: async () => undefined,
        fail: async () => undefined,
      });
      const factory: InvocationDiagnosticsFactory = Object.freeze({
        begin: () => invocation,
      });
      return { factory, notices };
    }

    async function openaiStubFixture(
      api: string,
      stream: AssistantMessageEventStream,
      invocationDiagnostics?: InvocationDiagnosticsFactory,
    ) {
      const store = await ledgerFixture();
      const stateRoot = await mkdtemp(
        join(tmpdir(), "luckytoken-usage-responses-state-"),
      );
      roots.push(stateRoot);
      const stateFile = join(stateRoot, "responses-session.json");
      const selected = model(api);
      const models = {
        getModels: () => [selected],
        streamSimple: () => stream,
      } as unknown as Models;
      const handler = createOpenAIResponsesHandler({
        models,
        auth,
        stateFile,
        sessionState: createResponseSessionState({ stateFile }),
        requestLedger: store,
        maxRequestBytes: 1024,
        now: () => 1_700_000_000_000,
        createResponseId: () => "resp_failopen",
        executeOperation: createExecutionOperation(resolveUsageSemantics),
        ...(invocationDiagnostics === undefined
          ? {}
          : { invocationDiagnostics }),
      });
      return { store, handler };
    }

    function anthropicStreamRequest(): Request {
      return new Request("https://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer client",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "provider/model",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
    }

    function responsesRequest(
      selector = "provider/model",
      stream = false,
    ): Request {
      return new Request("https://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: selector,
          input: "hello",
          ...(stream ? { stream: true } : {}),
        }),
      });
    }

    const anthropicZeroUsage = {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      input_tokens: 0,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    };

    it("renders the atomic zero usage on a successful non-streaming Anthropic body and never persists the fallback as Provider truth", async () => {
      const capture = capturingDiagnosticsFactory();
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(
          message("faux", { ...usage(5, 0, 0, 2), input: -1 }, "stop"),
        ),
        { invocationDiagnostics: capture.factory },
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(body.content).toEqual([
        { citations: null, text: "complete", type: "text" },
      ]);
      expect(body.usage).toEqual(anthropicZeroUsage);
      // The bounded structured warning reaches both the Invocation
      // Diagnostics seam and the Request Ledger through the current notice
      // path/request id, and never carries the raw invalid value.
      expect(capture.notices.map((notice) => notice.code)).toContain(
        "client_usage_unavailable",
      );
      const record = records(store).find(
        (entry) => entry.outcome === "success",
      )!;
      expect(record.facts?.notices?.map((notice) => notice.code)).toContain(
        "client_usage_unavailable",
      );
      expect(
        record.facts?.notices?.every(
          (notice) =>
            notice.adapter === "anthropic-messages" &&
            notice.direction === "response",
        ),
      ).toBe(true);
      // The malformed snapshot is undecodable, so the store refuses it: the
      // Client Wire zeros are observability only, never Provider truth.
      expect(record.terminalUsage).toBeUndefined();
      expect(JSON.stringify(capture.notices)).not.toContain("-1");
    });

    it("keeps a successful streaming Anthropic SSE body when reasoning exceeds output", async () => {
      const capture = capturingDiagnosticsFactory();
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(
          message("faux", usage(5, 0, 0, 2, { reasoning: 99 }), "stop"),
        ),
        { invocationDiagnostics: capture.factory },
      );

      const response = await handler.handle(anthropicStreamRequest());

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const frames = (await response.text())
        .split("\n\n")
        .filter((frame) => frame.length > 0);
      const startFrame = frames.find((frame) =>
        frame.startsWith("event: message_start"),
      )!;
      const start = JSON.parse(
        startFrame.split("\n")[1]!.slice("data: ".length),
      );
      expect(start.message.usage).toMatchObject({
        input_tokens: 5,
        output_tokens: 0,
        output_tokens_details: null,
      });
      const deltaFrame = frames.find((frame) =>
        frame.startsWith("event: message_delta"),
      )!;
      const delta = JSON.parse(
        deltaFrame.split("\n")[1]!.slice("data: ".length),
      );
      expect(delta.delta.stop_reason).toBe("end_turn");
      expect(delta.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 });
      expect(frames.join("\n")).toContain("complete");
      expect(capture.notices.map((notice) => notice.code)).toContain(
        "client_usage_reasoning_unavailable",
      );
      const record = records(store).find(
        (entry) => entry.outcome === "success",
      )!;
      expect(record.facts?.notices?.map((notice) => notice.code)).toContain(
        "client_usage_reasoning_unavailable",
      );
      // reasoning > output makes the Pi-side snapshot itself undecodable:
      // no snapshot is persisted and the request outcome stays successful.
      expect(record.terminalUsage).toBeUndefined();
    });

    it("drops only an invalid 1h/5m split while a decoder-valid Partial snapshot stays unchanged", async () => {
      const { store, handler } = await stubFixture(
        "custom-unknown",
        terminalStream(
          message(
            "custom-unknown",
            { ...usage(5, 3, 2, 2), cacheWrite1h: 9 } as Usage,
            "stop",
          ),
        ),
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(body.usage).toMatchObject({
        cache_creation: null,
        cache_creation_input_tokens: 2,
        input_tokens: 5,
        output_tokens: 2,
      });
      const record = records(store).find(
        (entry) => entry.outcome === "success",
      )!;
      expect(record.facts?.notices?.map((notice) => notice.code)).toContain(
        "client_usage_cache_write_split_unavailable",
      );
      // The existing decoder-valid Partial truth (undeclared api) is
      // untouched: the fail-open wire conversion neither upgrades
      // completeness nor zeroes the stored snapshot.
      expect(record.terminalUsage).toMatchObject({
        api: "custom-unknown",
        completeness: "partial",
        reason: "undeclared_semantics",
        input: 5,
        cacheRead: 3,
        cacheWrite: 2,
        output: 2,
      });
    });

    it("fails open on a hostile non-object usage object without discarding the response", async () => {
      const capture = capturingDiagnosticsFactory();
      const { store, handler } = await stubFixture(
        "faux",
        terminalStream(message("faux", null as unknown as Usage, "stop")),
        { invocationDiagnostics: capture.factory },
      );

      const response = await handler.handle(anthropicRequest());

      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(body.content).toEqual([
        { citations: null, text: "complete", type: "text" },
      ]);
      expect(body.usage).toEqual(anthropicZeroUsage);
      expect(capture.notices.map((notice) => notice.code)).toContain(
        "client_usage_unavailable",
      );
      const record = records(store).find(
        (entry) => entry.outcome === "success",
      )!;
      expect(record.terminalUsage).toBeUndefined();
    });

    it("derives the Responses total for an inconsistent Pi total with a warning, leaving the Partial snapshot unchanged", async () => {
      const capture = capturingDiagnosticsFactory();
      const { store, handler } = await openaiStubFixture(
        "commandcode-private",
        terminalStream(
          message(
            "commandcode-private",
            usage(5, 2, 1, 5, { totalTokens: 5 }),
            "stop",
          ),
        ),
        capture.factory,
      );

      const response = await handler.handle(responsesRequest());

      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      // The target total is derived per the Responses contract (input
      // includes cache), never the Pi total 5.
      expect(body.usage).toEqual({
        input_tokens: 8,
        output_tokens: 5,
        total_tokens: 13,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 0 },
      });
      expect(capture.notices.map((notice) => notice.code)).toContain(
        "client_usage_total_unavailable",
      );
      const record = records(store).find(
        (entry) => entry.outcome === "success",
      )!;
      expect(record.facts?.notices?.map((notice) => notice.code)).toContain(
        "client_usage_total_unavailable",
      );
      // The decoder-valid Partial snapshot (invalid_components from the
      // Pi-side total mismatch) is stored exactly as captured: still
      // Partial, reason unchanged, never upgraded by the wire conversion.
      expect(record.terminalUsage).toMatchObject({
        api: "commandcode-private",
        completeness: "partial",
        reason: "invalid_components",
        input: 5,
        cacheRead: 2,
        cacheWrite: 1,
        output: 5,
      });
      expect(record.terminalUsage!.normalizedTotal).toBeUndefined();
    });

    it("keeps a successful non-streaming Responses body with the atomic zero usage", async () => {
      const capture = capturingDiagnosticsFactory();
      const { store, handler } = await openaiStubFixture(
        "commandcode-private",
        terminalStream(
          message(
            "commandcode-private",
            { ...usage(5, 0, 0, 2), input: -1 },
            "stop",
          ),
        ),
        capture.factory,
      );

      const response = await handler.handle(responsesRequest());

      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(
        (body.output as Array<Record<string, unknown>>)[0],
      ).toMatchObject({
        type: "message",
        content: [{ type: "output_text", text: "complete", annotations: [] }],
      });
      expect(body.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      });
      expect(capture.notices.map((notice) => notice.code)).toContain(
        "client_usage_unavailable",
      );
      const record = records(store).find(
        (entry) => entry.outcome === "success",
      )!;
      expect(record.facts?.notices?.map((notice) => notice.code)).toContain(
        "client_usage_unavailable",
      );
      expect(record.terminalUsage).toBeUndefined();
    });

    it("keeps a successful streaming Responses SSE body with the zero usage fallback", async () => {
      const capture = capturingDiagnosticsFactory();
      const { store, handler } = await openaiStubFixture(
        "commandcode-private",
        terminalStream(
          message(
            "commandcode-private",
            { ...usage(5, 0, 0, 2), input: -1 },
            "stop",
          ),
        ),
        capture.factory,
      );

      const response = await handler.handle(responsesRequest("provider/model", true));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const frames = (await response.text())
        .split("\n\n")
        .filter((frame) => frame.length > 0);
      const terminal = JSON.parse(
        frames[2]!.replace(/^data: /, ""),
      );
      expect(terminal.type).toBe("response.completed");
      expect(terminal.response.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      });
      expect(frames.join("\n")).toContain("complete");
      expect(capture.notices.map((notice) => notice.code)).toContain(
        "client_usage_unavailable",
      );
      const record = records(store).find(
        (entry) => entry.outcome === "success",
      )!;
      expect(record.terminalUsage).toBeUndefined();
    });
  });
});
