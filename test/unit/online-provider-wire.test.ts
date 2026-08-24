import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  expectsForcedToolChoiceOmission,
  readOnlineProviderMessages,
  requireOnlineOpenAICompletionsProjection,
  requireOnlineReasoningReplay,
} from "../online/provider-wire.js";

describe("online final Provider wire reader", () => {
  it("keeps the GOAT forced-tool omission exact to its certified target", () => {
    expect(
      expectsForcedToolChoiceOmission(
        "commandcode-goat",
        "deepseek/deepseek-v4-flash",
      ),
    ).toBe(true);
    expect(
      expectsForcedToolChoiceOmission(
        "opencode-go",
        "deepseek-v4-flash",
      ),
    ).toBe(false);
  });

  it("keeps the direct Provider suite independent from Codex continuation state", async () => {
    const source = await readFile(
      new URL("../online/run-openai-responses.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/previous_response_id\s*:/u);
    expect(source).not.toContain("semanticOnly");
    expect(source).not.toMatch(/RequestJourney|request-journey|diagnostics/u);
  });

  it("certifies exact OpenAI Completions semantic controls", () => {
    expect(() =>
      requireOnlineOpenAICompletionsProjection(
        {
          tool_choice: { type: "function", function: { name: "lookup" } },
          parallel_tool_calls: false,
          response_format: {
            type: "json_schema",
            json_schema: { name: "answer", schema: { type: "object" } },
          },
          max_completion_tokens: 256,
        },
        {
          toolName: "lookup",
          schemaName: "answer",
          parallelToolCalls: false,
          maxOutputTokens: 512,
        },
      ),
    ).not.toThrow();
  });

  it("certifies that an incompatible forced tool choice is omitted instead of widened", () => {
    expect(() =>
      requireOnlineOpenAICompletionsProjection(
        {
          parallel_tool_calls: false,
          max_completion_tokens: 256,
        },
        {
          omitToolChoice: true,
          parallelToolCalls: false,
          maxOutputTokens: 512,
        },
      ),
    ).not.toThrow();
    expect(() =>
      requireOnlineOpenAICompletionsProjection(
        {
          tool_choice: "auto",
          parallel_tool_calls: false,
          max_completion_tokens: 256,
        },
        {
          omitToolChoice: true,
          parallelToolCalls: false,
          maxOutputTokens: 512,
        },
      ),
    ).toThrow(/wire_mismatch/u);
  });

  it("rejects a permissive success body whose controls are in the wrong dialect", () => {
    expect(() =>
      requireOnlineOpenAICompletionsProjection(
        {
          tool_choice: { type: "function", name: "lookup" },
          parallel_tool_calls: true,
          response_format: { type: "json_schema", name: "answer" },
          max_completion_tokens: 1_024,
        },
        {
          toolName: "lookup",
          schemaName: "answer",
          parallelToolCalls: false,
          maxOutputTokens: 512,
        },
      ),
    ).toThrow("online_openai_projection_wire_mismatch");
  });

  it("reads CommandCode Private structured messages", () => {
    expect(
      readOnlineProviderMessages("commandcode-private", {
        params: { messages: [{ role: "user", content: [] }] },
      }),
    ).toEqual([{ role: "user", content: [] }]);
  });

  it("reads any certified OpenAI Completions Provider payload by API", () => {
    expect(
      readOnlineProviderMessages("openai-completions", {
        messages: [{ role: "assistant", content: "answer" }],
      }),
    ).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("fails unknown Provider and incompatible payload shapes", () => {
    expect(() =>
      readOnlineProviderMessages("unknown-provider", {
        messages: [{ role: "assistant", content: "answer" }],
      }),
    ).toThrow(/online_unknown-provider_payload_shape/u);
    expect(() =>
      readOnlineProviderMessages("openai-completions", {
        params: { messages: "not-an-array" },
      }),
    ).toThrow(/online_openai-completions_payload_shape/u);
  });

  it("certifies reasoning replay at each Provider's exact attachment point", () => {
    expect(() =>
      requireOnlineReasoningReplay(
        "openai-completions",
        [
          {
            role: "assistant",
            content: "answer",
            reasoning_content: "prior summary",
          },
        ],
        "prior summary",
        "reasoning_content",
      ),
    ).not.toThrow();
    expect(() =>
      requireOnlineReasoningReplay(
        "openai-completions",
        [
          {
            role: "assistant",
            content: "answer",
            reasoning: "prior summary",
          },
        ],
        "prior summary",
        "reasoning",
      ),
    ).not.toThrow();
    expect(() =>
      requireOnlineReasoningReplay(
        "commandcode-private",
        [
          {
            role: "assistant",
            content: [
              { type: "reasoning", id: "reasoning-1", text: "prior summary" },
              { type: "text", id: "text-1", text: "answer" },
            ],
          },
        ],
        "prior summary",
      ),
    ).not.toThrow();
  });

  it("fails when the certified Provider request lacks exact reasoning replay", () => {
    expect(() =>
      requireOnlineReasoningReplay(
        "openai-completions",
        [{ role: "assistant", content: "prior summary" }],
        "prior summary",
        "reasoning_content",
      ),
    ).toThrow(/online_full_history_reasoning_replay_missing/u);
    expect(() =>
      requireOnlineReasoningReplay(
        "openai-completions",
        [{ role: "assistant", reasoning_content: "prior summary" }],
        "prior summary",
      ),
    ).toThrow(/online_reasoning_selector_missing/u);
    expect(() =>
      requireOnlineReasoningReplay(
        "commandcode-private",
        [
          {
            role: "assistant",
            content: [{ type: "text", id: "text-1", text: "prior summary" }],
          },
        ],
        "prior summary",
      ),
    ).toThrow(/online_full_history_reasoning_replay_missing/u);
  });
});
