import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  InvocationCompositionFailure,
  composeOptions,
} from "../../src/protocols/anthropic/options.js";

const sessionId = "00000000-0000-4000-8000-000000000070";

describe("closed-world Pi option composition", () => {
  it.each([
    {
      name: "neither metadata fact",
      protocol: { maxTokens: 10 },
      projectDir: undefined,
      metadata: undefined,
    },
    {
      name: "client user id only",
      protocol: { maxTokens: 10, metadata: { user_id: "user" } },
      projectDir: undefined,
      metadata: { user_id: "user" },
    },
    {
      name: "auth project only",
      protocol: { maxTokens: 10 },
      projectDir: "D:/project",
      metadata: { projectDir: "D:/project" },
    },
    {
      name: "both facts",
      protocol: { maxTokens: 10, metadata: { user_id: "user" } },
      projectDir: "D:/project",
      metadata: { user_id: "user", projectDir: "D:/project" },
    },
  ])("merges $name per owned key", ({ protocol, projectDir, metadata }) => {
    const controller = new AbortController();
    const effective = composeOptions(
      protocol,
      {
        sessionId,
        signal: controller.signal,
        ...(projectDir === undefined ? {} : { projectDir }),
      },
      {},
    );

    expect(effective).toEqual({
      maxTokens: 10,
      sessionId,
      signal: controller.signal,
      ...(metadata === undefined ? {} : { metadata }),
    });
    expect(effective.signal).toBe(controller.signal);
  });

  it("preserves exact temperature presence and accepts only empty v1 defaults", () => {
    const signal = new AbortController().signal;
    expect(
      composeOptions(
        { maxTokens: 12, temperature: 0 },
        { sessionId, signal },
        {},
      ),
    ).toEqual({ maxTokens: 12, temperature: 0, sessionId, signal });
    expect(
      composeOptions({ maxTokens: 12 }, { sessionId, signal }, {}),
    ).not.toHaveProperty("temperature");
  });

  it("composes protocol-owned reasoning and rejects unknown levels", () => {
    const signal = new AbortController().signal;
    expect(
      composeOptions(
        { maxTokens: 12, reasoning: "high" },
        { sessionId, signal },
        {},
      ),
    ).toEqual({ maxTokens: 12, reasoning: "high", sessionId, signal });
    expect(() =>
      composeOptions(
        { maxTokens: 12, reasoning: "super" } as unknown as ModelsSimpleStreamOptions,
        { sessionId, signal },
        {},
      ),
    ).toThrow(InvocationCompositionFailure);
  });

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "preserves Pi thinking level %s",
    (reasoning) => {
      const signal = new AbortController().signal;
      expect(
        composeOptions({ reasoning }, { sessionId, signal }),
      ).toMatchObject({ reasoning, sessionId, signal });
    },
  );

  it("preserves all public semantic option families without inventing absence", () => {
    const signal = new AbortController().signal;
    const effective = composeOptions(
      {
        samplingParams: { top_p: 0.7, nested: { values: [1, 2] } },
        cacheRetention: "long",
        thinkingBudgets: { minimal: 128, low: 256, medium: 512, high: 1024 },
        metadata: { user_id: "safe-id" },
      },
      { sessionId, signal },
    );

    expect(effective).toEqual({
      samplingParams: { top_p: 0.7, nested: { values: [1, 2] } },
      cacheRetention: "long",
      thinkingBudgets: { minimal: 128, low: 256, medium: 512, high: 1024 },
      metadata: { user_id: "safe-id" },
      sessionId,
      signal,
    });
    expect(effective).not.toHaveProperty("temperature");
    expect(effective).not.toHaveProperty("maxTokens");
  });

  it("keeps every optional Pi fact absent when its owner omits it", () => {
    const signal = new AbortController().signal;
    expect(composeOptions({}, { sessionId, signal })).toEqual({ sessionId, signal });
  });

  it.each(["none", "short", "long"] as const)(
    "preserves Pi cache retention %s",
    (cacheRetention) => {
      const effective = composeOptions(
        { cacheRetention },
        { sessionId, signal: new AbortController().signal },
      );
      expect(effective.cacheRetention).toBe(cacheRetention);
    },
  );

  it("preserves JSON null inside sampling while rejecting null Pi option fields", () => {
    const infrastructure = {
      sessionId,
      signal: new AbortController().signal,
    };
    expect(
      composeOptions({ samplingParams: { optional_extension: null } }, infrastructure),
    ).toHaveProperty("samplingParams.optional_extension", null);

    for (const options of [
      { reasoning: null },
      { cacheRetention: null },
      { thinkingBudgets: null },
      { metadata: null },
    ]) {
      expect(() =>
        composeOptions(options as unknown as ModelsSimpleStreamOptions, infrastructure),
      ).toThrow(InvocationCompositionFailure);
    }
  });

  it("gives infrastructure exclusive ownership of public execution controls", async () => {
    const signal = new AbortController().signal;
    const onPayload = () => undefined;
    const onResponse = () => undefined;
    const transformHeaders = (headers: Record<string, string | null>) => headers;
    const telemetryContext = {
      startSpan: async <T>(
        _options: { name: string },
        callback: (span: never) => T | Promise<T>,
      ): Promise<T> => callback({} as never),
    };
    const effective = composeOptions(
      { maxTokens: 10 },
      {
        sessionId,
        signal,
        apiKey: "infrastructure-secret",
        telemetryContext,
        env: { SAFE_PROVIDER_VALUE: "value" },
        headers: { "x-safe-extension": "value" },
        transport: "auto",
        timeoutMs: 1000,
        websocketConnectTimeoutMs: 750,
        maxRetries: 2,
        maxRetryDelayMs: 500,
        onPayload,
        onResponse,
        transformHeaders,
      },
    );

    expect(effective).toMatchObject({
      sessionId,
      signal,
      apiKey: "infrastructure-secret",
      telemetryContext,
      env: { SAFE_PROVIDER_VALUE: "value" },
      headers: { "x-safe-extension": "value" },
      transport: "auto",
      timeoutMs: 1000,
      websocketConnectTimeoutMs: 750,
      maxRetries: 2,
      maxRetryDelayMs: 500,
      onPayload,
      onResponse,
      transformHeaders,
    });
    await effective.onResponse?.(
      { status: 200, headers: {} },
      {} as Parameters<NonNullable<typeof effective.onResponse>>[1],
    );
  });

  it("returns detached immutable nested snapshots safe across retries", () => {
    const samplingParams = { top_p: 0.5, nested: { values: [1] } };
    const thinkingBudgets = { high: 1024 };
    const headers = { "x-extension": "initial" };
    const env = { SAFE_PROVIDER_VALUE: "initial" };
    const effective = composeOptions(
      { samplingParams, thinkingBudgets },
      { sessionId, signal: new AbortController().signal, headers, env },
    );

    samplingParams.top_p = 0.9;
    samplingParams.nested.values.push(2);
    thinkingBudgets.high = 2048;
    headers["x-extension"] = "changed";
    env.SAFE_PROVIDER_VALUE = "changed";
    expect(effective.samplingParams).toEqual({
      top_p: 0.5,
      nested: { values: [1] },
    });
    expect(effective.thinkingBudgets).toEqual({ high: 1024 });
    expect(effective.headers).toEqual({ "x-extension": "initial" });
    expect(effective.env).toEqual({ SAFE_PROVIDER_VALUE: "initial" });
    expect(Object.isFrozen(effective)).toBe(true);
    expect(Object.isFrozen(effective.samplingParams)).toBe(true);
    expect(
      Object.isFrozen((effective.samplingParams?.nested as { values: number[] }).values),
    ).toBe(true);
    expect(Object.isFrozen(effective.headers)).toBe(true);
    expect(Object.isFrozen(effective.env)).toBe(true);
  });

  it.each([
    ["null options bag", null],
    ["zero max tokens", { maxTokens: 0 }],
    ["fractional max tokens", { maxTokens: 1.5 }],
    ["non-finite temperature", { temperature: Number.POSITIVE_INFINITY }],
    ["null user id", { metadata: { user_id: null } }],
    ["invalid cache", { cacheRetention: "forever" }],
    ["unknown budget", { thinkingBudgets: { max: 1 } }],
    ["zero budget", { thinkingBudgets: { high: 0 } }],
    ["fractional budget", { thinkingBudgets: { low: 1.5 } }],
    ["array sampling", { samplingParams: [] }],
    ["non-finite sampling", { samplingParams: { top_p: Number.NaN } }],
    ["mutable sampling class", { samplingParams: { custom: new Date() } }],
    ["null maxTokens", { maxTokens: null }],
    ["null reasoning", { reasoning: null }],
    ["null cache", { cacheRetention: null }],
    ["null budgets", { thinkingBudgets: null }],
    ["undefined sampling value", { samplingParams: { top_p: undefined } }],
  ])("rejects invalid Pi semantic option: %s", (_name, protocol) => {
    expect(() =>
      composeOptions(
        protocol as ModelsSimpleStreamOptions,
        { sessionId, signal: new AbortController().signal },
      ),
    ).toThrow(InvocationCompositionFailure);
  });

  it("rejects cyclic sampling snapshots deterministically", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      composeOptions(
        { samplingParams: cyclic },
        { sessionId, signal: new AbortController().signal },
      ),
    ).toThrow(InvocationCompositionFailure);
  });

  it.each([
    ["credential", { apiKey: "client-secret" }],
    ["reserved headers", { headers: { authorization: "client-secret" } }],
    ["signal", { signal: new AbortController().signal }],
    ["session", { sessionId: "client-session" }],
    ["request timeout", { timeoutMs: 1 }],
    ["response callback", { onResponse: () => undefined }],
    ["deferred lifecycle", { deferred: true }],
  ])("rejects Client ownership of infrastructure field: %s", (_name, field) => {
    expect(() =>
      composeOptions(
        field as ModelsSimpleStreamOptions,
        { sessionId, signal: new AbortController().signal },
      ),
    ).toThrow(InvocationCompositionFailure);
  });

  it.each([
    ["empty credential", { apiKey: "" }],
    ["zero timeout", { timeoutMs: 0 }],
    ["negative retries", { maxRetries: -1 }],
    ["fractional retry delay", { maxRetryDelayMs: 1.5 }],
    ["zero websocket timeout", { websocketConnectTimeoutMs: 0 }],
    ["invalid transport", { transport: "pipe" }],
    ["invalid header value", { headers: { "x-value": 1 } }],
    ["invalid environment value", { env: { VALUE: null } }],
    ["custom fetch", { fetch: async () => new Response() }],
    ["unknown fact", { providerOptions: {} }],
  ])("rejects invalid infrastructure fact: %s", (_name, field) => {
    expect(() =>
      composeOptions(
        {},
        {
          sessionId,
          signal: new AbortController().signal,
          ...field,
        } as never,
      ),
    ).toThrow(InvocationCompositionFailure);
  });

  it.each([
    ["reserved user id", { metadata: { user_id: "default" } }],
    ["reserved project", { metadata: { projectDir: "D:/other" } }],
    ["unknown metadata", { metadata: { trace: "value" } }],
    ["session override", { sessionId: "override" }],
    ["signal override", { signal: new AbortController().signal }],
    ["reasoning", { reasoning: "high" }],
    ["deferred", { deferred: true }],
    ["sampling", { samplingParams: { top_p: 0.5 } }],
    ["cache", { cacheRetention: "long" }],
    ["payload callback", { onPayload: () => undefined }],
  ])("rejects unclassified Router default: %s", (_name, defaults) => {
    expect(() =>
      composeOptions(
        { maxTokens: 10 },
        { sessionId, signal: new AbortController().signal },
        defaults,
      ),
    ).toThrow(InvocationCompositionFailure);
  });

  it.each([
    ["credential", { apiKey: "client-secret" }],
    ["headers", { headers: { authorization: "client-secret" } }],
    ["signal", { signal: new AbortController().signal }],
    ["timeout", { timeoutMs: 1 }],
    ["callback", { onResponse: () => undefined }],
  ])("rejects Client ownership of infrastructure option: %s", (_name, option) => {
    expect(() => composeOptions(
      option as ModelsSimpleStreamOptions,
      { sessionId, signal: new AbortController().signal },
    )).toThrow(InvocationCompositionFailure);
  });

  it("rejects protocol metadata written by a non-owner", () => {
    expect(() =>
      composeOptions(
        {
          maxTokens: 10,
          metadata: { projectDir: "client", extra: true },
        } as ModelsSimpleStreamOptions,
        { sessionId, signal: new AbortController().signal },
        {},
      ),
    ).toThrow(InvocationCompositionFailure);
  });
});
