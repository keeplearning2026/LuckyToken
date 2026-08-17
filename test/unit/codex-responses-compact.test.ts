import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { ClientProtocolHandler } from "../../src/http.js";
import type { CodexLocalCredentialAuthority } from "../../src/integrations/codex/local-auth.js";
import type { CodexNativeModelSource } from "../../src/integrations/codex/native-models.js";
import {
  CODEX_COMPACT_PROMPT,
  createCodexResponsesCompactHandler,
} from "../../src/integrations/codex/compact.js";

function localAuth(): CodexLocalCredentialAuthority {
  return Object.freeze({
    isAvailable: async () => true,
    authorizeToken: async (token: string) => (token === "codex-token" ? {} : undefined),
    resolveForwardAuth: async (headers: Headers) =>
      headers.get("authorization") === "Bearer codex-token"
        ? { authorization: "Bearer codex-token", accountId: "acct" }
        : undefined,
    scrub: (value: string) => value,
  });
}

function nativeModels(...ids: string[]): CodexNativeModelSource {
  const models = new Set(ids);
  return Object.freeze({
    has: (id: string) => models.has(id),
    models: () => Object.freeze([]),
  });
}

function compactRequest(model: string, input: unknown[]): Request {
  return new Request("http://luckytoken.test/v1/responses/compact", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-token",
      "chatgpt-account-id": "acct-request",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input }),
  });
}

describe("Codex Responses compact integration", () => {
  it("forwards native Codex compact requests to the native ChatGPT compact endpoint", async () => {
    const requests: Request[] = [];
    const delegate = { handle: vi.fn() } as unknown as ClientProtocolHandler;
    const fetch: FetchFunction = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ output: [{ type: "message", role: "user", content: [] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const handler = createCodexResponsesCompactHandler({
      codexLocalAuth: localAuth(),
      codexNativeModels: nativeModels("gpt-native"),
      responsesHandler: delegate,
      fetch,
      maxRequestBytes: 1024 * 1024,
    });

    const response = await handler.handle(
      compactRequest("gpt-native", [{ type: "message", role: "user", content: "hello" }]),
    );

    expect(response.status).toBe(200);
    expect(delegate.handle).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer codex-token");
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct-request");
  });

  it("compacts routed aliases by asking the existing Responses handler for a summary", async () => {
    const delegated: Request[] = [];
    const delegate: ClientProtocolHandler = {
      method: "POST",
      pathname: "/v1/responses",
      handle: async (request) => {
        delegated.push(request.clone());
        return new Response(
          JSON.stringify({
            id: "resp_summary",
            object: "response",
            status: "completed",
            model: "anthropic/claude",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "SUMMARY BODY", annotations: [] }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    };
    const handler = createCodexResponsesCompactHandler({
      codexLocalAuth: localAuth(),
      codexNativeModels: nativeModels("gpt-native"),
      responsesHandler: delegate,
      fetch: async () => {
        throw new Error("native fetch must not run");
      },
      maxRequestBytes: 1024 * 1024,
    });
    const response = await handler.handle(
      compactRequest("anthropic/claude", [
        { type: "message", role: "user", content: [{ type: "input_text", text: "FIRST" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "SECOND" }] },
      ]),
    );

    expect(response.status).toBe(200);
    expect(delegated).toHaveLength(1);
    const internal = (await delegated[0]?.json()) as Record<string, unknown>;
    expect(internal).toMatchObject({
      model: "anthropic/claude",
      stream: false,
      store: false,
    });
    expect(JSON.stringify(internal)).toContain(CODEX_COMPACT_PROMPT);

    const body = (await response.json()) as { output: Array<Record<string, unknown>> };
    expect(body.output).toHaveLength(3);
    expect(JSON.stringify(body.output[0])).toContain("FIRST");
    expect(JSON.stringify(body.output[1])).toContain("SECOND");
    expect(JSON.stringify(body.output[2])).toContain("SUMMARY BODY");
  });

  it("returns a legal error when the routed summary turn completes without text", async () => {
    const delegate: ClientProtocolHandler = {
      method: "POST",
      pathname: "/v1/responses",
      handle: async () =>
        new Response(
          JSON.stringify({ object: "response", status: "completed", output: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    };
    const handler = createCodexResponsesCompactHandler({
      codexLocalAuth: localAuth(),
      codexNativeModels: nativeModels(),
      responsesHandler: delegate,
      fetch: async () => {
        throw new Error("unused");
      },
      maxRequestBytes: 1024 * 1024,
    });

    const response = await handler.handle(compactRequest("alias", []));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "api_error" },
    });
  });
});
