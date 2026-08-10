import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { HttpRequestAbortedError } from "../../src/http.js";
import type {
  ProjectSnapshot,
  ServerConfig,
} from "../../src/providers/commandcode-private/project.js";
import { createLuckyTokenRuntime } from "../../src/runtime.js";

const sessionId = "00000000-0000-4000-8000-000000000030";

const projectConfig: ServerConfig = {
  workingDir: "/Workspace/My App",
  date: "2026-08-10",
  environment: "linux",
  structure: ["src"],
  isGitRepo: true,
  currentBranch: "main",
  mainBranch: "main",
  gitStatus: "Working tree clean",
  recentCommits: ["abc123 initial"],
};

function successResponse(): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text: "ok" }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ].join("\n"),
  );
}

function request(signal?: AbortSignal): Request {
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "model",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    }),
  };
  if (signal !== undefined) init.signal = signal;
  return new Request("http://luckytoken.test/v1/messages", init);
}

describe("CommandCode project identity", () => {
  it("keeps a project-less request typed and performs no snapshot work", async () => {
    let upstreamRequest: Request | undefined;
    const fetch: FetchFunction = async (input, init) => {
      upstreamRequest = new Request(input, init);
      return successResponse();
    };
    const projectSnapshot: ProjectSnapshot = {
      snapshot: vi.fn(async () => projectConfig),
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "upstream-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch,
      modelId: "model",
      createMessageId: () => "msg",
      createSessionId: () => sessionId,
      projectSnapshot,
    });

    expect((await runtime.handle(request())).status).toBe(200);
    expect(projectSnapshot.snapshot).not.toHaveBeenCalled();
    expect(upstreamRequest?.headers.get("x-project-slug")).toBeNull();
    const body: unknown = await upstreamRequest?.json();
    expect(body).toMatchObject({
      config: {
        workingDir: "",
        date: "",
        environment: "",
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
    });
  });

  it("derives one snapshot and late slug from the same project directory", async () => {
    let upstreamRequest: Request | undefined;
    const fetch: FetchFunction = async (input, init) => {
      upstreamRequest = new Request(input, init);
      return successResponse();
    };
    const projectSnapshot: ProjectSnapshot = {
      snapshot: vi.fn(async () => projectConfig),
    };
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "upstream-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch,
      modelId: "model",
      createMessageId: () => "msg",
      createSessionId: () => sessionId,
      projectDir: "/Workspace/My App",
      projectSnapshot,
    });

    expect((await runtime.handle(request())).status).toBe(200);
    expect(projectSnapshot.snapshot).toHaveBeenCalledTimes(1);
    expect(projectSnapshot.snapshot).toHaveBeenCalledWith({
      projectDir: "/Workspace/My App",
      signal: expect.any(AbortSignal),
    });
    expect(upstreamRequest?.headers.get("x-project-slug")).toBe(
      "workspace-my-app",
    );
    const body: unknown = await upstreamRequest?.json();
    expect(body).toMatchObject({ config: projectConfig });
  });

  it("discards an in-flight snapshot on cancellation and never starts fetch", async () => {
    let completeSnapshot: ((config: ServerConfig) => void) | undefined;
    let snapshotSignal: AbortSignal | undefined;
    let fetchCalls = 0;
    const fetch: FetchFunction = async () => {
      fetchCalls += 1;
      return successResponse();
    };
    let markSnapshotStarted: (() => void) | undefined;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    const projectSnapshot: ProjectSnapshot = {
      snapshot: async ({ signal }) => {
        snapshotSignal = signal;
        markSnapshotStarted?.();
        return await new Promise<ServerConfig>((resolve) => {
          completeSnapshot = resolve;
        });
      },
    };
    const controller = new AbortController();
    const runtime = createLuckyTokenRuntime({
      clientApiKey: "client-key",
      commandCodeApiKey: "upstream-key",
      commandCodeBaseUrl: "https://fixture.commandcode.test",
      fetch,
      modelId: "model",
      createMessageId: () => "msg",
      createSessionId: () => sessionId,
      projectDir: "/Workspace/My App",
      projectSnapshot,
    });

    const handling = runtime.handle(request(controller.signal));
    await snapshotStarted;
    controller.abort();
    await expect(handling).rejects.toBeInstanceOf(HttpRequestAbortedError);
    expect(snapshotSignal?.aborted).toBe(true);
    expect(fetchCalls).toBe(0);

    completeSnapshot?.(projectConfig);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCalls).toBe(0);
  });
});
