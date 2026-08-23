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
    expect(converted.invocation.supplement.content).toContainEqual(
      expect.objectContaining({ value: block, piRepresentation: "partial" }),
    );
  });

  it.each([
    [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "2h" } }, /ttl/u],
    [{ type: "text", text: "x", citations: [{ type: "char_location", cited_text: "x" }] }, /citation/u],
    [{ type: "tool_use", id: "t", name: "tool", input: {}, caller: { type: "server" } }, /caller/u],
    [{ type: "document", source: { type: "base64", media_type: "text/plain", data: "AAAA" } }, /application\/pdf/u],
    [{ type: "document", source: { type: "url", url: "https://example.test/a.pdf" }, citations: { enabled: "yes" } }, /citations/u],
    [{ type: "search_result", source: "s", title: "t", content: "body" }, /content.*array/u],
    [{ type: "container_upload", file_id: "f", unexpected: true }, /unexpected/u],
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
    [{ name: "lookup", input_schema: { type: "object" }, future_control: true }, /unexpected/u],
    [{ name: "web_search", type: "web_search_20250305", allowed_domains: [], blocked_domains: [] }, /mutually exclusive/u],
    [{ name: "wrong", type: "web_search_20250305" }, /name must be web_search/u],
  ])("rejects malformed recognized tool controls %#", (tool, pattern) => {
    expect(() => parseAnthropicTextInvocation({
      ...request("hello"),
      tools: [tool],
    }, 1)).toThrow(pattern);
  });
});
