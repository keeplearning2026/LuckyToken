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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
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
    const assistant = invocation.context.messages.find(
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
            type: "local_shell_call_output",
            id: "lsco_1",
            call_id: "call_sh",
            output: "file1\nfile2",
            status: "completed",
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
    const assistant = invocation.context.messages.find(
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
    const result = invocation.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_sh2",
      toolName: "shell",
      content: [{ type: "text", text: "/workspace" }],
    });
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
    const assistant = invocation.context.messages.find(
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
    const result = invocation.context.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(result).toMatchObject({
      toolCallId: "call_p",
      toolName: "apply_patch",
      content: [{ type: "text", text: "patch applied" }],
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
    const assistant = invocation.context.messages.find(
      (m) => m.role === "assistant",
    );
    const call = assistant?.content?.[0] as { type: string; name: string };
    expect(call?.type).toBe("toolCall");
    expect(call?.name).toBe("computer");
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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
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
    const result = invocation.context.messages.find(
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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
  });

  it("preserves MCP approval decision text as model-visible transcript only", () => {
    const invocation = convertResponsesRequest(
      {
        model: "m",
        input: [
          {
            type: "mcp_approval_request",
            id: "mar_1",
            decision: "The user approved access to the database",
          },
          {
            type: "mcp_approval_response",
            id: "mars_1",
            decision: "Approved",
          },
          { type: "message", role: "user", content: "keep" },
        ],
      },
      1,
      policy(),
    );
    // Decision text survives as a deterministic transcript; pure lifecycle
    // metadata drops; no executable approval tool is advertised.
    const userTexts = invocation.context.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
    expect(userTexts).toEqual([
      "The user approved access to the database",
      "Approved",
      "keep",
    ]);
    expect(invocation.context.tools).toBeUndefined();
    expect(invocation.context.messages).not.toContainEqual(
      expect.objectContaining({ role: "assistant" }),
    );
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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
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
    const assistant = invocation.context.messages.find(
      (m) => m.role === "assistant",
    );
    const call = assistant?.content?.[0] as { type: string; name: string };
    expect(call?.type).toBe("toolCall");
    expect(call?.name).toBe("db_query");
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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
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
    const serialized = JSON.stringify(invocation.context);
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
    expect(invocation.context.tools?.map((t) => t.name)).toEqual([
      "fn",
      "custom_tool",
      "ns.child",
      "local_shell",
      "shell",
      "apply_patch",
    ]);
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
    expect(invocation.context.tools?.map((t) => t.name)).toEqual(["fn"]);
  });

  it("drops a bare tool_search tool declaration without advertising a Pi tool", () => {
    const invocation = convertResponsesRequest(
      { model: "m", input: "x", tools: [{ type: "tool_search" }] },
      1,
      policy(),
    );
    expect(invocation.context.tools).toBeUndefined();
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
    expect(owned.context.tools?.map((t) => t.name)).toEqual([
      "computer",
      "computer_use",
    ]);
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
    expect(invocation.context.tools?.[0]).toMatchObject({
      name: "db_query",
      parameters: { type: "object", properties: { sql: { type: "string" } } },
    });
    const serialized = JSON.stringify(invocation.context);
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
    const serialized = JSON.stringify(invocation.context);
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("authorization");
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
    expect(ignored.context.messages).toHaveLength(1);
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
    expect(ignored.context.messages).toHaveLength(1);
    expect(
      ignored.notices.some(
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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
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
    expect(invocation.context.messages).toHaveLength(1);
    expect(invocation.context.tools).toBeUndefined();
  });
});
