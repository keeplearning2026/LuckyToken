import type { Context, FetchFunction, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  commandCodePrivateApiId,
  commandCodePrivateProviderId,
  prepareCommandCodeRequest,
  type CommandCodePreparationDependencies,
} from "../../src/providers/commandcode-private/provider.js";
import { createEmptyServerConfig } from "../../src/providers/commandcode-private/project.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("serialization fixture expected an object");
  }
  return value as Record<string, unknown>;
}

function model(): Model<typeof commandCodePrivateApiId> {
  return {
    id: "model",
    name: "model",
    api: commandCodePrivateApiId,
    provider: commandCodePrivateProviderId,
    baseUrl: "https://fixture.test/prefix",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 100,
  };
}

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};
const fetch: FetchFunction = async () => {
  throw new Error("preparation tests must not fetch");
};
const dependencies: CommandCodePreparationDependencies = {
  boundFetch: fetch,
  projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
  compatibility: {},
  createSessionId: () => "00000000-0000-4000-8000-000000000091",
};
const baseOptions: SimpleStreamOptions = {
  maxTokens: 20,
  sessionId: "00000000-0000-4000-8000-000000000091",
};

describe("CommandCode payload serialization boundary", () => {
  it("uses a replacement, serializes it once, and freezes stable prepared bytes", async () => {
    let toJsonCalls = 0;
    const prepared = await prepareCommandCodeRequest(
      model(),
      context,
      {
        ...baseOptions,
        onPayload: (payload) => ({
          toJSON: () => {
            toJsonCalls += 1;
            return { ...record(payload), mode: "replacement-mode" };
          },
        }),
      },
      dependencies,
    );

    expect(toJsonCalls).toBe(1);
    expect(JSON.parse(prepared.bodyText)).toMatchObject({
      mode: "replacement-mode",
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.headers)).toBe(true);
    const first = prepared.bodyText;
    const second = prepared.bodyText;
    expect(new TextEncoder().encode(first)).toEqual(new TextEncoder().encode(second));
  });

  it("resolves global fetch only when request and bound defaults are absent", async () => {
    const prepared = await prepareCommandCodeRequest(
      model(),
      context,
      baseOptions,
      {
        projectSnapshot: dependencies.projectSnapshot,
        compatibility: {},
        createSessionId: dependencies.createSessionId,
      },
    );

    expect(prepared.fetchImpl).toBe(globalThis.fetch);
  });

  it.each([
    {
      name: "root toJSON changes authority",
      callback: (payload: unknown) => ({
        toJSON: () => ({
          ...record(payload),
          threadId: "00000000-0000-4000-8000-000000000092",
        }),
      }),
    },
    {
      name: "nested toJSON changes stream",
      callback: (payload: unknown) => {
        const params = record(record(payload).params);
        params.toJSON = () => ({ ...params, toJSON: undefined, stream: false });
      },
    },
    {
      name: "undefined removes a required field",
      callback: (payload: unknown) => {
        record(record(payload).params).model = undefined;
      },
    },
  ])("validates serialized semantics when $name", async ({ callback }) => {
    await expect(
      prepareCommandCodeRequest(
        model(),
        context,
        { ...baseOptions, onPayload: callback },
        dependencies,
      ),
    ).rejects.toThrow();
  });

  it("lets cancellation win an async callback and observes its late rejection", async () => {
    const controller = new AbortController();
    let rejectCallback: ((reason: Error) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let toJsonCalls = 0;
    const callbackResult = new Promise<never>((_resolve, reject) => {
      rejectCallback = reject;
    });
    const preparing = prepareCommandCodeRequest(
      model(),
      context,
      {
        ...baseOptions,
        signal: controller.signal,
        onPayload: (payload) => {
          record(payload).toJSON = () => {
            toJsonCalls += 1;
            return payload;
          };
          markStarted?.();
          return callbackResult;
        },
      },
      dependencies,
    );
    await started;
    controller.abort(new Error("caller cancelled"));

    await expect(preparing).rejects.toThrow("caller cancelled");
    expect(toJsonCalls).toBe(0);
    rejectCallback?.(new Error("late callback rejection"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toJsonCalls).toBe(0);
  });
});
