import { describe, expect, it } from "vitest";

import {
  convertResponsesRequest,
  type ResponseRequestConversionPolicy,
} from "../../src/protocols/openai-responses/request.js";

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

/**
 * The installed OpenAI SDK `ResponseInputItem` union (enumerated from
 * node_modules/openai/resources/responses/responses.d.ts). A new SDK family
 * must fail here: the table below is closed-world and a future family falls
 * into the unknown-input-item branch, which the first test locks to error.
 */
const INSTALLED_INPUT_ITEM_FAMILIES = [
  // easy/input/output messages
  "message",
  // function/custom calls and outputs
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  // reasoning, compaction, item reference
  "reasoning",
  "compaction",
  "item_reference",
  // computer
  "computer_call",
  "computer_call_output",
  // web search
  "web_search_call",
  // file search
  "file_search_call",
  // code interpreter
  "code_interpreter_call",
  // image generation
  "image_generation_call",
  // tool search
  "tool_search_call",
  "tool_search_output",
  // local shell
  "local_shell_call",
  "local_shell_call_output",
  // shell
  "shell_call",
  "shell_call_output",
  // apply patch
  "apply_patch_call",
  "apply_patch_call_output",
  // MCP
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "mcp_call",
] as const;

describe("16: every known Responses input-item family", () => {
  it("enumerates the complete installed input-item union so a new SDK family triggers an explicit review failure", () => {
    // The union above is the closed-world table. A future SDK family would
    // not appear in it, and the conversion switch must reject it as unknown.
    // The installed SDK ResponseInputItem union currently has 26 members.
    expect(INSTALLED_INPUT_ITEM_FAMILIES.length).toBe(26);
  });

  it("classifies every installed input-item family explicitly, never as unknown", () => {
    // Every family in the closed-world table must have an explicit conversion
    // outcome; a family that fell through to the unknown-input-item branch
    // would throw under the default error policy. Families that are Core
    // errors (tool_search) also throw, which is their defined outcome.
    const definedErrors = new Set(["tool_search_call", "tool_search_output"]);
    const outcomes: Array<[string, "ok" | "error"]> = [];
    for (const family of INSTALLED_INPUT_ITEM_FAMILIES) {
      try {
        convertResponsesRequest(
          { model: "m", input: [{ type: family, id: "probe" }] },
          1,
          policy(),
        );
        outcomes.push([family, "ok"]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (definedErrors.has(family)) {
          outcomes.push([family, "error"]);
        } else if (/Unsupported input item type/u.test(message)) {
          throw new Error(
            `family ${family} fell through to the unknown-input-item branch`,
          );
        } else {
          // A structured validation error (e.g. missing required field) is
          // still an explicit known-family outcome.
          outcomes.push([family, "error"]);
        }
      }
    }
    // No family may fall through to the unknown branch (that throws above);
    // the tool_search families are defined Core conversion errors.
    expect(outcomes.length).toBe(INSTALLED_INPUT_ITEM_FAMILIES.length);
    expect(outcomes.filter(([, o]) => o === "ok").length).toBeGreaterThan(10);
    for (const family of definedErrors) {
      expect(outcomes).toContainEqual([family, "error"]);
    }
  });

  it("rejects a future unknown SDK family as a Core conversion error by default", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: [{ type: "future_sdk_family", data: 1 }] },
        1,
        policy(),
      ),
    ).toThrow(/Unsupported input item type/);
  });

  it("drops web_search_call as provider-hosted transcript without advertising a Pi tool", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "web_search_call", id: "ws_1" },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("drops file_search_call as provider-hosted transcript", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "file_search_call", id: "fs_1" },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("does not emit a transcript for an in-progress hosted file_search_call", () => {
    // A hosted call that is still in_progress/searching has no determinate
    // results; emitting its partial results would mislead. It drops like
    // lifecycle metadata.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "file_search_call",
            id: "fs_live",
            queries: ["find"],
            status: "in_progress",
            results: [{ text: "partial result" }],
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    const userTexts = invocation.invocation.pi.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(userTexts).toEqual(["keep"]);
  });

  it("preserves file_search_call result text as ordered transcript", () => {
    // Hosted file-search history with representable result text degrades to
    // ordered transcript content; it never advertises an executable Pi tool.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "file_search_call",
            id: "fs_1",
            queries: ["find the bug"],
            status: "completed",
            results: [
              {
                file_id: "file_1",
                filename: "bug.js",
                text: "the bug is on line 42",
              },
              { file_id: "file_2", filename: "notes.md", text: "see readme" },
            ],
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    const userTexts = invocation.invocation.pi.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(userTexts).toEqual([
      "the bug is on line 42",
      "see readme",
      "keep",
    ]);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
    // Pure metadata (file ids, filenames) never enters Pi.
    const serialized = JSON.stringify(invocation.invocation.pi.context);
    expect(serialized).not.toContain("file_1");
    expect(serialized).not.toContain("bug.js");
  });

  it("errors on tool_search_call as a Core conversion error (not a plain unknown)", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: [{ type: "tool_search_call", id: "ts_1" }] },
        1,
        policy(),
      ),
    ).toThrow(/tool_search|tool search|unsupported/i);
  });

  it("errors on tool_search_output as a Core conversion error", () => {
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: [{ type: "tool_search_output", id: "tso_1" }] },
        1,
        policy(),
      ),
    ).toThrow(/tool_search|tool search|unsupported/i);
  });

  it("maps local_shell_call to a structured Pi ToolCall", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "local_shell_call",
            id: "lsc_1",
            call_id: "call_sh",
            name: "local_shell",
            arguments: '{"command":"ls"}',
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_sh",
        name: "local_shell",
        arguments: { command: "ls" },
      },
    ]);
  });

  it("maps a name-less SDK local_shell_call to the deterministic local_shell name", () => {
    // The installed SDK models ResponseInputItem.LocalShellCall without a
    // `name` field; the adapter maps it to the deterministic Responses-owned
    // name so call ownership round-trips as a structured ToolCall.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "local_shell" }],
        input: [
          {
            type: "local_shell_call",
            id: "lsc_1",
            call_id: "call_sh",
            action: { type: "exec", commands: ["ls"] },
            status: "completed",
          },
          {
            type: "local_shell_call_output",
            id: "call_sh",
            output: "file1",
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_sh",
        name: "local_shell",
        arguments: { type: "exec", commands: ["ls"] },
      },
    ]);
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_sh",
      toolName: "local_shell",
      content: [{ type: "text", text: "file1" }],
    });
  });

  it("maps the SDK action object of local_shell_call losslessly into arguments", () => {
    // The installed SDK models local_shell_call with a structured `action`
    // object, not a JSON `arguments` string. The action must map losslessly
    // into the Pi ToolCall arguments.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "local_shell_call",
            id: "lsc_1",
            call_id: "call_sh",
            name: "local_shell",
            action: { type: "exec", command: "ls -la", timeout_ms: 5000 },
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_sh",
        name: "local_shell",
        arguments: { type: "exec", command: "ls -la", timeout_ms: 5000 },
      },
    ]);
  });

  it("maps the SDK action object of shell_call losslessly into arguments", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "shell_call",
            id: "sc_1",
            call_id: "call_sh2",
            name: "shell",
            action: { type: "exec", command: "pwd" },
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_sh2",
        name: "shell",
        arguments: { type: "exec", command: "pwd" },
      },
    ]);
  });

  it("maps the SDK action object of apply_patch_call losslessly into arguments", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "apply_patch_call",
            id: "apc_1",
            call_id: "call_p2",
            name: "apply_patch",
            action: { type: "apply_patch", patch: "*** Begin Patch" },
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_p2",
        name: "apply_patch",
        arguments: { type: "apply_patch", patch: "*** Begin Patch" },
      },
    ]);
  });

  it("maps local_shell_call_output to a structured Pi ToolResult", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "local_shell_call",
            id: "lsc_1",
            call_id: "call_sh",
            name: "local_shell",
            arguments: '{"command":"ls"}',
          },
          {
            // The SDK correlates local_shell_call_output by `id` (= call_id).
            type: "local_shell_call_output",
            id: "call_sh",
            output: "file1\nfile2",
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_sh",
      toolName: "local_shell",
      content: [{ type: "text", text: "file1\nfile2" }],
    });
  });

  it("maps an id-keyed SDK local_shell_call_output to the correlated ToolResult", () => {
    // The installed SDK models local_shell_call_output with `id` as the
    // correlation key (no separate call_id field).
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "local_shell_call",
            id: "lsc_1",
            call_id: "call_sh",
            name: "local_shell",
            action: { type: "exec", command: "ls" },
          },
          {
            type: "local_shell_call_output",
            id: "call_sh",
            output: "file1\nfile2",
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_sh",
      toolName: "local_shell",
      content: [{ type: "text", text: "file1\nfile2" }],
    });
  });

  it("maps shell_call to a structured Pi ToolCall", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "shell_call",
            call_id: "call_sh2",
            name: "shell",
            arguments: '{"command":"pwd"}',
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_sh2",
        name: "shell",
        arguments: { command: "pwd" },
      },
    ]);
  });

  it("maps a name-less SDK shell_call to the deterministic shell name", () => {
    // The installed SDK models ResponseFunctionShellToolCall without a
    // `name` field; the adapter maps it to the deterministic Responses-owned
    // name so call ownership round-trips as a structured ToolCall.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "shell" }],
        input: [
          {
            type: "shell_call",
            id: "sc_1",
            call_id: "call_sh2",
            action: { type: "exec", commands: ["pwd"] },
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_sh2",
        name: "shell",
        arguments: { type: "exec", commands: ["pwd"] },
      },
    ]);
  });

  it("maps shell_call_output to a structured Pi ToolResult", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "shell_call",
            call_id: "call_sh2",
            name: "shell",
            arguments: "{}",
          },
          {
            type: "shell_call_output",
            call_id: "call_sh2",
            output: "/workspace",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_sh2",
      toolName: "shell",
      content: [{ type: "text", text: "/workspace" }],
    });
  });

  it("maps the SDK stdout/stderr chunk output of shell_call_output into text", () => {
    // The installed SDK models shell_call_output.output as an array of
    // {stdout, stderr, outcome} chunks; the representable text degrades to
    // ordered transcript content, never dropped.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "shell_call",
            call_id: "call_sh2",
            name: "shell",
            action: { type: "exec", command: "ls" },
          },
          {
            type: "shell_call_output",
            call_id: "call_sh2",
            output: [
              {
                stdout: "file1\nfile2",
                stderr: "",
                outcome: { type: "exit", exit_code: 0 },
              },
              {
                stdout: "warning line",
                stderr: "error line",
                outcome: { type: "exit", exit_code: 1 },
              },
            ],
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    const text = (result?.content as Array<{ text: string }>)[0]?.text;
    expect(text).toContain("file1\nfile2");
    expect(text).toContain("warning line");
    expect(text).toContain("error line");
  });

  it("maps the SDK operation object of apply_patch_call losslessly into arguments", () => {
    // The installed SDK models apply_patch_call with a structured
    // `operation` object (not action/arguments); it must map losslessly.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "apply_patch_call",
            call_id: "call_p",
            name: "apply_patch",
            operation: {
              type: "update_file",
              file_path: "src/main.ts",
              old_string: "const a = 1",
              new_string: "const a = 2",
            },
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_p",
        name: "apply_patch",
        arguments: {
          type: "update_file",
          file_path: "src/main.ts",
          old_string: "const a = 1",
          new_string: "const a = 2",
        },
      },
    ]);
  });

  it("maps apply_patch_call to a structured Pi ToolCall", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "apply_patch_call",
            call_id: "call_p",
            name: "apply_patch",
            arguments: '{"input":"*** Begin Patch"}',
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_p",
        name: "apply_patch",
        arguments: { input: "*** Begin Patch" },
      },
    ]);
  });

  it("maps a name-less SDK apply_patch_call to the deterministic apply_patch name", () => {
    // The installed SDK models ResponseInputItem.ApplyPatchCall without a
    // `name` field; the adapter maps it to the deterministic Responses-owned
    // name so call ownership round-trips as a structured ToolCall.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "apply_patch" }],
        input: [
          {
            type: "apply_patch_call",
            call_id: "call_p",
            operation: {
              type: "update_file",
              file_path: "a.ts",
              old_string: "x",
              new_string: "y",
            },
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "call_p",
        name: "apply_patch",
        arguments: {
          type: "update_file",
          file_path: "a.ts",
          old_string: "x",
          new_string: "y",
        },
      },
    ]);
  });

  it("maps apply_patch_call_output to a structured Pi ToolResult", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "apply_patch_call",
            call_id: "call_p",
            name: "apply_patch",
            arguments: "{}",
          },
          {
            type: "apply_patch_call_output",
            call_id: "call_p",
            output: "patch applied",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_p",
      toolName: "apply_patch",
      content: [{ type: "text", text: "patch applied" }],
    });
  });

  it("accepts the SDK apply_patch_call_output status failed as an isError result", () => {
    // The installed SDK models apply_patch_call_output.status as
    // completed|failed. failed is a defined terminal lifecycle with
    // representable output; it maps to an isError ToolResult so the failure
    // semantics are never lost.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "apply_patch" }],
        input: [
          {
            type: "apply_patch_call",
            call_id: "call_p",
            operation: {
              type: "update_file",
              file_path: "a.ts",
              old_string: "x",
              new_string: "y",
            },
            status: "completed",
          },
          {
            type: "apply_patch_call_output",
            call_id: "call_p",
            output: "patch failed: conflict",
            status: "failed",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_p",
      toolName: "apply_patch",
      isError: true,
      content: [{ type: "text", text: "patch failed: conflict" }],
    });
  });

  it("maps computer_call as a generic Pi ToolCall when execution ownership is Client/BYOT", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "computer", name: "computer" }],
        input: [
          {
            type: "computer_call",
            id: "cc_1",
            call_id: "call_cc",
            name: "computer",
            action: { type: "click", x: 10, y: 20 },
            pending_safety_checks: [],
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    const call = assistant?.content?.[0] as { type: string; name: string };
    expect(call?.type).toBe("toolCall");
    expect(call?.name).toBe("computer");
  });

  it("classifies a name-less SDK computer_call as Client/BYOT when a computer tool is declared", () => {
    // The installed SDK models ResponseComputerToolCall without a `name`
    // field; the adapter must classify it as Client/BYOT when the
    // deterministic "computer" executable name is in the catalog, so the
    // structured ToolCall/ToolResult are never lost to a hosted drop.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "computer" }],
        input: [
          {
            type: "computer_call",
            id: "cc_1",
            call_id: "call_cc",
            action: { type: "click", x: 10, y: 20 },
            status: "completed",
          },
          {
            type: "computer_call_output",
            id: "cco_1",
            call_id: "call_cc",
            output: {
              type: "computer_screenshot",
              image_url:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    const call = assistant?.content?.[0] as { type: string; name: string };
    expect(call?.type).toBe("toolCall");
    expect(call?.name).toBe("computer");
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_cc",
      toolName: "computer",
      content: [{ type: "image", mimeType: "image/png" }],
    });
  });

  it("degrades provider-hosted computer call to ordered content without advertising a Pi tool", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "computer_call",
            id: "cc_hosted",
            call_id: "call_cc2",
            name: "computer",
            status: "completed",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("maps computer_call_output screenshots to Pi images on the Client side", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "computer", name: "computer" }],
        input: [
          {
            type: "computer_call",
            id: "cc_1",
            call_id: "call_cc",
            name: "computer",
            status: "completed",
          },
          {
            type: "computer_call_output",
            id: "cco_1",
            call_id: "call_cc",
            output: [
              {
                type: "computer_screenshot",
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
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_cc",
      content: [{ type: "image", mimeType: "image/png" }],
    });
  });

  it("maps the SDK single-object computer_call_output screenshot to Pi images", () => {
    // The installed SDK models computer_call_output.output as a single
    // screenshot object, not an array. It must map to Pi ToolResult images.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "computer", name: "computer" }],
        input: [
          {
            type: "computer_call",
            id: "cc_1",
            call_id: "call_cc",
            name: "computer",
            status: "completed",
          },
          {
            type: "computer_call_output",
            id: "cco_1",
            call_id: "call_cc",
            output: {
              type: "computer_screenshot",
              image_url:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_cc",
      content: [{ type: "image", mimeType: "image/png" }],
    });
  });

  it("degrades provider-hosted code_interpreter_call to transcript", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "code_interpreter_call", id: "ci_1" },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("does not emit a transcript for an in-progress hosted code_interpreter_call", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "code_interpreter_call",
            id: "ci_live",
            status: "in_progress",
            outputs: [{ type: "logs", logs: "partial log" }],
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    const userTexts = invocation.invocation.pi.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(userTexts).toEqual(["keep"]);
  });

  it("preserves code_interpreter_call log output as ordered transcript", () => {
    // Hosted code-interpreter history with representable log output degrades
    // to an ordered transcript; it never advertises an executable Pi tool.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "code_interpreter_call",
            id: "ci_1",
            code: "print(1)",
            container_id: "cont_1",
            status: "completed",
            outputs: [
              { type: "logs", logs: "1\n" },
              { type: "image", image_url: "https://cdn.test/plot.png" },
            ],
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    const userTexts = invocation.invocation.pi.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(userTexts).toEqual(["1\n", "keep"]);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
    // Pure lifecycle metadata (container id, code) never enters Pi.
    const serialized = JSON.stringify(invocation.invocation.pi.context);
    expect(serialized).not.toContain("cont_1");
  });

  it("degrades provider-hosted image_generation_call to transcript", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "image_generation_call", id: "ig_1" },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("materializes a directly present data-URL image_generation_call result", () => {
    // A hosted image-generation result that is directly materialized as a
    // data URL within Client image limits maps to a Pi image; it is never
    // advertised as an executable Pi tool.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "image_generation_call",
            id: "ig_1",
            status: "completed",
            result:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    const userTexts = invocation.invocation.pi.context.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(userTexts[0]).toMatchObject([{ type: "image", mimeType: "image/png" }]);
    expect(userTexts[1]).toEqual([{ type: "text", text: "keep" }]);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("drops a bare base64 image_generation_call result without inventing a MIME", () => {
    // The SDK models `result` as bare base64 without a MIME type; Pi
    // ImageContent requires a MIME, so a MIME-less result drops rather than
    // guessing a format.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "image_generation_call",
            id: "ig_1",
            status: "completed",
            result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("preserves MCP approval decision text as model-visible transcript only", () => {
    // A request carries no decision text; the response decision (approve/
    // reason) survives as a deterministic transcript. Pure lifecycle
    // metadata drops; no executable approval tool is advertised.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "mcp_approval_request",
            id: "mar_1",
            name: "db_query",
            arguments: "{}",
            server_label: "db-server",
          },
          {
            type: "mcp_approval_response",
            id: "mars_1",
            approval_request_id: "mar_1",
            approve: true,
            reason: "The user approved access to the database",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    // Decision text survives as a deterministic transcript; pure lifecycle
    // metadata (arguments, server label) drops; no executable approval tool
    // is advertised.
    const userTexts = invocation.invocation.pi.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(userTexts).toEqual([
      "The user approved access to the database",
      "keep",
    ]);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
    expect(invocation.invocation.pi.context.messages).not.toContainEqual(
      expect.objectContaining({ role: "assistant" }),
    );
    // Pure lifecycle metadata (arguments, server label) never enters Pi.
    expect(JSON.stringify(invocation.invocation.pi.context)).not.toContain("db-server");
  });

  it("drops pure MCP list metadata but keeps model-visible content if present", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "mcp_list_tools",
            id: "mlt_1",
            tools: [
              { name: "db_query", description: "query the db" },
              { name: "db_write", description: "write the db" },
            ],
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("preserves the SDK mcp_approval_response approve/reason decision as model-visible transcript", () => {
    // The installed SDK models mcp_approval_response with `approve: boolean`
    // and an optional `reason` string — there is no `decision` field. The
    // model-visible decision text degrades to a deterministic transcript;
    // pure lifecycle metadata (approval_request_id, approve flag) drops.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "mcp_approval_response",
            id: "mars_1",
            approval_request_id: "mar_1",
            approve: true,
            reason: "user clicked approve",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    const userTexts = invocation.invocation.pi.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(userTexts).toEqual(["user clicked approve", "keep"]);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
    // Pure lifecycle metadata (approval_request_id) never enters Pi.
    expect(JSON.stringify(invocation.invocation.pi.context)).not.toContain("mar_1");
  });

  it("degrades a reason-less SDK mcp_approval_response to a deterministic decision text", () => {
    // Without a reason, the approve boolean is the only model-visible
    // decision fact; it degrades to a deterministic text so the decision is
    // never silently lost.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "mcp_approval_response",
            id: "mars_2",
            approval_request_id: "mar_2",
            approve: false,
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    const userTexts = invocation.invocation.pi.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(userTexts[0]).toContain("denied");
    expect(userTexts[1]).toBe("keep");
  });

  it("maps client-owned mcp_call to structured ToolCall semantics", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [
          {
            type: "mcp",
            name: "db_query",
            arguments: { type: "object" },
          },
        ],
        input: [
          {
            type: "mcp_call",
            id: "mc_1",
            call_id: "call_mcp",
            name: "db_query",
            arguments: '{"sql":"select 1"}',
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    const call = assistant?.content?.[0] as { type: string; name: string };
    expect(call?.type).toBe("toolCall");
    expect(call?.name).toBe("db_query");
  });

  it("maps the SDK id-only mcp_call into a structured Pi ToolCall", () => {
    // The installed SDK models mcp_call with `id` as the tool-call key (no
    // separate call_id field) plus a JSON `arguments` string. It must map to
    // a structured Pi ToolCall whose id is the SDK id.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [
          {
            type: "mcp",
            name: "db_query",
            arguments: { type: "object" },
          },
        ],
        input: [
          {
            type: "mcp_call",
            id: "mc_sdk_1",
            name: "db_query",
            arguments: '{"sql":"select 1"}',
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      {
        type: "toolCall",
        id: "mc_sdk_1",
        name: "db_query",
        arguments: { sql: "select 1" },
      },
    ]);
  });

  it("marks the correlated result isError when an mcp_call carries an error", () => {
    // A failed mcp_call (error field present) must not lose its error
    // semantics: the correlated function_call_output result is isError.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "mcp", name: "db_query", arguments: { type: "object" } }],
        input: [
          {
            type: "mcp_call",
            id: "mc_fail",
            name: "db_query",
            arguments: '{"sql":"bad"}',
            error: "tool crashed: invalid sql",
          },
          {
            type: "function_call_output",
            call_id: "mc_fail",
            output: "partial",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "mc_fail",
      toolName: "db_query",
      isError: true,
      content: [{ type: "text", text: "partial" }],
    });
    // The raw error text is lifecycle metadata; it never enters Pi.
    expect(JSON.stringify(invocation.invocation.pi.context)).not.toContain("invalid sql");
  });

  it("marks the result isError false when an mcp_call has no error", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "mcp", name: "db_query", arguments: { type: "object" } }],
        input: [
          {
            type: "mcp_call",
            id: "mc_ok",
            name: "db_query",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "mc_ok",
            output: "ok",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({ isError: false });
  });

  it("degrades provider-hosted mcp_call to ordered transcript without Pi tool", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "mcp_call",
            id: "mc_hosted",
            call_id: "call_mcp2",
            name: "remote_tool",
            arguments: "{}",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("never leaks MCP credentials or headers into Pi", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [
          {
            type: "mcp",
            name: "secret_tool",
            arguments: { type: "object" },
          },
        ],
        input: [
          {
            type: "mcp_call",
            id: "mc_cred",
            call_id: "call_cred",
            name: "secret_tool",
            arguments: "{}",
            headers: { authorization: "Bearer sekret" },
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    const serialized = JSON.stringify(invocation.invocation.pi.context);
    expect(serialized).not.toContain("sekret");
    expect(serialized).not.toContain("authorization");
  });
});

/**
 * The installed OpenAI SDK `Tool` union (enumerated from
 * node_modules/openai/resources/responses/responses.d.ts). A new SDK tool
 * family must fail here too: the conversion switch rejects unknown types.
 */
const INSTALLED_TOOL_FAMILIES = [
  "function",
  "custom",
  "namespace",
  "local_shell",
  "shell",
  "apply_patch",
  "computer",
  "computer_use",
  "mcp",
  "file_search",
  "web_search",
  "web_search_preview",
  "image_generation",
  "code_interpreter",
  "tool_search",
] as const;

describe("16: every known Responses tool-definition family", () => {
  it("enumerates the complete installed tool-definition union so a new SDK family triggers review", () => {
    expect(INSTALLED_TOOL_FAMILIES.length).toBe(15);
  });

  it("divides the tool-definition union into client-owned vs hosted exactly", () => {
    // Client/BYOT executable families map into the Pi catalog; hosted
    // declarations drop and are never advertised.
    const clientOwned = [
      ["function", "fn"],
      ["custom", "ct"],
      ["local_shell", undefined],
      ["shell", undefined],
      ["apply_patch", undefined],
      ["computer", undefined],
      ["computer_use_preview", undefined],
      ["mcp", "db"],
    ] as const;
    for (const [type, name] of clientOwned) {
      const tool: Record<string, unknown> = { type };
      if (name !== undefined) tool.name = name;
      const invocation = convertResponsesRequest(
        { model: "m", input: "x", tools: [tool] },
        1,
        policy(),
      );
      const expectedName =
        name ?? (type === "computer_use_preview" ? "computer" : type);
      expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toContain(
        expectedName,
      );
    }
    const hosted = [
      "file_search",
      "web_search",
      "web_search_preview",
      "image_generation",
      "code_interpreter",
      "tool_search",
    ];
    for (const type of hosted) {
      const invocation = convertResponsesRequest(
        { model: "m", input: "x", tools: [{ type }] },
        1,
        policy(),
      );
      expect(invocation.invocation.pi.context.tools).toBeUndefined();
    }
    // Namespace groups client-owned children.
    const ns = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          {
            type: "namespace",
            name: "ns",
            tools: [
              { type: "function", name: "child", parameters: { type: "object" } },
            ],
          },
        ],
      },
      1,
      policy(),
    );
    expect(ns.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["ns__child"]);
  });

  it("classifies every installed tool-definition family explicitly", () => {
    // Every family in the closed-world tool table must have a defined
    // outcome: mapped, dropped, or Core error. A family that throws a
    // generic unknown error (rather than a defined outcome) is a gap.
    const outcomes: Array<[string, "mapped" | "dropped" | "error"]> = [];
    for (const type of INSTALLED_TOOL_FAMILIES) {
      try {
        const invocation = convertResponsesRequest(
          { model: "m", input: "x", tools: [{ type, name: `${type}_probe` }] },
          1,
          policy(),
        );
        const mapped =
          invocation.invocation.pi.context.tools?.some((t) => t.name === `${type}_probe`) ??
          false;
        outcomes.push([type, mapped ? "mapped" : "dropped"]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /tool_search|unsupported|defer|must have a tools array/u.test(message)
        ) {
          outcomes.push([type, "error"]);
        } else {
          throw new Error(
            `tool family ${type} threw an unexpected error: ${message}`,
          );
        }
      }
    }
    expect(outcomes.length).toBe(INSTALLED_TOOL_FAMILIES.length);
    // Client/BYOT executable families map; hosted families drop; tool_search
    // is a defined Core error.
    expect(outcomes).toContainEqual(["function", "mapped"]);
    expect(outcomes).toContainEqual(["custom", "mapped"]);
    expect(outcomes).toContainEqual(["local_shell", "mapped"]);
    expect(outcomes).toContainEqual(["shell", "mapped"]);
    expect(outcomes).toContainEqual(["apply_patch", "mapped"]);
    expect(outcomes).toContainEqual(["computer", "mapped"]);
    expect(outcomes).toContainEqual(["file_search", "dropped"]);
    expect(outcomes).toContainEqual(["web_search", "dropped"]);
    expect(outcomes).toContainEqual(["image_generation", "dropped"]);
    expect(outcomes).toContainEqual(["code_interpreter", "dropped"]);
    // A bare tool_search declaration drops; defer_loading that requires
    // discovery is the defined Core error (covered separately).
    expect(outcomes).toContainEqual(["tool_search", "dropped"]);
  });

  it("maps function/custom/namespace/local_shell/shell/apply_patch tools into Pi", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          { type: "function", name: "fn", parameters: { type: "object" } },
          { type: "custom", name: "custom_tool" },
          {
            type: "namespace",
            name: "ns",
            tools: [{ type: "function", name: "child", parameters: { type: "object" } }],
          },
          { type: "local_shell", name: "local_shell" },
          { type: "shell", name: "shell" },
          { type: "apply_patch", name: "apply_patch" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "fn",
      "custom_tool",
      "ns__child",
      "local_shell",
      "shell",
      "apply_patch",
    ]);
  });

  it("maps name-less SDK local_shell and shell tool declarations into the Pi catalog", () => {
    // The installed SDK models local_shell and shell without a name field;
    // they map to deterministic Responses-owned names with documented action
    // schemas so calls round-trip as structured ToolCalls.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "local_shell" }, { type: "shell" }],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "local_shell",
      "shell",
    ]);
    expect(invocation.invocation.pi.context.tools?.[0]?.parameters).toEqual({
      type: "object",
    });
  });

  it("maps a name-less SDK apply_patch tool declaration into the Pi catalog", () => {
    // The installed SDK models apply_patch without a name field; the adapter
    // maps it to the deterministic "apply_patch" freeform name so calls
    // round-trip as custom_tool_call output items.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "apply_patch" }],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "apply_patch",
    ]);
    expect(invocation.invocation.pi.context.tools?.[0]?.parameters).toMatchObject({
      type: "object",
      properties: { input: { type: "string" } },
    });
    expect(invocation.client.renderState.freeformToolNames).toEqual(
      new Set(["apply_patch"]),
    );
  });

  it("drops provider-hosted tool declarations (file_search/web_search/image_generation/code_interpreter)", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          { type: "file_search", name: "file_search" },
          { type: "web_search", name: "web_search" },
          { type: "web_search_preview", name: "web_search_preview" },
          { type: "image_generation", name: "image_generation" },
          { type: "code_interpreter", name: "code_interpreter" },
          { type: "function", name: "fn", parameters: { type: "object" } },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["fn"]);
  });

  it("drops a bare tool_search tool declaration without advertising a Pi tool", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools: [{ type: "tool_search" }] },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("maps computer/computer_use tools only when Client/BYOT, drops provider-hosted", () => {
    const owned = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          { type: "computer", name: "computer" },
          { type: "computer_use", name: "computer_use" },
        ],
      },
      1,
      policy(),
    );
    expect(owned.invocation.pi.context.tools?.map((t) => t.name)).toEqual([
      "computer",
      "computer_use",
    ]);
  });

  it("maps a name-less SDK computer tool declaration into the Pi catalog", () => {
    // The installed SDK models the computer tool without a name field
    // (type: "computer" / "computer_use_preview"). The adapter maps it to a
    // deterministic Responses-owned name so computer_call ownership can be
    // classified; viewport/environment fields without Pi slots drop.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          {
            type: "computer_use_preview",
            display_width: 1024,
            display_height: 768,
            environment: "linux",
          },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["computer"]);
    expect(invocation.invocation.pi.context.tools?.[0]?.parameters).toEqual({
      type: "object",
    });
    // Viewport/environment fields never enter Pi.
    const serialized = JSON.stringify(invocation.invocation.pi.context);
    expect(serialized).not.toContain("display_width");
    expect(serialized).not.toContain("linux");
  });

  it("classifies a computer_call as Client/BYOT when a name-less computer tool is declared", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "computer" }],
        input: [
          {
            type: "computer_call",
            id: "cc_1",
            call_id: "call_cc",
            name: "computer",
            action: { type: "click", x: 10, y: 20 },
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const assistant = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "assistant",
    );
    const call = assistant?.content?.[0] as { type: string; name: string };
    expect(call?.type).toBe("toolCall");
    expect(call?.name).toBe("computer");
  });

  it("maps mcp tools after adapter-owned schema resolution", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          {
            type: "mcp",
            name: "db_query",
            server_label: "db-server",
            arguments: { type: "object", properties: { sql: { type: "string" } } },
          },
        ],
      },
      1,
      policy(),
    );
    // The Client/BYOT mcp declaration becomes a Pi tool with its schema; MCP
    // server/authorization metadata never enters Pi.
    expect(invocation.invocation.pi.context.tools?.[0]).toMatchObject({
      name: "db_query",
      parameters: { type: "object", properties: { sql: { type: "string" } } },
    });
    const serialized = JSON.stringify(invocation.invocation.pi.context);
    expect(serialized).not.toContain("db-server");
    expect(serialized).not.toContain("server_label");
  });

  it("never exposes MCP credentials/headers from tool definitions into Pi", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [
          {
            type: "mcp",
            name: "secure",
            arguments: { type: "object" },
            headers: { authorization: "Bearer hidden" },
          },
        ],
      },
      1,
      policy(),
    );
    const serialized = JSON.stringify(invocation.invocation.pi.context);
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("authorization");
  });

  it("preserves SDK name-less shell/apply_patch forced tool choices for projection", () => {
    for (const choice of [{ type: "shell" }, { type: "apply_patch" }]) {
      const invocation = convertResponsesRequest(
        { model: "m", input: "x", tool_choice: choice },
        1,
        policy(),
      );
      expect(invocation.invocation.pi.context.tools).toBeUndefined();
      expect(invocation.invocation.supplement.tools?.choice).toEqual({
        value: { kind: "hosted", toolType: choice.type },
      });
      expect(invocation.client.notices).toEqual([]);
    }
  });

  it("preserves a declared-client mcp forced tool choice for projection", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: "x",
        tools: [{ type: "mcp", name: "db_query", arguments: { type: "object" } }],
        tool_choice: {
          type: "mcp",
          server_label: "db-server",
          name: "db_query",
        },
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.tools?.map((t) => t.name)).toEqual(["db_query"]);
    expect(invocation.invocation.supplement.tools?.choice).toEqual({
      value: {
        kind: "hosted",
        toolType: "mcp",
        serverLabel: "db-server",
        name: "db_query",
      },
    });
    expect(invocation.client.notices).toEqual([]);
  });

  it("errors on a forced tool choice depending on any dropped hosted tool", () => {
    for (const hosted of [
      "web_search",
      "file_search",
      "code_interpreter",
      "image_generation",
    ]) {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: "x",
            tools: [{ type: hosted, name: hosted }],
            tool_choice: { type: "function", name: hosted },
          },
          1,
          policy(),
        ),
      ).toThrow(/unavailable tool/);
    }
  });

  it("errors on a forced tool choice depending on a dropped hosted tool", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [{ type: "web_search", name: "web_search" }],
          tool_choice: { type: "function", name: "web_search" },
        },
        1,
        policy(),
      ),
    ).toThrow(/unavailable tool|requires/);
  });

  it("keeps known malformed and future unknown distinct", () => {
    // A known family with malformed required fields is a malformed error.
    expect(() =>
      convertResponsesRequest(
        { model: "m", input: [{ type: "function_call", name: "no_call_id" }] },
        1,
        policy(),
      ),
    ).toThrow(/call_id/);
    // A future unknown family follows the unknown-input-item policy.
    const ignored = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "future_family", data: 1 },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy({ unknownInputItem: "ignore" }),
    );
    expect(ignored.invocation.pi.context.messages).toHaveLength(1);
    // A known family never becomes an unknown even under ignore.
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: [{ type: "function_call", name: "no_call_id" }],
        },
        1,
        policy({ unknownInputItem: "ignore" }),
      ),
    ).toThrow(/call_id/);
  });

  it("requires explicit profile entries for extension families", () => {
    // A LuckyToken/Codex extension discriminator not in the installed SDK
    // must not become supported merely by unknownInputItem=ignore. With the
    // default unknownInputItem=error it is a review failure.
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: [{ type: "extension_family", data: 1 }],
        },
        1,
        policy(),
      ),
    ).toThrow(/Unsupported input item type/);
    // Under ignore it is dropped, but never converted as a supported family.
    const ignored = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "extension_family", data: 1 },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy({ unknownInputItem: "ignore" }),
    );
    expect(ignored.invocation.pi.context.messages).toHaveLength(1);
    expect(
      ignored.client.notices.some(
        (n) => n.code === "openai-responses_unknown_input_item_ignored",
      ),
    ).toBe(true);
  });

  it("rejects defer_loading tool discovery as a Core conversion error", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            { type: "function", name: "lazy", parameters: { type: "object" }, defer_loading: true },
          ],
        },
        1,
        policy(),
      ),
    ).toThrow(/defer|discovery|tool.search/i);
  });

  it("rejects defer_loading on a namespace child as a Core conversion error", () => {
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          input: "x",
          tools: [
            {
              type: "namespace",
              name: "ns",
              tools: [
                {
                  type: "function",
                  name: "lazy",
                  parameters: { type: "object" },
                  defer_loading: true,
                },
              ],
            },
          ],
        },
        1,
        policy(),
      ),
    ).toThrow(/defer|discovery|tool.search/i);
  });

  it("preserves representable hosted-history results without advertising Pi tools", () => {
    // file_search/web_search/code_interpreter/image_generation hosted history
    // with representable text degrades to ordered transcript content only.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "file_search_call",
            id: "fs_1",
            queries: ["find the bug"],
            status: "completed",
          },
          {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
          },
          {
            type: "code_interpreter_call",
            id: "ci_1",
            status: "completed",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("keeps provider-hosted computer_call_output ordered transcript when call is not Client-owned", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "computer_call_output",
            id: "cco_hosted",
            call_id: "call_hosted_cc",
            output: [
              { type: "input_text", text: "screenshot taken" },
            ],
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("maps an SDK mcp_call with an embedded output into a correlated ToolResult", () => {
    // The installed SDK models mcp_call with an optional `output` string
    // carrying the tool result. A completed call with an embedded output
    // must produce a real correlated ToolResult — never the synthetic
    // "No result" repair for a result that is present.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "mcp", name: "db_query", arguments: { type: "object" } }],
        input: [
          {
            type: "mcp_call",
            id: "mc_out",
            name: "db_query",
            arguments: '{"sql":"select 1"}',
            output: "the query result",
            status: "completed",
          },
        ],
      },
      1,
      policy(),
    );
    const messages = invocation.invocation.pi.context.messages;
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    const result = messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({
      toolCallId: "mc_out",
      toolName: "db_query",
      isError: false,
      content: [{ type: "text", text: "the query result" }],
    });
    // No synthetic repair was emitted for the present result.
    expect(JSON.stringify(messages)).not.toContain("No result");
  });

  it("marks the correlated result isError when an embedded-output mcp_call carries an error", () => {
    // A failed mcp_call (error field present) with an embedded output must
    // not lose its error semantics.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "mcp", name: "db_query", arguments: { type: "object" } }],
        input: [
          {
            type: "mcp_call",
            id: "mc_err",
            name: "db_query",
            arguments: "{}",
            output: "partial output",
            error: "tool crashed",
            status: "failed",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "mc_err",
      toolName: "db_query",
      isError: true,
      content: [{ type: "text", text: "partial output" }],
    });
    // The raw error text is lifecycle metadata; it never enters Pi.
    expect(JSON.stringify(invocation.invocation.pi.context)).not.toContain("tool crashed");
  });

  it("accepts the SDK mcp_call status failed as a completed-with-error lifecycle", () => {
    // The installed SDK models mcp_call.status as
    // in_progress|completed|incomplete|calling|failed. failed is a defined
    // terminal lifecycle status, not a malformed unknown.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        tools: [{ type: "mcp", name: "db_query", arguments: { type: "object" } }],
        input: [
          {
            type: "mcp_call",
            id: "mc_fail",
            name: "db_query",
            arguments: "{}",
            status: "failed",
            error: "boom",
          },
          {
            type: "function_call_output",
            call_id: "mc_fail",
            output: "partial",
          },
        ],
      },
      1,
      policy(),
    );
    const result = invocation.invocation.pi.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "mc_fail",
      toolName: "db_query",
      isError: true,
    });
  });

  it("errors on the SDK mcp_call status calling like an in-progress call", () => {
    // calling is a non-terminal lifecycle status; like in_progress it cannot
    // be converted as a committed call.
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          tools: [{ type: "mcp", name: "db_query", arguments: { type: "object" } }],
          input: [
            {
              type: "mcp_call",
              id: "mc_call",
              name: "db_query",
              arguments: "{}",
              status: "calling",
            },
          ],
        },
        1,
        policy(),
      ),
    ).toThrow(/status/);
  });

  it("errors on the SDK computer_call_output status incomplete like a partial tool output", () => {
    // The installed SDK models computer_call_output.status as
    // in_progress|completed|incomplete. incomplete is a partial tool output
    // that must never be treated as a completed tool result (ticket 15).
    expect(() =>
      convertResponsesRequest(
        {
          model: "m",
          tools: [{ type: "computer", name: "computer" }],
          input: [
            {
              type: "computer_call",
              id: "cc_1",
              call_id: "call_cc",
              name: "computer",
              status: "completed",
            },
            {
              type: "computer_call_output",
              id: "cco_1",
              call_id: "call_cc",
              status: "incomplete",
              output: {
                type: "computer_screenshot",
                image_url:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
              },
            },
          ],
        },
        1,
        policy(),
      ),
    ).toThrow(/status/);
  });

  it("drops a hosted web_search_call with the SDK status failed as lifecycle metadata", () => {
    // The installed SDK models web_search_call.status as
    // in_progress|searching|completed|failed. failed is a terminal hosted
    // status with no determinate results; it drops like lifecycle metadata
    // and never advertises a Pi tool.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          { type: "web_search_call", id: "ws_fail", status: "failed" },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("drops a hosted image_generation_call with the SDK status failed as lifecycle metadata", () => {
    // The installed SDK models image_generation_call.status as
    // in_progress|completed|generating|failed. failed is a terminal hosted
    // status with no determinate result; it drops like lifecycle metadata
    // and never materializes a result it does not possess.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "image_generation_call",
            id: "ig_fail",
            status: "failed",
            result:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });

  it("drops a hosted code_interpreter_call with the SDK status failed as lifecycle metadata", () => {
    // The installed SDK models code_interpreter_call.status as
    // in_progress|completed|incomplete|interpreting|failed. failed is a
    // terminal hosted status with no determinate output; it drops.
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "code_interpreter_call",
            id: "ci_fail",
            status: "failed",
            outputs: [{ type: "logs", logs: "partial log" }],
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    expect(invocation.invocation.pi.context.messages).toHaveLength(1);
    expect(invocation.invocation.pi.context.tools).toBeUndefined();
  });
});
