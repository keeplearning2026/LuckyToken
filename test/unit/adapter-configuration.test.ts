import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { parseFailureLoggingConfiguration } from "../../src/invocation-diagnostics/configuration.js";
import {
  bindCommandCodeConfiguration,
  parseCommandCodeConfiguration,
} from "../../packages/provider-commandcode-private/src/configuration.js";
import { MAX_TIMER_DELAY_MS } from "../../packages/provider-commandcode-private/src/attempts.js";
import {
  bindAnthropicConfiguration,
  parseAnthropicConfiguration,
} from "../../src/protocols/anthropic/configuration.js";
import {
  bindOpenAIResponsesConfiguration,
  parseOpenAIResponsesConfiguration,
} from "../../src/protocols/openai-responses/configuration.js";

type InvalidCase = readonly [parse: () => unknown, path: string];

function expectFrozen(values: readonly unknown[]): void {
  for (const value of values) expect(Object.isFrozen(value)).toBe(true);
}

describe("adapter-owned configuration", () => {
  it("defaults and deeply freezes every independent snapshot", () => {
    const anthropic = parseAnthropicConfiguration();
    expect(anthropic).toEqual({
      conversion: {
        request: {
          unknownContent: "error",
          unresolvedToolCall: "xrepair",
          localCacheControl: "ignore",
        },
        response: { unknownPiContent: "error" },
      },
    });
    expectFrozen([
      anthropic,
      anthropic.conversion,
      anthropic.conversion.request,
      anthropic.conversion.response,
    ]);

    const responses = parseOpenAIResponsesConfiguration();
    expect(responses).toEqual({
      conversion: {
        request: {
          privilegedMessages: "first",
          unknownInputItem: "error",
          orphanToolOutput: "error",
          unresolvedToolCall: "xrepair",
          futureReasoningEffort: "max",
        },
        response: { unknownPiContent: "error", storeFalse: "honor" },
      },
    });
    expectFrozen([
      responses,
      responses.conversion,
      responses.conversion.request,
      responses.conversion.response,
    ]);

    const commandCode = parseCommandCodeConfiguration();
    expect(commandCode).toEqual({
      conversion: {
        request: { syntheticMissingToolResultOutputType: "text" },
        response: { pauseTurn: "stop", unknownEvent: "error" },
      },
      request: {
        transport: {
          timeoutMs: null,
          maxRetries: 0,
          maxRetryDelayMs: 60_000,
        },
      },
      response: {
        errorCapture: {
          bodyReadTimeoutMs: 5_000,
          maxBodyBytes: 65_536,
          maxClientMessageChars: 4_096,
        },
      },
    });
    expectFrozen([
      commandCode,
      commandCode.conversion,
      commandCode.conversion.request,
      commandCode.conversion.response,
      commandCode.request,
      commandCode.request.transport,
      commandCode.response,
      commandCode.response.errorCapture,
    ]);

    const failureLogging = parseFailureLoggingConfiguration({}, resolve("config-root"));
    expect(failureLogging).toEqual({
      directory: resolve("config-root", "logs", "failed-requests"),
      detail: "safe",
      maxFileBytes: 1_048_576,
      retentionDays: 30,
      maxFiles: 1_000,
      logCancellation: true,
    });
    expectFrozen([failureLogging]);
  });

  it("accepts every frozen enum value", () => {
    for (const value of ["error", "ignore"] as const) {
      expect(
        parseAnthropicConfiguration({
          conversion: { request: { unknownContent: value } },
        }).conversion.request.unknownContent,
      ).toBe(value);
      expect(
        parseAnthropicConfiguration({
          conversion: { response: { unknownPiContent: value } },
        }).conversion.response.unknownPiContent,
      ).toBe(value);
      expect(
        parseOpenAIResponsesConfiguration({
          conversion: { request: { unknownInputItem: value } },
        }).conversion.request.unknownInputItem,
      ).toBe(value);
      expect(
        parseOpenAIResponsesConfiguration({
          conversion: { request: { orphanToolOutput: value } },
        }).conversion.request.orphanToolOutput,
      ).toBe(value);
      expect(
        parseOpenAIResponsesConfiguration({
          conversion: { response: { unknownPiContent: value } },
        }).conversion.response.unknownPiContent,
      ).toBe(value);
      expect(
        parseCommandCodeConfiguration({
          conversion: { response: { unknownEvent: value } },
        }).conversion.response.unknownEvent,
      ).toBe(value);
    }
    for (const value of ["error", "xrepair"] as const) {
      expect(
        parseAnthropicConfiguration({
          conversion: { request: { unresolvedToolCall: value } },
        }).conversion.request.unresolvedToolCall,
      ).toBe(value);
      expect(
        parseOpenAIResponsesConfiguration({
          conversion: { request: { unresolvedToolCall: value } },
        }).conversion.request.unresolvedToolCall,
      ).toBe(value);
    }
    for (const value of ["ignore", "promote"] as const) {
      expect(
        parseAnthropicConfiguration({
          conversion: { request: { localCacheControl: value } },
        }).conversion.request.localCacheControl,
      ).toBe(value);
    }
    for (const value of ["full", "first", "user"] as const) {
      expect(
        parseOpenAIResponsesConfiguration({
          conversion: { request: { privilegedMessages: value } },
        }).conversion.request.privilegedMessages,
      ).toBe(value);
    }
    for (const value of ["max", "omit", "error"] as const) {
      expect(
        parseOpenAIResponsesConfiguration({
          conversion: { request: { futureReasoningEffort: value } },
        }).conversion.request.futureReasoningEffort,
      ).toBe(value);
    }
    for (const value of ["honor", "memory", "persist"] as const) {
      expect(
        parseOpenAIResponsesConfiguration({
          conversion: { response: { storeFalse: value } },
        }).conversion.response.storeFalse,
      ).toBe(value);
    }
    for (const value of ["text", "error-text"] as const) {
      expect(
        parseCommandCodeConfiguration({
          conversion: {
            request: { syntheticMissingToolResultOutputType: value },
          },
        }).conversion.request.syntheticMissingToolResultOutputType,
      ).toBe(value);
    }
    for (const value of ["stop", "error"] as const) {
      expect(
        parseCommandCodeConfiguration({
          conversion: { response: { pauseTurn: value } },
        }).conversion.response.pauseTurn,
      ).toBe(value);
    }
    for (const value of ["safe", "full"] as const) {
      expect(
        parseFailureLoggingConfiguration({ detail: value }, resolve("config-root"))
          .detail,
      ).toBe(value);
    }
  });

  it.each<InvalidCase>([
    [() => parseAnthropicConfiguration(null), "clientProtocols.anthropic-messages"],
    [
      () => parseAnthropicConfiguration({ extra: true }),
      "clientProtocols.anthropic-messages.extra",
    ],
    [
      () => parseAnthropicConfiguration({ conversion: [] }),
      "clientProtocols.anthropic-messages.conversion",
    ],
    [
      () => parseAnthropicConfiguration({ conversion: { extra: true } }),
      "clientProtocols.anthropic-messages.conversion.extra",
    ],
    [
      () => parseAnthropicConfiguration({ conversion: { request: null } }),
      "clientProtocols.anthropic-messages.conversion.request",
    ],
    [
      () =>
        parseAnthropicConfiguration({
          conversion: { request: { extra: true } },
        }),
      "clientProtocols.anthropic-messages.conversion.request.extra",
    ],
    [
      () => parseAnthropicConfiguration({ conversion: { response: "bad" } }),
      "clientProtocols.anthropic-messages.conversion.response",
    ],
    [
      () =>
        parseAnthropicConfiguration({
          conversion: { response: { extra: true } },
        }),
      "clientProtocols.anthropic-messages.conversion.response.extra",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { request: { unknownInputItem: "drop" } },
        }),
      "clientProtocols.openai-responses.conversion.request.unknownInputItem",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          conversion: { response: { pauseTurn: "continue" } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.response.pauseTurn",
    ],
  ])("rejects Anthropic shapes/keys and representative invalid enums %#", (parse, path) => {
    expect(parse).toThrow(path);
  });

  it.each<InvalidCase>([
    [() => parseOpenAIResponsesConfiguration(null), "clientProtocols.openai-responses"],
    [
      () => parseOpenAIResponsesConfiguration({ extra: true }),
      "clientProtocols.openai-responses.extra",
    ],
    [
      () => parseOpenAIResponsesConfiguration({ conversion: [] }),
      "clientProtocols.openai-responses.conversion",
    ],
    [
      () => parseOpenAIResponsesConfiguration({ conversion: { extra: true } }),
      "clientProtocols.openai-responses.conversion.extra",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({ conversion: { request: null } }),
      "clientProtocols.openai-responses.conversion.request",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { request: { extra: true } },
        }),
      "clientProtocols.openai-responses.conversion.request.extra",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({ conversion: { response: [] } }),
      "clientProtocols.openai-responses.conversion.response",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { response: { extra: true } },
        }),
      "clientProtocols.openai-responses.conversion.response.extra",
    ],
  ])("rejects Responses shapes and unknown keys at their precise paths %#", (parse, path) => {
    expect(parse).toThrow(path);
  });

  it.each<InvalidCase>([
    [() => parseCommandCodeConfiguration(null), "providerPackages[\"@luckytoken/provider-commandcode-private\"]"],
    [
      () => parseCommandCodeConfiguration({ extra: true }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].extra",
    ],
    [
      () => parseCommandCodeConfiguration({ conversion: [] }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion",
    ],
    [
      () => parseCommandCodeConfiguration({ conversion: { extra: true } }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.extra",
    ],
    [
      () =>
        parseCommandCodeConfiguration({ conversion: { request: "bad" } }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.request",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          conversion: { request: { extra: true } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.request.extra",
    ],
    [
      () => parseCommandCodeConfiguration({ conversion: { response: null } }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.response",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          conversion: { response: { extra: true } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.response.extra",
    ],
    [
      () => parseCommandCodeConfiguration({ request: [] }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request",
    ],
    [
      () => parseCommandCodeConfiguration({ request: { extra: true } }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.extra",
    ],
    [
      () => parseCommandCodeConfiguration({ request: { transport: false } }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { extra: true } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.extra",
    ],
    [
      () => parseCommandCodeConfiguration({ response: "bad" }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response",
    ],
    [
      () => parseCommandCodeConfiguration({ response: { extra: true } }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.extra",
    ],
    [
      () =>
        parseCommandCodeConfiguration({ response: { errorCapture: [] } }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { extra: true } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.extra",
    ],
  ])("rejects CommandCode shapes and unknown keys at their precise paths %#", (parse, path) => {
    expect(parse).toThrow(path);
  });

  it.each<InvalidCase>([
    [
      () =>
        parseAnthropicConfiguration({
          conversion: { request: { unknownContent: "drop" } },
        }),
      "clientProtocols.anthropic-messages.conversion.request.unknownContent",
    ],
    [
      () =>
        parseAnthropicConfiguration({
          conversion: { request: { unresolvedToolCall: "ignore" } },
        }),
      "clientProtocols.anthropic-messages.conversion.request.unresolvedToolCall",
    ],
    [
      () =>
        parseAnthropicConfiguration({
          conversion: { request: { localCacheControl: "cache" } },
        }),
      "clientProtocols.anthropic-messages.conversion.request.localCacheControl",
    ],
    [
      () =>
        parseAnthropicConfiguration({
          conversion: { response: { unknownPiContent: false } },
        }),
      "clientProtocols.anthropic-messages.conversion.response.unknownPiContent",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { request: { privilegedMessages: "last" } },
        }),
      "clientProtocols.openai-responses.conversion.request.privilegedMessages",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { request: { unknownInputItem: "drop" } },
        }),
      "clientProtocols.openai-responses.conversion.request.unknownInputItem",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { request: { orphanToolOutput: "xrepair" } },
        }),
      "clientProtocols.openai-responses.conversion.request.orphanToolOutput",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { request: { unresolvedToolCall: "ignore" } },
        }),
      "clientProtocols.openai-responses.conversion.request.unresolvedToolCall",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { request: { futureReasoningEffort: "high" } },
        }),
      "clientProtocols.openai-responses.conversion.request.futureReasoningEffort",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { response: { unknownPiContent: null } },
        }),
      "clientProtocols.openai-responses.conversion.response.unknownPiContent",
    ],
    [
      () =>
        parseOpenAIResponsesConfiguration({
          conversion: { response: { storeFalse: false } },
        }),
      "clientProtocols.openai-responses.conversion.response.storeFalse",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          conversion: {
            request: { syntheticMissingToolResultOutputType: "error" },
          },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.request.syntheticMissingToolResultOutputType",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          conversion: { response: { pauseTurn: "continue" } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.response.pauseTurn",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          conversion: { response: { unknownEvent: "drop" } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].conversion.response.unknownEvent",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ detail: "debug" }, resolve("config-root")),
      "failureLogging.detail",
    ],
  ])("rejects every invalid enum at its precise path %#", (parse, path) => {
    expect(parse).toThrow(path);
  });

  it("accepts every numeric boundary", () => {
    const minimum = parseCommandCodeConfiguration({
      request: {
        transport: { timeoutMs: 1, maxRetries: 0, maxRetryDelayMs: 0 },
      },
      response: {
        errorCapture: {
          bodyReadTimeoutMs: 1,
          maxBodyBytes: 1,
          maxClientMessageChars: 1,
        },
      },
    });
    expect(minimum.request.transport).toEqual({
      timeoutMs: 1,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    expect(minimum.response.errorCapture).toEqual({
      bodyReadTimeoutMs: 1,
      maxBodyBytes: 1,
      maxClientMessageChars: 1,
    });

    const maximum = parseCommandCodeConfiguration({
      request: {
        transport: {
          timeoutMs: MAX_TIMER_DELAY_MS,
          maxRetries: 100,
          maxRetryDelayMs: MAX_TIMER_DELAY_MS,
        },
      },
      response: {
        errorCapture: {
          bodyReadTimeoutMs: MAX_TIMER_DELAY_MS,
          maxBodyBytes: 16 * 1024 * 1024,
          maxClientMessageChars: 65_536,
        },
      },
    });
    expect(maximum.request.transport).toEqual({
      timeoutMs: MAX_TIMER_DELAY_MS,
      maxRetries: 100,
      maxRetryDelayMs: MAX_TIMER_DELAY_MS,
    });
    expect(maximum.response.errorCapture).toEqual({
      bodyReadTimeoutMs: MAX_TIMER_DELAY_MS,
      maxBodyBytes: 16 * 1024 * 1024,
      maxClientMessageChars: 65_536,
    });

    const failureMinimum = parseFailureLoggingConfiguration(
      { maxFileBytes: 1_024, retentionDays: 1, maxFiles: 1 },
      resolve("config-root"),
    );
    expect(failureMinimum).toMatchObject({
      maxFileBytes: 1_024,
      retentionDays: 1,
      maxFiles: 1,
    });
    const failureMaximum = parseFailureLoggingConfiguration(
      {
        maxFileBytes: 16 * 1024 * 1024,
        retentionDays: 3_650,
        maxFiles: 1_000_000,
      },
      resolve("config-root"),
    );
    expect(failureMaximum).toMatchObject({
      maxFileBytes: 16 * 1024 * 1024,
      retentionDays: 3_650,
      maxFiles: 1_000_000,
    });
  });

  it.each<InvalidCase>([
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { timeoutMs: 0 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.timeoutMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { timeoutMs: MAX_TIMER_DELAY_MS + 1 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.timeoutMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { maxRetries: -1 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.maxRetries",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { maxRetries: 101 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.maxRetries",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { maxRetryDelayMs: -1 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.maxRetryDelayMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { maxRetryDelayMs: MAX_TIMER_DELAY_MS + 1 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.maxRetryDelayMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { bodyReadTimeoutMs: 0 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.bodyReadTimeoutMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: {
            errorCapture: { bodyReadTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
          },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.bodyReadTimeoutMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { maxBodyBytes: 0 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.maxBodyBytes",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { maxBodyBytes: 16 * 1024 * 1024 + 1 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.maxBodyBytes",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { maxClientMessageChars: 0 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.maxClientMessageChars",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { maxClientMessageChars: 65_537 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.maxClientMessageChars",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ maxFileBytes: 1_023 }, resolve("config-root")),
      "failureLogging.maxFileBytes",
    ],
    [
      () =>
        parseFailureLoggingConfiguration(
          { maxFileBytes: 16 * 1024 * 1024 + 1 },
          resolve("config-root"),
        ),
      "failureLogging.maxFileBytes",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ retentionDays: 0 }, resolve("config-root")),
      "failureLogging.retentionDays",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ retentionDays: 3_651 }, resolve("config-root")),
      "failureLogging.retentionDays",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ maxFiles: 0 }, resolve("config-root")),
      "failureLogging.maxFiles",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ maxFiles: 1_000_001 }, resolve("config-root")),
      "failureLogging.maxFiles",
    ],
  ])("rejects every numeric field outside its safe range %#", (parse, path) => {
    expect(parse).toThrow(path);
  });

  it.each<InvalidCase>([
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { timeoutMs: 1.5 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.timeoutMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { maxRetries: "1" } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.maxRetries",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          request: { transport: { maxRetryDelayMs: Number.NaN } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].request.transport.maxRetryDelayMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { bodyReadTimeoutMs: 1.5 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.bodyReadTimeoutMs",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { maxBodyBytes: "65536" } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.maxBodyBytes",
    ],
    [
      () =>
        parseCommandCodeConfiguration({
          response: { errorCapture: { maxClientMessageChars: 1.5 } },
        }),
      "providerPackages[\"@luckytoken/provider-commandcode-private\"].response.errorCapture.maxClientMessageChars",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ maxFileBytes: 1.5 }, resolve("config-root")),
      "failureLogging.maxFileBytes",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ retentionDays: "30" }, resolve("config-root")),
      "failureLogging.retentionDays",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ maxFiles: Number.NaN }, resolve("config-root")),
      "failureLogging.maxFiles",
    ],
  ])("rejects unsafe numeric types at their precise paths %#", (parse, path) => {
    expect(parse).toThrow(path);
  });

  it.each<InvalidCase>([
    [
      () => parseFailureLoggingConfiguration([], resolve("config-root")),
      "failureLogging",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ extra: true }, resolve("config-root")),
      "failureLogging.extra",
    ],
    [
      () =>
        parseFailureLoggingConfiguration({ directory: "" }, resolve("config-root")),
      "failureLogging.directory",
    ],
    [
      () =>
        parseFailureLoggingConfiguration(
          { logCancellation: "yes" },
          resolve("config-root"),
        ),
      "failureLogging.logCancellation",
    ],
  ])("rejects failure logging shapes and unknown values %#", (parse, path) => {
    expect(parse).toThrow(path);
  });

  it("keeps owner snapshots opaque and rejects plain or cross-owner values", () => {
    const anthropic = parseAnthropicConfiguration();
    const responses = parseOpenAIResponsesConfiguration();
    const commandCode = parseCommandCodeConfiguration();

    expect(bindAnthropicConfiguration(anthropic)).toBe(anthropic);
    expect(bindOpenAIResponsesConfiguration(responses)).toBe(responses);
    expect(bindCommandCodeConfiguration(commandCode)).toBe(commandCode);

    expect(() => bindAnthropicConfiguration(responses)).toThrow(
      "not an Anthropic-owned snapshot",
    );
    expect(() => bindAnthropicConfiguration({ ...anthropic })).toThrow(
      "not an Anthropic-owned snapshot",
    );
    expect(() => bindOpenAIResponsesConfiguration(anthropic)).toThrow(
      "not a Responses-owned snapshot",
    );
    expect(() => bindOpenAIResponsesConfiguration({ ...responses })).toThrow(
      "not a Responses-owned snapshot",
    );
    expect(() => bindCommandCodeConfiguration(anthropic)).toThrow(
      "not a CommandCode-owned snapshot",
    );
    expect(() => bindCommandCodeConfiguration({ ...commandCode })).toThrow(
      "not a CommandCode-owned snapshot",
    );
  });

  it("loads non-default owner snapshots and resolves all startup paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-adapter-config-"));
    try {
      const configPath = join(root, "config", "luckytoken.json");
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          clientProtocols: {
            "anthropic-messages": {
              authFile: "auth/anthropic.json",
              conversion: {
                request: {
                  unknownContent: "ignore",
                  unresolvedToolCall: "error",
                  localCacheControl: "promote",
                },
                response: { unknownPiContent: "ignore" },
              },
            },
            "openai-responses": {
              authFile: "auth/responses.json",
              stateFile: "state/responses.json",
              conversion: {
                request: {
                  privilegedMessages: "full",
                  unknownInputItem: "ignore",
                  orphanToolOutput: "ignore",
                  unresolvedToolCall: "error",
                  futureReasoningEffort: "omit",
                },
                response: {
                  unknownPiContent: "ignore",
                  storeFalse: "memory",
                },
              },
            },
          },
          providerPackages: {
            "@luckytoken/provider-commandcode-private": {
              conversion: {
                request: {
                  syntheticMissingToolResultOutputType: "error-text",
                },
                response: { pauseTurn: "error", unknownEvent: "ignore" },
              },
              request: {
                transport: {
                  timeoutMs: 12_345,
                  maxRetries: 2,
                  maxRetryDelayMs: 9_876,
                },
              },
              response: {
                errorCapture: {
                  bodyReadTimeoutMs: 4_321,
                  maxBodyBytes: 32_768,
                  maxClientMessageChars: 2_048,
                },
              },
            },
          },
          failureLogging: {
            directory: "diagnostics/failures",
            detail: "full",
            maxFileBytes: 8_192,
            retentionDays: 7,
            maxFiles: 25,
            logCancellation: false,
          },
          pi: { directory: "pi", modelsJson: "pi/models.json" },
        }),
        "utf8",
      );

      const loaded = await loadLuckyTokenCliConfig(configPath);
      const configDirectory = resolve(root, "config");
      expect(loaded.clientProtocols["anthropic-messages"]?.authFile).toBe(
        join(configDirectory, "auth", "anthropic.json"),
      );
      expect(loaded.clientProtocols["openai-responses"]?.stateFile).toBe(
        join(configDirectory, "state", "responses.json"),
      );
      expect(loaded.pi).toEqual({
        directory: join(configDirectory, "pi"),
        modelsJson: join(configDirectory, "pi", "models.json"),
      });
      expect(loaded.failureLogging).toEqual({
        directory: join(configDirectory, "diagnostics", "failures"),
        detail: "full",
        maxFileBytes: 8_192,
        retentionDays: 7,
        maxFiles: 25,
        logCancellation: false,
      });

      expect(
        bindAnthropicConfiguration(
          loaded.clientProtocols["anthropic-messages"]?.adapterConfiguration,
        ),
      ).toEqual({
        conversion: {
          request: {
            unknownContent: "ignore",
            unresolvedToolCall: "error",
            localCacheControl: "promote",
          },
          response: { unknownPiContent: "ignore" },
        },
      });
      expect(
        bindOpenAIResponsesConfiguration(
          loaded.clientProtocols["openai-responses"]?.adapterConfiguration,
        ),
      ).toEqual({
        conversion: {
          request: {
            privilegedMessages: "full",
            unknownInputItem: "ignore",
            orphanToolOutput: "ignore",
            unresolvedToolCall: "error",
            futureReasoningEffort: "omit",
          },
          response: { unknownPiContent: "ignore", storeFalse: "memory" },
        },
      });
      expect(
        parseCommandCodeConfiguration(
          loaded.providerPackages[
            "@luckytoken/provider-commandcode-private"
          ],
          'providerPackages["@luckytoken/provider-commandcode-private"]',
        ),
      ).toEqual({
        conversion: {
          request: { syntheticMissingToolResultOutputType: "error-text" },
          response: { pauseTurn: "error", unknownEvent: "ignore" },
        },
        request: {
          transport: {
            timeoutMs: 12_345,
            maxRetries: 2,
            maxRetryDelayMs: 9_876,
          },
        },
        response: {
          errorCapture: {
            bodyReadTimeoutMs: 4_321,
            maxBodyBytes: 32_768,
            maxClientMessageChars: 2_048,
          },
        },
      });
      expectFrozen([
        loaded,
        loaded.clientProtocols,
        loaded.clientProtocols["anthropic-messages"],
        loaded.clientProtocols["openai-responses"],
        loaded.providerPackages,
        loaded.failureLogging,
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
