import type { AssistantMessage } from "@earendil-works/pi-ai";

import { describe, expect, it } from "vitest";

import {
  convertAssistantMessageToResponses,
  renderResponsesError,
} from "../../src/protocols/openai-responses/response.js";

function assistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    api: "commandcode-private",
    provider: "commandcode-private",
    model: "deepseek/deepseek-v4-flash",
    content: [{ type: "text", text: "hello" }],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_786_400_000_000,
    ...overrides,
  };
}

describe("OpenAI Responses Pi → wire response conversion", () => {
  it("converts a committed assistant message into a Responses response object", () => {
    const response = convertAssistantMessageToResponses(
      assistantMessage(),
      "commandcode-private/deepseek/deepseek-v4-flash",
      "resp_1",
      1_786_400_000,
      "resp_prev",
    );

    expect(response).toMatchObject({
      id: "resp_1",
      object: "response",
      created_at: 1_786_400_000,
      status: "completed",
      model: "commandcode-private/deepseek/deepseek-v4-flash",
      previous_response_id: "resp_prev",
    });
    expect(response.output).toEqual([
      {
        type: "message",
        id: "msg_resp_1_0",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ]);
    expect(response.usage).toEqual({
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      input_tokens_details: { cached_tokens: 2 },
    });
  });

  it("maps length stop reason to incomplete max_output_tokens", () => {
    const response = convertAssistantMessageToResponses(
      assistantMessage({ stopReason: "length" }),
      "m",
      "resp_2",
      1,
      undefined,
    );
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("maps tool calls to function_call output items", () => {
    const response = convertAssistantMessageToResponses(
      assistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "lookup",
            arguments: { key: "value" },
          },
        ],
      }),
      "m",
      "resp_3",
      1,
      undefined,
    );
    expect(response.output).toEqual([
      {
        type: "function_call",
        id: "fc_resp_3_0",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"key":"value"}',
        status: "completed",
      },
    ]);
  });

  it("emits reasoning token details only when reasoning is reported", () => {
    const response = convertAssistantMessageToResponses(
      assistantMessage({
        usage: {
          input: 10,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 3,
          totalTokens: 18,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
      "m",
      "resp_4",
      1,
      undefined,
    );
    expect(response.usage.output_tokens_details).toEqual({
      reasoning_tokens: 3,
    });
  });

  it("maps freeform (custom) tool calls to custom_tool_call output items", () => {
    const response = convertAssistantMessageToResponses(
      assistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_patch",
            name: "apply_patch",
            arguments: { input: "*** Begin Patch\n..." },
          },
        ],
      }),
      "m",
      "resp_freeform",
      1,
      undefined,
      new Set(["apply_patch"]),
    );
    expect(response.output).toEqual([
      {
        type: "custom_tool_call",
        id: "ctc_resp_freeform_0",
        call_id: "call_patch",
        name: "apply_patch",
        input: "*** Begin Patch\n...",
        status: "completed",
      },
    ]);
  });

  it("renders error responses in the Responses error shape", () => {
    const prepared = renderResponsesError(400, "invalid_request_error", "bad input");
    expect(prepared.status).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(prepared.body))).toEqual({
      error: { type: "invalid_request_error", message: "bad input" },
    });
  });

  it("restores the namespace on a flattened namespace tool call output", () => {
    // A namespace-flattened function call (ns.child) reverses to the SDK
    // shape: name "child" plus a namespace field, so the client can map it
    // back to the original namespace tool.
    const response = convertAssistantMessageToResponses(
      assistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_ns",
            name: "crm.read",
            arguments: { id: "1" },
          },
        ],
      }),
      "m",
      "resp_ns",
      1,
      undefined,
      new Set(),
      { "crm.read": { namespace: "crm", child: "read" } },
    );
    expect(response.output).toEqual([
      {
        type: "function_call",
        id: "fc_resp_ns_0",
        call_id: "call_ns",
        name: "read",
        namespace: "crm",
        arguments: '{"id":"1"}',
        status: "completed",
      },
    ]);
  });

  it("restores the namespace on a flattened namespace custom tool call output", () => {
    // A namespace custom child (ns.freeform) reverses to a custom_tool_call
    // with the child name and namespace field.
    const response = convertAssistantMessageToResponses(
      assistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_nsc",
            name: "crm.freeform",
            arguments: { input: "raw input" },
          },
        ],
      }),
      "m",
      "resp_nsc",
      1,
      undefined,
      new Set(["crm.freeform"]),
      { "crm.freeform": { namespace: "crm", child: "freeform" } },
    );
    expect(response.output).toEqual([
      {
        type: "custom_tool_call",
        id: "ctc_resp_nsc_0",
        call_id: "call_nsc",
        name: "freeform",
        namespace: "crm",
        input: "raw input",
        status: "completed",
      },
    ]);
  });

  it("keeps non-namespace tool names unchanged when no reverse metadata exists", () => {
    const response = convertAssistantMessageToResponses(
      assistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "plain_fn",
            arguments: {},
          },
        ],
      }),
      "m",
      "resp_plain",
      1,
      undefined,
      new Set(),
      {},
    );
    expect(response.output[0]).toMatchObject({
      type: "function_call",
      name: "plain_fn",
    });
    expect(response.output[0]).not.toHaveProperty("namespace");
  });
});
