import { describe, expect, it } from "vitest";

import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";

describe("OpenAI Responses reasoning semantics", () => {
  it("preserves omitted, disabled, and enabled effort independently from summary", () => {
    const omitted = convertResponsesRequest(
      { model: "m", input: "x" },
      1,
    );
    const disabled = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        reasoning: { effort: "none", summary: "detailed" },
      },
      1,
    );
    const enabled = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        reasoning: { effort: "high", summary: "concise" },
      },
      1,
    );

    expect(omitted.invocation.reasoning.request).toEqual({
      effort: { kind: "provider-default" },
      summary: { kind: "provider-default" },
    });
    expect(disabled.invocation.reasoning.request).toEqual({
      effort: { kind: "disabled" },
      summary: { kind: "requested", value: "detailed" },
    });
    expect(enabled.invocation.reasoning.request).toEqual({
      effort: { kind: "enabled", level: "high" },
      summary: { kind: "requested", value: "concise" },
    });
  });

  it("attaches historical summary text to the final Pi block coordinates", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "reasoning",
            id: "rs_prior",
            summary: [{ type: "summary_text", text: "visible summary" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "visible answer" }],
          },
        ],
      },
      1,
    );

    expect(invocation.invocation.reasoning.history).toEqual([
      {
        attachment: {
          messageIndex: 0,
          contentIndex: 0,
          sourceItemId: "rs_prior",
        },
        summaryText: "visible summary",
      },
    ]);
  });

  it("keeps item-local continuity outside Pi IR until target resolution", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "reasoning",
            id: "rs_prior",
            summary: [{ type: "summary_text", text: "visible summary" }],
            luckytoken_continuity: {
              version: 1,
              source: {
                provider: "anthropic",
                api: "anthropic-messages",
                model: "claude-test",
              },
              attachments: [
                {
                  target: "thinking",
                  kind: "opaque-signature",
                  value: "opaque-thinking-signature",
                },
              ],
            },
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "visible answer" }],
          },
        ],
      },
      1,
    );

    expect(invocation.invocation.pi.context.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "visible summary",
    });
    expect(invocation.invocation.reasoning.continuity).toEqual([
      {
        attachment: {
          target: "thinking",
          messageIndex: 0,
          contentIndex: 0,
          sourceItemId: "rs_prior",
        },
        source: {
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-test",
        },
        kind: "opaque-signature",
        value: "opaque-thinking-signature",
      },
    ]);
    expect(invocation.invocation.reasoning.history[0]?.source).toEqual({
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
    });
  });

  it("reconstructs a complete Responses reasoning item from standard fields and source provenance", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "reasoning",
            id: "rs_prior",
            status: "completed",
            summary: [{ type: "summary_text", text: "visible summary" }],
            encrypted_content: "encrypted-reasoning",
            luckytoken_continuity: {
              version: 1,
              source: {
                provider: "openai",
                api: "openai-responses",
                model: "gpt-test",
              },
              attachments: [],
            },
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      1,
    );

    expect(invocation.invocation.reasoning.history[0]?.source).toEqual({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-test",
    });
    expect(invocation.invocation.reasoning.continuity).toContainEqual({
      attachment: {
        target: "thinking",
        messageIndex: 0,
        contentIndex: 0,
        sourceItemId: "rs_prior",
      },
      source: {
        provider: "openai",
        api: "openai-responses",
        model: "gpt-test",
      },
      kind: "responses-reasoning-item",
      value: JSON.stringify({
        type: "reasoning",
        id: "rs_prior",
        status: "completed",
        summary: [{ type: "summary_text", text: "visible summary" }],
        encrypted_content: "encrypted-reasoning",
      }),
    });
    expect(invocation.invocation.pi.context.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "visible summary",
    });
  });

  it("preserves a complete standard reasoning item without selecting a Provider replay policy", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "reasoning",
            id: "rs_future",
            status: "completed",
            summary: [{ type: "summary_text", text: "visible summary" }],
            encrypted_content: "encrypted-reasoning",
            luckytoken_continuity: {
              version: 1,
              source: {
                provider: "future-provider",
                api: "future-responses-api",
                model: "future-model",
              },
              attachments: [],
            },
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      1,
    );

    expect(invocation.invocation.reasoning.continuity).toContainEqual(
      expect.objectContaining({
        source: {
          provider: "future-provider",
          api: "future-responses-api",
          model: "future-model",
        },
        kind: "responses-reasoning-item",
      }),
    );
  });

  it("resolves tool-call continuity by call id without setting Pi thoughtSignature", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
            luckytoken_continuity: {
              version: 1,
              source: {
                provider: "google",
                api: "google-generative-ai",
                model: "gemini-test",
              },
              attachments: [
                {
                  target: "toolCall",
                  callId: "call_1",
                  kind: "opaque-signature",
                  value: "tool-thought-signature",
                },
              ],
            },
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "done",
          },
        ],
      },
      1,
    );

    expect(invocation.invocation.pi.context.messages[0]?.content[0]).toEqual({
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: {},
    });
    expect(invocation.invocation.reasoning.continuity).toEqual([
      {
        attachment: {
          target: "toolCall",
          messageIndex: 0,
          contentIndex: 0,
          callId: "call_1",
        },
        source: {
          provider: "google",
          api: "google-generative-ai",
          model: "gemini-test",
        },
        kind: "opaque-signature",
        value: "tool-thought-signature",
      },
    ]);
  });

  it("resolves text continuity from wire partIndex to final Pi contentIndex", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "message",
            id: "msg_prior",
            role: "assistant",
            content: [
              { type: "output_text", text: "first" },
              { type: "output_text", text: "second" },
            ],
            luckytoken_continuity: {
              version: 1,
              source: {
                provider: "google",
                api: "google-generative-ai",
                model: "gemini-test",
              },
              attachments: [
                {
                  target: "text",
                  partIndex: 1,
                  kind: "opaque-signature",
                  value: "text-thought-signature",
                },
              ],
            },
          },
        ],
      },
      1,
    );

    expect(invocation.invocation.pi.context.messages[0]?.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(invocation.invocation.reasoning.continuity).toEqual([
      {
        attachment: {
          target: "text",
          messageIndex: 0,
          contentIndex: 1,
          sourceItemId: "msg_prior",
        },
        source: {
          provider: "google",
          api: "google-generative-ai",
          model: "gemini-test",
        },
        kind: "opaque-signature",
        value: "text-thought-signature",
      },
    ]);
  });
});
