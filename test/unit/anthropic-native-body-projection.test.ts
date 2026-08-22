import { describe, expect, it } from "vitest";

import {
  AnthropicNativeBodyProjectionError,
  projectAnthropicNativeBody,
} from "../../src/provider-native-anthropic/body-projection.js";

describe("Anthropic Provider Native body projection", () => {
  it("replaces only the top-level model string span in model-only mode", () => {
    const rawBody =
      '{\n  "model" : "anthropic/claude-old",\n  "metadata": {"model":"semantic-value"},\n  "messages" : [ { "role": "user", "content": "keep spacing" } ],\n  "extension": [1, true, null]\n}';

    const result = projectAnthropicNativeBody({
      rawBody,
      modelId: "claude-new",
      mode: "model_only",
    });

    expect(result).toEqual({
      body: rawBody.replace('"anthropic/claude-old"', '"claude-new"'),
      applied: "model_only",
    });
  });

  it("applies only the pinned Claude Code identity and known tool-name differential", () => {
    const result = projectAnthropicNativeBody({
      rawBody: JSON.stringify({
        model: "anthropic/claude-old",
        system: [
          {
            type: "text",
            text: "Keep the client system instruction.",
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            name: "read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
            extension: "unchanged",
          },
          {
            name: "custom_tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "bash",
                input: { command: "pwd" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [
                  { type: "tool_reference", tool_name: "grep" },
                  { type: "text", text: "unchanged" },
                ],
              },
            ],
          },
        ],
        extension: { nested: [1, true, null] },
      }),
      modelId: "claude-new",
      mode: "anthropic_oauth",
    });

    expect(result.applied).toBe("anthropic_oauth");
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: "claude-new",
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        {
          type: "text",
          text: "Keep the client system instruction.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: {} },
          extension: "unchanged",
        },
        {
          name: "custom_tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "pwd" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                { type: "tool_reference", tool_name: "Grep" },
                { type: "text", text: "unchanged" },
              ],
            },
          ],
        },
      ],
      extension: { nested: [1, true, null] },
    });
  });

  it("preserves string system semantics by prepending an equivalent text block", () => {
    const result = projectAnthropicNativeBody({
      rawBody: JSON.stringify({
        model: "old",
        system: "Client system",
        messages: [],
      }),
      modelId: "new",
      mode: "anthropic_oauth",
    });

    expect(JSON.parse(result.body)).toMatchObject({
      model: "new",
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        { type: "text", text: "Client system" },
      ],
    });
  });

  it("fails closed when the required OAuth projection would need repair", () => {
    expect(() =>
      projectAnthropicNativeBody({
        rawBody: JSON.stringify({ model: "old", system: 42, messages: [] }),
        modelId: "new",
        mode: "anthropic_oauth",
      }),
    ).toThrow(AnthropicNativeBodyProjectionError);
  });

  it("rejects a missing or duplicate top-level model instead of guessing", () => {
    expect(() =>
      projectAnthropicNativeBody({
        rawBody: '{"messages":[]}',
        modelId: "new",
        mode: "model_only",
      }),
    ).toThrow(AnthropicNativeBodyProjectionError);
    expect(() =>
      projectAnthropicNativeBody({
        rawBody: '{"model":"one","model":"two","messages":[]}',
        modelId: "new",
        mode: "model_only",
      }),
    ).toThrow(AnthropicNativeBodyProjectionError);
  });
});
