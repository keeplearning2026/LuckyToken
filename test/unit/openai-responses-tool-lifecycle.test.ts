import { describe, expect, it } from "vitest";

import {
  convertResponsesRequest,
  type ResponseRequestConversionPolicy,
} from "../../src/protocols/openai-responses/request.js";
import { convertAssistantMessageToResponses } from "../../src/protocols/openai-responses/response.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function policy(
  overrides: Partial<ResponseRequestConversionPolicy> = {},
): ResponseRequestConversionPolicy {
  return {
    privilegedMessages: "first",
    unknownInputItem: "error",
    orphanToolOutput: "error",
    unresolvedToolCall: "xrepair",
    futureReasoningEffort: "max",
    ...overrides,
  };
}

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

describe("15: Responses function/custom/namespace tool lifecycles", () => {
  describe("function definitions preserve name/description/parameters/strict", () => {
    it("maps a function tool definition exactly into a Pi Tool", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "function",
              name: "get_weather",
              description: "Get the weather for a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
              strict: true,
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools).toEqual([
        {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          constrainedSampling: { type: "json_schema", strict: "require" },
        },
      ]);
    });

    it("maps strict:false without constrainedSampling", () => {
      const loose = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "function",
              name: "f",
              parameters: { type: "object" },
              strict: false,
            },
          ],
        },
        1,
        policy(),
      );
      expect(loose.context.tools?.[0]?.constrainedSampling).toBeUndefined();
    });

    it("treats absent strict as the SDK default of strict:true", () => {
      // The installed SDK documents `strict` defaulting to true; an absent
      // strict maps to Pi constrainedSampling require rather than silently
      // degrading caller intent.
      const absent = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [{ type: "function", name: "g", parameters: { type: "object" } }],
        },
        1,
        policy(),
      );
      expect(absent.context.tools?.[0]?.constrainedSampling).toEqual({
        type: "json_schema",
        strict: "require",
      });
    });

    it("normalizes a non-object parameters into an object schema", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "function",
              name: "shell",
              description: "run",
              parameters: "not-an-object",
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.[0]?.parameters).toEqual({
        type: "object",
      });
    });
  });

  describe("custom definitions use the approved freeform object schema", () => {
    it("maps a custom tool to a Pi Tool with {input:string} and records freeform name", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [{ type: "custom", name: "apply_patch" }],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.[0]).toMatchObject({
        name: "apply_patch",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      });
      expect(invocation.renderState.freeformToolNames).toEqual(
        new Set(["apply_patch"]),
      );
    });

    it("maps a Lark grammar to Pi constrainedSampling openai_lark", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "custom",
              name: "grammar_tool",
              grammar: { type: "lark", grammar: "start: letter+" },
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.[0]?.constrainedSampling).toEqual({
        type: "grammar",
        variants: { openai_lark: "start: letter+" },
      });
    });

    it("maps a regex grammar to Pi constrainedSampling openai_regex", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "custom",
              name: "regex_tool",
              grammar: { type: "regex", regex: "^[a-z]+$" },
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.[0]?.constrainedSampling).toEqual({
        type: "grammar",
        variants: { openai_regex: "^[a-z]+$" },
      });
    });

    it("maps the SDK format-field Lark grammar to Pi constrainedSampling openai_lark", () => {
      // The installed SDK models custom-tool grammar under `format` as
      // {type:"grammar", definition, syntax:"lark"|"regex"}; it must map to
      // Pi constrainedSampling without being silently dropped.
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "custom",
              name: "grammar_tool",
              format: {
                type: "grammar",
                definition: "start: letter+",
                syntax: "lark",
              },
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.[0]?.constrainedSampling).toEqual({
        type: "grammar",
        variants: { openai_lark: "start: letter+" },
      });
    });

    it("maps the SDK format-field regex grammar to Pi constrainedSampling openai_regex", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "custom",
              name: "regex_tool",
              format: {
                type: "grammar",
                definition: "^[a-z]+$",
                syntax: "regex",
              },
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.[0]?.constrainedSampling).toEqual({
        type: "grammar",
        variants: { openai_regex: "^[a-z]+$" },
      });
    });

    it("rejects a custom grammar with an unknown variant type", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: "x",
            tools: [
              {
                type: "custom",
                name: "bad_grammar",
                grammar: { type: "bnf", grammar: "x" },
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/grammar/);
    });
  });

  describe("function arguments", () => {
    it("maps missing and blank arguments to {}", () => {
      for (const argumentsValue of [undefined, "", "   "]) {
        const invocation = convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "noop",
                ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
              },
            ],
          },
          1,
          policy(),
        );
        const assistant = invocation.context.messages.find(
          (m) => m.role === "assistant",
        );
        const call = (assistant?.content as Array<{ arguments: unknown }>)[0];
        expect(call?.arguments).toEqual({});
      }
    });

    it("maps a valid JSON object argument losslessly", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "lookup",
              arguments: '{"key":"value","nested":{"a":[1,2,3]},"flag":true}',
            },
          ],
        },
        1,
        policy(),
      );
      const assistant = invocation.context.messages.find(
        (m) => m.role === "assistant",
      );
      const call = (assistant?.content as Array<{ arguments: unknown }>)[0];
      expect(call?.arguments).toEqual({
        key: "value",
        nested: { a: [1, 2, 3] },
        flag: true,
      });
    });

    it("errors on invalid JSON arguments", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "lookup",
                arguments: "{not valid json",
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/valid JSON/);
    });

    it("errors on valid non-object JSON arguments", () => {
      for (const argumentsValue of ['"a string"', "[1,2,3]", "42", "null"]) {
        expect(() =>
          convertResponsesRequest(
            {
              model: "m",
              input: [
                {
                  type: "function_call",
                  call_id: "call_1",
                  name: "lookup",
                  arguments: argumentsValue,
                },
              ],
            },
            1,
            policy(),
          ),
        ).toThrow(/JSON object/);
      }
    });
  });

  describe("custom call freeform input", () => {
    it("maps a custom_tool_call input to {input:string} and reverses to custom family", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "custom_tool_call",
              call_id: "call_patch",
              name: "apply_patch",
              input: "*** Begin Patch\n*** End Patch",
            },
            {
              type: "custom_tool_call_output",
              call_id: "call_patch",
              output: "applied",
            },
          ],
        },
        1,
        policy(),
      );
      const assistant = invocation.context.messages.find(
        (m) => m.role === "assistant",
      );
      expect(assistant?.content).toEqual([
        {
          type: "toolCall",
          id: "call_patch",
          name: "apply_patch",
          arguments: { input: "*** Begin Patch\n*** End Patch" },
        },
      ]);
      const result = invocation.context.messages.find(
        (m) => m.role === "toolResult",
      );
      expect(result).toMatchObject({
        toolCallId: "call_patch",
        toolName: "apply_patch",
        content: [{ type: "text", text: "applied" }],
      });
    });

    it("emits a Responses-local notice for the {input:string} compatibility representation", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "custom_tool_call",
              call_id: "call_patch",
              name: "apply_patch",
              input: "patch body",
            },
          ],
        },
        1,
        policy(),
      );
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_custom_input_compat",
        ),
      ).toBe(true);
    });

    it("round-trips a custom tool call into a custom_tool_call output item", () => {
      const response = convertAssistantMessageToResponses(
        assistantMessage({
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "apply_patch",
              arguments: { input: "raw patch" },
            },
          ],
        }),
        "m",
        "resp_1",
        1,
        undefined,
        new Set(["apply_patch"]),
      );
      expect(response.output).toEqual([
        {
          type: "custom_tool_call",
          id: "ctc_resp_1_0",
          call_id: "call_1",
          name: "apply_patch",
          input: "raw patch",
          status: "completed",
        },
      ]);
    });

    it("treats a custom call without a registered freeform name as a function_call", () => {
      const response = convertAssistantMessageToResponses(
        assistantMessage({
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "regular_fn",
              arguments: { input: "x" },
            },
          ],
        }),
        "m",
        "resp_1",
        1,
        undefined,
        new Set(),
      );
      expect(response.output[0]?.type).toBe("function_call");
    });
  });

  describe("namespace tools use a reversible Responses-owned naming scheme", () => {
    it("flattens namespace function children into Pi tools with reversible names", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "namespace",
              name: "mcp",
              description: "MCP server",
              tools: [
                {
                  type: "function",
                  name: "read",
                  description: "read a resource",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.map((t) => t.name)).toEqual(["mcp.read"]);
      const tool = invocation.context.tools?.[0];
      expect(tool?.description).toBe("read a resource");
      expect(tool?.parameters).toEqual({ type: "object", properties: {} });
    });

    it("supports custom children inside a namespace", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "namespace",
              name: "mcp",
              tools: [
                { type: "custom", name: "freeform_child" },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.map((t) => t.name)).toEqual([
        "mcp.freeform_child",
      ]);
      expect(invocation.context.tools?.[0]?.parameters).toMatchObject({
        type: "object",
        properties: { input: { type: "string" } },
      });
      expect(invocation.renderState.freeformToolNames).toEqual(
        new Set(["mcp.freeform_child"]),
      );
    });

    it("detects namespace flattening collisions and errors", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: "x",
            tools: [
              {
                type: "namespace",
                name: "a",
                tools: [
                  {
                    type: "function",
                    name: "b",
                    parameters: { type: "object" },
                  },
                ],
              },
              {
                type: "function",
                name: "a.b",
                parameters: { type: "object" },
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/collision|duplicate/i);
    });

    it("retains reverse namespace metadata only in render state", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "namespace",
              name: "mcp",
              tools: [
                {
                  type: "function",
                  name: "read",
                  parameters: { type: "object" },
                },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.renderState.namespaceReverse).toBeDefined();
      expect(invocation.renderState.namespaceReverse).toEqual({
        "mcp.read": { namespace: "mcp", child: "read" },
      });
      // The reverse metadata must never enter model context or options.
      expect(invocation.context).not.toHaveProperty("namespaceReverse");
      expect(invocation.options).not.toHaveProperty("namespaceReverse");
    });
  });

  describe("status lifecycle for structured tool items", () => {
    it("accepts status absent/completed for calls and outputs", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "f",
              arguments: "{}",
              status: "completed",
            },
            {
              type: "function_call_output",
              call_id: "call_1",
              output: "ok",
              status: "completed",
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.messages.map((m) => m.role)).toEqual([
        "assistant",
        "toolResult",
      ]);
    });

    it("errors on in_progress/incomplete/unknown structured status", () => {
      const badStatuses = ["in_progress", "incomplete", "queued"];
      for (const status of badStatuses) {
        expect(() =>
          convertResponsesRequest(
            {
              model: "m",
              input: [
                {
                  type: "function_call",
                  call_id: "call_1",
                  name: "f",
                  arguments: "{}",
                  status,
                },
              ],
            },
            1,
            policy(),
          ),
        ).toThrow(/status/);
      }
    });
  });

  describe("duplicate, orphan, and unresolved lifecycle", () => {
    it("errors on a duplicate function_call_output for the same call_id", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "f",
                arguments: "{}",
              },
              {
                type: "function_call_output",
                call_id: "call_1",
                output: "first",
              },
              {
                type: "function_call_output",
                call_id: "call_1",
                output: "second",
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/duplicate|already has a result/i);
    });

    it("errors on an orphan output by default and ignores with a notice", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              { type: "function_call_output", call_id: "no_call", output: "x" },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/unknown call_id/);
      const ignored = convertResponsesRequest(
        {
          model: "m",
          input: [
            { type: "function_call_output", call_id: "no_call", output: "x" },
            { type: "message", role: "user", content: "keep" },
          ],
        },
        1,
        policy({ orphanToolOutput: "ignore" }),
      );
      expect(ignored.context.messages).toHaveLength(1);
      expect(
        ignored.notices.some(
          (n) => n.code === "openai-responses_orphan_tool_output_ignored",
        ),
      ).toBe(true);
    });

    it("repairs an unresolved call by default with the Responses frozen literal", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "lookup",
              arguments: '{"k":"v"}',
            },
            { type: "message", role: "user", content: "continue" },
          ],
        },
        1,
        policy(),
      );
      const messages = invocation.context.messages;
      expect(messages.map((m) => m.role)).toEqual([
        "assistant",
        "toolResult",
        "user",
      ]);
      const result = messages.find((m) => m.role === "toolResult");
      expect(result).toMatchObject({
        toolCallId: "call_1",
        toolName: "lookup",
        isError: true,
        content: [
          {
            type: "text",
            text: "No result — the tool call did not complete (interrupted or lost).",
          },
        ],
      });
      expect(
        invocation.notices.some((n) => n.code === "openai-responses_unresolved_call_repaired"),
      ).toBe(true);
    });

    it("errors on an unresolved call under unresolvedToolCall=error", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "lookup",
                arguments: "{}",
              },
              { type: "message", role: "user", content: "continue" },
            ],
          },
          1,
          policy({ unresolvedToolCall: "error" }),
        ),
      ).toThrow(/unresolved/i);
    });

    it("never alters a real result identity/content/error semantics during repair", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "f",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_1",
              output: "real result",
            },
            { type: "message", role: "user", content: "continue" },
          ],
        },
        1,
        policy(),
      );
      const results = invocation.context.messages.filter(
        (m) => m.role === "toolResult",
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        toolCallId: "call_1",
        toolName: "f",
        isError: false,
        content: [{ type: "text", text: "real result" }],
      });
    });

    it("repairs only the missing call among multiple calls", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "a",
              arguments: "{}",
            },
            {
              type: "function_call",
              call_id: "call_2",
              name: "b",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_2",
              output: "real b",
            },
            { type: "message", role: "user", content: "continue" },
          ],
        },
        1,
        policy(),
      );
      const results = invocation.context.messages.filter(
        (m) => m.role === "toolResult",
      );
      expect(results).toHaveLength(2);
      const call1Result = results.find((r) => r.toolCallId === "call_1");
      expect(call1Result).toMatchObject({ isError: true });
      const call2Result = results.find((r) => r.toolCallId === "call_2");
      expect(call2Result).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "real b" }],
      });
    });
  });

  describe("multiple calls, ordering, and concurrency", () => {
    it("preserves source order across calls and results", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "u" },
            {
              type: "function_call",
              call_id: "c1",
              name: "f1",
              arguments: "{}",
            },
            {
              type: "function_call",
              call_id: "c2",
              name: "f2",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "c2",
              output: "r2",
            },
            {
              type: "function_call_output",
              call_id: "c1",
              output: "r1",
            },
          ],
        },
        1,
        policy(),
      );
      const roles = invocation.context.messages.map((m) => m.role);
      expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult"]);
      const results = invocation.context.messages.filter(
        (m) => m.role === "toolResult",
      );
      expect(results.map((r) => r.toolCallId)).toEqual(["c2", "c1"]);
      expect(
        results.map(
          (r) => (r.content as Array<{ text: string }>)[0]?.text,
        ),
      ).toEqual(["r2", "r1"]);
    });

    it("correlates outputs when results arrive in reverse order of calls", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call",
              call_id: "c1",
              name: "first_tool",
              arguments: "{}",
            },
            {
              type: "function_call",
              call_id: "c2",
              name: "second_tool",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "c2",
              output: "second result",
            },
            {
              type: "function_call_output",
              call_id: "c1",
              output: "first result",
            },
          ],
        },
        1,
        policy(),
      );
      const results = invocation.context.messages.filter(
        (m) => m.role === "toolResult",
      );
      expect(results.map((r) => r.toolName)).toEqual([
        "second_tool",
        "first_tool",
      ]);
    });

    it("handles concurrent independent conversions without cross-request state", () => {
      const conversions = Array.from({ length: 20 }, (_, i) =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "function_call",
                call_id: `call_${i}`,
                name: `tool_${i}`,
                arguments: `{"i":${i}}`,
              },
              {
                type: "function_call_output",
                call_id: `call_${i}`,
                output: `result_${i}`,
              },
            ],
          },
          i,
          policy(),
        ),
      );
      for (const [i, invocation] of conversions.entries()) {
        const result = invocation.context.messages.find(
          (m) => m.role === "toolResult",
        );
        expect(result).toMatchObject({
          toolCallId: `call_${i}`,
          toolName: `tool_${i}`,
          content: [{ type: "text", text: `result_${i}` }],
        });
        const call = invocation.context.messages.find(
          (m) => m.role === "assistant",
        );
        expect(
          (call?.content as Array<{ arguments: unknown }>)[0]?.arguments,
        ).toEqual({ i });
      }
    });
  });

  describe("output images stay Pi ToolResult images on the Client side", () => {
    it("converts tool output image parts into Pi ToolResult images", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call",
              call_id: "call_img",
              name: "render",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_img",
              output: [
                { type: "input_text", text: "here is the image" },
                {
                  type: "output_image",
                  image_url:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      const result = invocation.context.messages.find(
        (m) => m.role === "toolResult",
      );
      expect(result).toMatchObject({
        toolCallId: "call_img",
        toolName: "render",
        content: [
          { type: "text", text: "here is the image" },
          { type: "image", mimeType: "image/png" },
        ],
      });
    });

    it("drops a non-data remote output image and keeps the text", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "function_call",
              call_id: "call_img",
              name: "render",
              arguments: "{}",
            },
            {
              type: "function_call_output",
              call_id: "call_img",
              output: [
                { type: "input_text", text: "result text" },
                { type: "output_image", image_url: "https://cdn.test/img.png" },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      const result = invocation.context.messages.find(
        (m) => m.role === "toolResult",
      );
      expect(result).toMatchObject({
        toolCallId: "call_img",
        content: [{ type: "text", text: "result text" }],
      });
    });
  });

  describe("namespace reverse render state round-trips to output", () => {
    it("keeps the reverse metadata request-local and echoes no namespace into Pi", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "namespace",
              name: "server",
              tools: [
                {
                  type: "function",
                  name: "list",
                  parameters: { type: "object" },
                },
                { type: "custom", name: "freeform" },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.tools?.map((t) => t.name)).toEqual([
        "server.list",
        "server.freeform",
      ]);
      expect(invocation.renderState.namespaceReverse).toEqual({
        "server.list": { namespace: "server", child: "list" },
        "server.freeform": { namespace: "server", child: "freeform" },
      });
      expect(invocation.renderState.freeformToolNames).toEqual(
        new Set(["server.freeform"]),
      );
    });
  });
});
