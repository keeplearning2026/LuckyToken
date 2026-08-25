import { afterEach, describe, expect, it } from "vitest";

import type { CodexNativeModelSource } from "../../src/codex-native-seam.js";
import {
  createOpenAIResponsesServingTestComposition,
  type OpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";

const noNativeModels: CodexNativeModelSource = Object.freeze({
  has: () => false,
});

function multipartOffer(): {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
} {
  const boundary = "Token-realtime-boundary";
  return {
    body: new TextEncoder().encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="sdp"',
        "Content-Type: application/sdp",
        "",
        "v=0-offer",
        `--${boundary}`,
        'Content-Disposition: form-data; name="session"',
        "Content-Type: application/json",
        "",
        JSON.stringify({ model: "gpt-live", instructions: "hello" }),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    ),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("Codex Direct Mode realtime HTTP", () => {
  const compositions: OpenAIResponsesServingTestComposition[] = [];

  afterEach(async () => {
    await Promise.all(
      compositions.splice(0).map((composition) => composition.close()),
    );
  });

  it("converts multipart while preserving caller credentials and end-to-end headers", async () => {
    let outbound: Request | undefined;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (input, init) => {
        outbound = new Request(input, init);
        return new Response("v=0-answer", {
          status: 201,
          headers: {
            "content-type": "application/sdp",
            location: "/v1/realtime/calls/rtc_123",
          },
        });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);
    const offer = multipartOffer();

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/realtime/calls?client=desktop%2Fapp&token=query-token", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-owned-token",
          "chatgpt-account-id": "acct-caller",
          "content-type": offer.contentType,
          "openai-alpha": "quicksilver=v2",
          "x-session-id": "rts_123",
          "x-openai-fedramp": "must-not-forward",
        },
        body: offer.body,
      }),
    );

    expect({
      status: response.status,
      location: response.headers.get("location"),
      answer: await response.text(),
      url: outbound?.url,
      contentType: outbound?.headers.get("content-type"),
      authorization: outbound?.headers.get("authorization"),
      accountId: outbound?.headers.get("chatgpt-account-id"),
      alpha: outbound?.headers.get("openai-alpha"),
      sessionId: outbound?.headers.get("x-session-id"),
      acceptEncoding: outbound?.headers.get("accept-encoding"),
      fedramp: outbound?.headers.get("x-openai-fedramp"),
      redirect: outbound?.redirect,
      body: outbound === undefined ? undefined : await outbound.json(),
    }).toEqual({
      status: 201,
      location: "/v1/realtime/calls/rtc_123",
      answer: "v=0-answer",
      url:
        "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas&client=desktop%2Fapp&token=query-token",
      contentType: "application/json",
      authorization: "Bearer caller-owned-token",
      accountId: "acct-caller",
      alpha: "quicksilver=v2",
      sessionId: "rts_123",
      acceptEncoding: "identity",
      fedramp: "must-not-forward",
      redirect: "manual",
      body: {
        sdp: "v=0-offer",
        session: { model: "gpt-live", instructions: "hello" },
      },
    });
  });

  it("keeps an auto-decoded call-create response representation consistent", async () => {
    const decoded = new TextEncoder().encode("v=0-answer");
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () =>
        new Response(decoded, {
          headers: {
            "content-encoding": "br",
            "content-length": "4",
            "content-type": "application/sdp",
          },
        }),
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/live", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );

    expect({
      body: Array.from(new Uint8Array(await response.arrayBuffer())),
      contentEncoding: response.headers.get("content-encoding"),
      contentLength: response.headers.get("content-length"),
    }).toEqual({
      body: Array.from(decoded),
      contentEncoding: null,
      contentLength: null,
    });
  });

  it("converts an SDP-only multipart offer without inventing a session", async () => {
    const boundary = "Token-realtime-sdp-only";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="sdp"',
      "",
      "v=0-sdp-only",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    let outbound: Request | undefined;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (input, init) => {
        outbound = new Request(input, init);
        return new Response("answer", { status: 200 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/realtime/calls", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(outbound === undefined ? undefined : await outbound.json()).toEqual({
      sdp: "v=0-sdp-only",
    });
  });

  it("preserves a Frameless JSON request at the same ChatGPT call-create wire", async () => {
    const body = new TextEncoder().encode(
      '{"sdp":"v=0-frameless","session":{"model":"gpt-live"}}',
    );
    let outbound: Request | undefined;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async (input, init) => {
        outbound = new Request(input, init);
        return new Response("answer", { status: 200 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/live", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-type": "application/json",
        },
        body,
      }),
    );

    expect({
      status: response.status,
      url: outbound?.url,
      body:
        outbound === undefined
          ? undefined
          : Array.from(new Uint8Array(await outbound.arrayBuffer())),
    }).toEqual({
      status: 200,
      url:
        "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
      body: Array.from(body),
    });
  });

  it("rejects malformed and oversized input locally but delegates auth to upstream", async () => {
    let upstreamCalls = 0;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        upstreamCalls += 1;
        return new Response("upstream denied", { status: 401 });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);
    const multipart = (parts: string[]) => {
      const boundary = "invalid-realtime-boundary";
      return new Request("http://Token.test/v1/realtime/calls", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: [...parts, `--${boundary}--`, ""].join("\r\n"),
      });
    };
    const missingSdp = await composition.runtime.handle(
      multipart([
        "--invalid-realtime-boundary",
        'Content-Disposition: form-data; name="other"',
        "",
        "value",
      ]),
    );
    const invalidSession = await composition.runtime.handle(
      multipart([
        "--invalid-realtime-boundary",
        'Content-Disposition: form-data; name="sdp"',
        "",
        "v=0",
        "--invalid-realtime-boundary",
        'Content-Disposition: form-data; name="session"',
        "",
        "{not-json",
      ]),
    );
    const unauthorized = await composition.runtime.handle(
      new Request("http://Token.test/v1/live", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
        body: "{}",
      }),
    );
    const oversized = await composition.runtime.handle(
      new Request("http://Token.test/v1/live", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-length": String(16 * 1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );

    expect({
      statuses: [
        missingSdp.status,
        invalidSession.status,
        unauthorized.status,
        oversized.status,
      ],
      upstreamCalls,
    }).toEqual({ statuses: [400, 400, 401, 413], upstreamCalls: 1 });
  });

  it("rejects an actually oversized streamed call-create body", async () => {
    let upstreamCalls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        upstreamCalls += 1;
        return new Response("unexpected");
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 17) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
    });

    const response = await composition.runtime.handle(
      new Request("http://Token.test/v1/live", {
        method: "POST",
        headers: {
          authorization: "Bearer codex-token",
          "content-type": "application/json",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect([response.status, upstreamCalls]).toEqual([413, 0]);
  });

  it("preserves non-2xx responses and maps transport failure without retry", async () => {
    let calls = 0;
    let failTransport = false;
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () => {
        calls += 1;
        if (failTransport) throw new Error("connection refused");
        return new Response(Uint8Array.from([0xba, 0xd0]), {
          status: 503,
          statusText: "Voice Unavailable",
          headers: {
            "content-type": "application/octet-stream",
            "x-safe-upstream": "preserve-me",
            "set-cookie": "secret=cookie",
          },
        });
      },
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: noNativeModels,
    });
    compositions.push(composition);
    const request = () =>
      composition.runtime.handle(
        new Request("http://Token.test/v1/live", {
          method: "POST",
          headers: {
            authorization: "Bearer codex-token",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );

    const upstreamError = await request();
    expect({
      status: upstreamError.status,
      statusText: upstreamError.statusText,
      body: Array.from(new Uint8Array(await upstreamError.arrayBuffer())),
      safe: upstreamError.headers.get("x-safe-upstream"),
      cookie: upstreamError.headers.get("set-cookie"),
    }).toEqual({
      status: 503,
      statusText: "Voice Unavailable",
      body: [0xba, 0xd0],
      safe: "preserve-me",
      cookie: "secret=cookie",
    });
    failTransport = true;
    expect((await request()).status).toBe(502);
    expect(calls).toBe(2);
  });
});
