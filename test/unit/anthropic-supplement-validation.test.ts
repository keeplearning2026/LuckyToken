import { describe, expect, it } from "vitest";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";

function request(content: unknown): Record<string, unknown> {
  return {
    model: "model",
    max_tokens: 1_024,
    messages: [{ role: "user", content }],
  };
}

describe("Anthropic supplement validation", () => {
  it("preserves an own __proto__ key in an arbitrary JSON Schema", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as Record<string, unknown>;
    const converted = parseAnthropicTextInvocation({
      ...request("hello"),
      output_config: { format: { type: "json_schema", schema } },
    }, 1);
    const outputFormat = converted.invocation.supplement.controls.outputFormat?.value;
    expect(outputFormat).not.toBeNull();
    expect(Object.hasOwn(outputFormat!.schema.properties as object, "__proto__")).toBe(true);
    expect(JSON.stringify(outputFormat!.schema)).toBe(JSON.stringify(schema));
  });

  it("rejects an accessor inside a consumed arbitrary JSON Schema", () => {
    const schema: Record<string, unknown> = {};
    Object.defineProperty(schema, "type", {
      enumerable: true,
      get: () => "object",
    });

    expect(() => parseAnthropicTextInvocation({
      ...request("hello"),
      output_config: { format: { type: "json_schema", schema } },
    }, 1)).toThrow(/accessor/iu);
  });

  it("creates one atomic candidate for each independent custom-tool extension", () => {
    const converted = parseAnthropicTextInvocation({
      ...request("hello"),
      tools: [{
        name: "lookup",
        input_schema: { type: "object" },
        allowed_callers: ["direct"],
        defer_loading: true,
        eager_input_streaming: null,
        input_examples: [{ query: "example" }],
      }],
    }, 1);

    expect(converted.invocation.supplement.tools).toEqual([
      expect.objectContaining({
        id: "tools[0].allowedCallers",
        kind: "custom-tool-caller-policy",
        value: ["direct"],
      }),
      expect.objectContaining({
        id: "tools[0].deferLoading",
        kind: "custom-tool-deferred-loading",
        value: true,
      }),
      expect.objectContaining({
        id: "tools[0].eagerInputStreaming",
        kind: "custom-tool-input-streaming",
        value: null,
      }),
      expect.objectContaining({
        id: "tools[0].inputExamples",
        kind: "custom-tool-input-examples",
        value: [{ query: "example" }],
      }),
    ]);
  });

  it("creates atomic content candidates without duplicating Pi-owned visible fields", () => {
    const citation = {
      type: "char_location",
      cited_text: "answer",
      document_index: 0,
      document_title: null,
      start_char_index: 0,
      end_char_index: 6,
    };
    const converted = parseAnthropicTextInvocation(request([
      { type: "text", text: "answer", citations: [citation] },
      {
        type: "document",
        source: { type: "url", url: "https://example.test/a.pdf" },
        citations: { enabled: true },
        title: "A",
      },
    ]), 1);

    expect(converted.invocation.supplement.content).toEqual([
      expect.objectContaining({
        id: "content[0:0].citations",
        kind: "text-citations",
        value: [citation],
      }),
      expect.objectContaining({
        id: "content[0:1].source",
        kind: "document-source",
        value: { type: "url", url: "https://example.test/a.pdf" },
      }),
      expect.objectContaining({
        id: "content[0:1].metadata",
        kind: "document-metadata",
        value: { citations: { enabled: true }, title: "A" },
      }),
    ]);
    expect(JSON.stringify(converted.invocation.supplement.content[0]?.value)).not.toContain(
      '"text":"answer"',
    );
  });

  it("accepts the pinned structured search-result grammar and retains it exactly", () => {
    const block = {
      type: "search_result",
      source: "https://example.test",
      title: "Result",
      content: [{ type: "text", text: "body", cache_control: { type: "ephemeral" } }],
      citations: { enabled: true },
      cache_control: { type: "ephemeral", ttl: "1h" },
    };
    const converted = parseAnthropicTextInvocation(request([block]), 1);
    expect(converted.invocation.pi.context.messages[0]?.content).toEqual([
      { type: "text", text: "Result\nbody" },
    ]);
    const contentValue = Object.fromEntries(
      Object.entries(block).filter(([key]) => key !== "cache_control"),
    );
    expect(converted.invocation.supplement.content).toContainEqual(
      expect.objectContaining({
        value: {
          ...contentValue,
          content: [{ type: "text", text: "body" }],
        },
        piRepresentation: "partial",
      }),
    );
    expect(converted.invocation.supplement.cache).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "content[0:0].cacheControl",
          value: { ttl: "1h" },
        }),
        expect.objectContaining({
          id: "content[0:0].content[0].cacheControl",
          attachment: expect.objectContaining({ nestedPath: ["content", 0] }),
          value: {},
        }),
      ]),
    );
  });

  it.each([
    [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "2h" } }, /ttl/u],
    [{ type: "text", text: "x", citations: [{ type: "char_location", cited_text: "x" }] }, /citation/u],
    [{ type: "tool_use", id: "t", name: "tool", input: {}, caller: { type: "server" } }, /caller/u],
    [{ type: "document", source: { type: "base64", media_type: "text/plain", data: "AAAA" } }, /application\/pdf/u],
    [{ type: "document", source: { type: "url", url: "https://example.test/a.pdf" }, citations: { enabled: "yes" } }, /citations/u],
    [{ type: "search_result", source: "s", title: "t", content: "body" }, /content.*array/u],
    [{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "future" } }, /web_search/u],
    [{
      type: "text",
      text: "x",
      citations: [{
        type: "web_search_result_location",
        cited_text: "x",
        encrypted_index: "opaque",
        url: "https://example.test",
      }],
    }, /title/u],
    [{
      type: "code_execution_tool_result",
      tool_use_id: "s",
      content: { type: "code_execution_result", return_code: 0, stdout: "ok", stderr: "", content: [{ type: "future", file_id: "f" }] },
    }, /code_execution_output/u],
    [{
      type: "web_fetch_tool_result",
      tool_use_id: "s",
      content: { type: "web_fetch_result", url: "https://example.test", content: { type: "future" } },
    }, /document/u],
    [{
      type: "tool_search_tool_result",
      tool_use_id: "s",
      content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference" }] },
    }, /tool_name/u],
  ])("rejects malformed recognized supplemental content %#", (block, pattern) => {
    expect(() => parseAnthropicTextInvocation(request([block]), 1)).toThrow(pattern);
  });

  it("leaves an unclaimed content sibling unread and outside the Supplement view", () => {
    const converted = parseAnthropicTextInvocation(request([{
      type: "container_upload",
      file_id: "f",
      future_control: { malformed: Symbol("unread") },
    }]), 1);

    expect(converted.invocation.supplement.content).toContainEqual(
      expect.objectContaining({
        id: "content[0:0].fileId",
        kind: "container-upload",
        value: { fileId: "f" },
      }),
    );
  });

  it.each([
    {
      type: "code_execution_tool_result",
      tool_use_id: "c",
      content: {
        type: "encrypted_code_execution_result",
        content: [{ type: "code_execution_output", file_id: "f" }],
        return_code: 0,
        encrypted_stdout: "opaque",
        stderr: "",
      },
    },
    {
      type: "bash_code_execution_tool_result",
      tool_use_id: "b",
      content: {
        type: "bash_code_execution_result",
        content: [{ type: "bash_code_execution_output", file_id: "f" }],
        return_code: 0,
        stdout: "ok",
        stderr: "",
      },
    },
    {
      type: "text_editor_code_execution_tool_result",
      tool_use_id: "e",
      content: {
        type: "text_editor_code_execution_view_result",
        content: "file",
        file_type: "text",
        num_lines: 1,
      },
    },
    {
      type: "tool_search_tool_result",
      tool_use_id: "t",
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "lookup" }],
      },
    },
    {
      type: "web_fetch_tool_result",
      tool_use_id: "w",
      caller: { type: "direct" },
      content: {
        type: "web_fetch_result",
        url: "https://example.test",
        retrieved_at: null,
        content: {
          type: "document",
          source: { type: "text", media_type: "text/plain", data: "body" },
        },
      },
    },
  ])("accepts and retains a validated typed server-result block %#", (block) => {
    const converted = parseAnthropicTextInvocation(request([block]), 1);
    expect(converted.invocation.supplement.content).toContainEqual(
      expect.objectContaining({ value: block, piRepresentation: "none" }),
    );
  });

  it("validates top-level system cache controls before retaining blocks", () => {
    expect(() => parseAnthropicTextInvocation({
      ...request("hello"),
      system: [{
        type: "text",
        text: "system",
        cache_control: { type: "ephemeral", ttl: "forever" },
      }],
    }, 1)).toThrow(/ttl/u);
  });

  it.each([
    [{ name: "lookup", input_schema: { type: "object" }, allowed_callers: ["server"] }, /allowed_callers/u],
    [{ name: "web_search", type: "web_search_20250305", allowed_domains: [], blocked_domains: [] }, /mutually exclusive/u],
    [{ name: "wrong", type: "web_search_20250305" }, /name must be web_search/u],
  ])("rejects malformed recognized tool controls %#", (tool, pattern) => {
    expect(() => parseAnthropicTextInvocation({
      ...request("hello"),
      tools: [tool],
    }, 1)).toThrow(pattern);
  });

  it("leaves an unclaimed tool sibling unread and outside the Supplement view", () => {
    const converted = parseAnthropicTextInvocation({
      ...request("hello"),
      tools: [{
        name: "lookup",
        input_schema: { type: "object" },
        defer_loading: true,
        future_control: { malformed: Symbol("unread") },
      }],
    }, 1);

    expect(converted.invocation.supplement.tools).toContainEqual(
      expect.objectContaining({
        id: "tools[0].deferLoading",
        kind: "custom-tool-deferred-loading",
        value: true,
      }),
    );
  });
});
