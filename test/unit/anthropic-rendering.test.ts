import { describe, expect, it } from "vitest";

import { createUpstreamFailureFact } from "@luckytoken/provider-contract/diagnostics";
import type { AnthropicResponseMessage } from "../../src/protocols/anthropic/response.js";
import {
  createAnthropicAtomicSseEvents,
  renderAnthropicAtomicSse,
} from "../../src/protocols/anthropic/sse.js";
import {
  renderAnthropicError,
  renderAnthropicJsonSuccess,
} from "../../src/protocols/anthropic/wire.js";
import {
  mapUpstreamFailureFact,
  requestIdFromFact,
} from "../../src/protocols/anthropic/failure-rendering.js";

function target(): AnthropicResponseMessage {
  return {
    id: "msg_1",
    container: null,
    content: [
      { citations: null, text: "hello", type: "text" },
      { signature: "sig", thinking: "reason", type: "thinking" },
      { data: "opaque", type: "redacted_thinking" },
      {
        id: "call",
        caller: { type: "direct" },
        input: { x: 1 },
        name: "tool",
        type: "tool_use",
      },
    ],
    model: "client-selector",
    role: "assistant",
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: {
        ephemeral_1h_input_tokens: 2,
        ephemeral_5m_input_tokens: 3,
      },
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 20,
      output_tokens_details: { thinking_tokens: 7 },
      server_tool_use: null,
      service_tier: null,
    },
  };
}

describe("10: Anthropic rendering and errors", () => {
  it("renders the complete selected profile envelope as JSON", () => {
    const rendered = renderAnthropicJsonSuccess(target());
    expect(rendered.status).toBe(200);
    expect(rendered.contentType).toBe("application/json");
    const parsed = JSON.parse(new TextDecoder().decode(rendered.body)) as Record<
      string,
      unknown
    >;
    expect(parsed).toMatchObject({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "client-selector",
      container: null,
      stop_details: null,
      stop_reason: "tool_use",
      stop_sequence: null,
    });
    const content = parsed.content as Array<{ type: string }>;
    expect(content.map((block) => block.type)).toEqual([
      "text",
      "thinking",
      "redacted_thinking",
      "tool_use",
    ]);
  });

  it("emits atomic SSE with zero-output start and final cumulative delta", () => {
    const t = target();
    const events = createAnthropicAtomicSseEvents(t);
    expect(events[0]?.type).toBe("message_start");
    if (events[0]?.type !== "message_start") throw new Error("bad start");
    expect(events[0].message.usage.output_tokens).toBe(0);
    expect(events[0].message.usage.output_tokens_details).toBeNull();
    expect(events[0].message.content).toEqual([]);
    expect(events[0].message.stop_reason).toBeNull();

    const delta = events.at(-2);
    expect(delta?.type).toBe("message_delta");
    if (delta?.type !== "message_delta") throw new Error("bad delta");
    expect(delta.delta.stop_reason).toBe("tool_use");
    expect(delta.usage).toEqual({
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
      input_tokens: 10,
      output_tokens: 20,
      server_tool_use: null,
    });
    expect(events.at(-1)).toEqual({ type: "message_stop" });
  });

  it("preserves block semantics across SSE and JSON", () => {
    const t = target();
    const rendered = renderAnthropicAtomicSse(t);
    expect(rendered.contentType).toBe("text/event-stream");
    const body = new TextDecoder().decode(rendered.body);
    expect(body).toContain('"type":"redacted_thinking"');
    expect(body).toContain('"type":"tool_use"');
    expect(body).not.toContain("[DONE]");
    expect(JSON.parse(new TextDecoder().decode(renderAnthropicJsonSuccess(t).body))).toEqual(t);
  });

  it("renders legal error envelopes with request_id and safe headers", () => {
    const rendered = renderAnthropicError(
      429,
      "rate_limit_error",
      "slow down secret-key-abcdefgh",
      "req_abc",
      { "retry-after": "5", "x-ratelimit-remaining": "10" },
    );
    const parsed = JSON.parse(new TextDecoder().decode(rendered.body)) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "slow down [REDACTED]" },
      request_id: "req_abc",
    });
    expect(rendered.headers).toEqual({
      "retry-after": "5",
      "x-ratelimit-remaining": "10",
    });
  });

  it("rejects unsafe error types and unbounded messages", () => {
    expect(() =>
      renderAnthropicError(500, "provider_internal_type", "boom"),
    ).toThrow(/Unsafe Anthropic error type/u);
    const long = "x".repeat(10_000);
    const rendered = renderAnthropicError(500, "api_error", long);
    const parsed = JSON.parse(new TextDecoder().decode(rendered.body)) as {
      error: { message: string };
    };
    expect(parsed.error.message.length).toBeLessThanOrEqual(4_096);
  });

  it("maps neutral failure facts to legal Anthropic errors", () => {
    const fact = createUpstreamFailureFact({
      kind: "http",
      status: 429,
      message: "rate limited",
      headers: { "retry-after": "3", "request-id": "req_provider", authorization: "Bearer x" },
    });
    const mapping = mapUpstreamFailureFact(fact);
    expect(mapping).toEqual({
      status: 429,
      type: "rate_limit_error",
      message: "rate limited",
      safeHeaders: { "retry-after": "3", "request-id": "req_provider" },
    });
    expect(requestIdFromFact(fact)).toBe("req_provider");
  });

  it("never forwards a provider type/code as an unchecked error type", () => {
    const fact = createUpstreamFailureFact({
      kind: "upstream_stream",
      status: 502,
      message: "stream failed",
      providerType: "weird_provider_code",
    });
    const mapping = mapUpstreamFailureFact(fact);
    expect(mapping.type).toBe("api_error");
    expect(mapping.type).not.toBe("weird_provider_code");
  });
});
