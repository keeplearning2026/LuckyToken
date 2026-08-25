import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";
import { prepareResponsesReasoning as prepareReasoning } from "../../src/protocols/openai-responses/semantic/reasoning/request.js";
import { PINNED_RESPONSES_REASONING_APIS as PINNED_REASONING_APIS } from "../../src/protocols/openai-responses/semantic/reasoning/registry.js";

function model(
  api: string,
  provider: string,
  id: string,
  extra: Partial<Model<string>> = {},
): Model<string> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: "https://provider.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
    ...extra,
  };
}

function reasoningHistory(input: {
  source: { provider: string; api: string; model: string };
  attachment?: {
    kind: "opaque-signature" | "reasoning-field-selector";
    value: string;
    representation?: "redacted";
  };
  encryptedContent?: string;
}) {
  return convertResponsesRequest(
    {
      model: "client-selector",
      input: [
        {
          type: "reasoning",
          id: "rs_prior",
          status: "completed",
          summary: [{ type: "summary_text", text: "visible summary" }],
          ...(input.encryptedContent === undefined
            ? {}
            : { encrypted_content: input.encryptedContent }),
          token_continuity: {
            version: 1,
            source: input.source,
            attachments:
              input.attachment === undefined
                ? []
                : [
                    {
                      target: "thinking",
                      ...input.attachment,
                    },
                  ],
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
}

function prepare(target: Model<string>, converted: ReturnType<typeof reasoningHistory>) {
  return prepareReasoning({
    model: target,
    context: converted.invocation.pi.context,
    options: converted.invocation.pi.options,
    semantics: converted.invocation.reasoning,
  });
}

describe("pinned Pi reasoning Adapter matrix", () => {
  it("registers every pinned Pi 0.84.2 text API explicitly", () => {
    expect([...PINNED_REASONING_APIS].sort()).toEqual(
      [
        "anthropic-messages",
        "azure-openai-responses",
        "bedrock-converse-stream",
        "google-generative-ai",
        "google-vertex",
        "mistral-conversations",
        "openai-codex-responses",
        "openai-completions",
        "openai-responses",
        "pi-messages",
      ].sort(),
    );
  });

  it.each([
    ["openai-responses", "openai"],
    ["azure-openai-responses", "azure"],
    ["openai-codex-responses", "openai-codex"],
  ] as const)("restores a complete %s reasoning item only for the same target", (api, provider) => {
    const source = { provider, api, model: "responses-model" };
    const converted = reasoningHistory({
      source,
      encryptedContent: "encrypted-reasoning",
    });
    const exact = prepare(model(api, provider, source.model), converted);
    const switched = prepare(model(api, provider, "other-model"), converted);

    expect(exact.context.messages[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinking: "visible summary",
      thinkingSignature: expect.stringContaining("encrypted-reasoning"),
    });
    expect(exact.context.messages[0]).toMatchObject(source);
    expect(switched.context.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "visible summary",
    });
  });

  it("restores Anthropic opaque thinking and only permits unsigned replay when compat allows it", () => {
    const source = {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
    };
    const signed = prepare(
      model(source.api, source.provider, source.model),
      reasoningHistory({
        source,
        attachment: { kind: "opaque-signature", value: "anthropic-signature" },
      }),
    );
    const unsignedAllowed = prepare(
      model(source.api, source.provider, source.model, {
        compat: { allowEmptySignature: true },
      } as Partial<Model<string>>),
      reasoningHistory({ source }),
    );
    const unsignedDefault = prepare(
      model(source.api, source.provider, source.model),
      reasoningHistory({ source }),
    );

    expect(signed.context.messages[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: "anthropic-signature",
    });
    expect(unsignedAllowed.context.messages[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: "",
    });
    expect(unsignedDefault.context.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "visible summary",
    });
  });

  it("restores redacted Anthropic continuity only for the exact target", () => {
    const source = {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
    };
    const converted = reasoningHistory({
      source,
      attachment: {
        kind: "opaque-signature",
        value: "opaque-redacted-data",
        representation: "redacted",
      },
    });
    const exact = prepare(model(source.api, source.provider, source.model), converted);
    const switched = prepare(model(source.api, source.provider, "claude-other"), converted);

    expect(exact.context.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "visible summary",
      thinkingSignature: "opaque-redacted-data",
      redacted: true,
    });
    expect(switched.context.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "visible summary",
    });
  });

  it("selects Bedrock signed Claude replay versus unsigned non-Claude replay", () => {
    const claudeSource = {
      provider: "amazon-bedrock",
      api: "bedrock-converse-stream",
      model: "anthropic.claude-test",
    };
    const novaSource = {
      provider: "amazon-bedrock",
      api: "bedrock-converse-stream",
      model: "amazon.nova-test",
    };
    const claude = prepare(
      model(claudeSource.api, claudeSource.provider, claudeSource.model),
      reasoningHistory({
        source: claudeSource,
        attachment: { kind: "opaque-signature", value: "bedrock-signature" },
      }),
    );
    const nova = prepare(
      model(novaSource.api, novaSource.provider, novaSource.model),
      reasoningHistory({ source: novaSource }),
    );

    expect(claude.context.messages[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: "bedrock-signature",
    });
    expect(nova.context.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "visible summary",
    });
    expect(nova.context.messages[0]).toMatchObject(novaSource);
  });

  it.each([
    ["google-generative-ai", "google", "gemini-test"],
    ["google-vertex", "google-vertex", "gemini-test"],
    ["mistral-conversations", "mistral", "magistral-test"],
    ["pi-messages", "radius", "delegated-test"],
  ] as const)("certifies visible same-target replay for %s", (api, provider, id) => {
    const source = { provider, api, model: id };
    const result = prepare(model(api, provider, id), reasoningHistory({ source }));

    expect(result.context.messages[0]?.content[0]).toEqual({
      type: "thinking",
      thinking: "visible summary",
    });
    expect(result.context.messages[0]).toMatchObject(source);
  });

  it("restores Google thought signatures to their original text and tool-call attachments", () => {
    const source = {
      provider: "google",
      api: "google-generative-ai",
      model: "gemini-test",
    };
    const converted = convertResponsesRequest(
      {
        model: "client-selector",
        input: [
          {
            type: "message",
            id: "msg_prior",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
            token_continuity: {
              version: 1,
              source,
              attachments: [
                {
                  target: "text",
                  partIndex: 0,
                  kind: "opaque-signature",
                  value: "dGV4dC1zaWduYXR1cmU=",
                },
              ],
            },
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
            token_continuity: {
              version: 1,
              source,
              attachments: [
                {
                  target: "toolCall",
                  callId: "call_1",
                  kind: "opaque-signature",
                  value: "dG9vbC1zaWduYXR1cmU=",
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
    const exact = prepareReasoning({
      model: model(source.api, source.provider, source.model),
      context: converted.invocation.pi.context,
      options: converted.invocation.pi.options,
      semantics: converted.invocation.reasoning,
    });
    const assistantMessages = exact.context.messages.filter(
      (message) => message.role === "assistant",
    );
    const text = assistantMessages
      .flatMap((message) => message.content)
      .find((block) => block.type === "text");
    const tool = assistantMessages
      .flatMap((message) => message.content)
      .find((block) => block.type === "toolCall");

    expect(text).toMatchObject({
      type: "text",
      textSignature: "dGV4dC1zaWduYXR1cmU=",
    });
    expect(tool).toMatchObject({
      type: "toolCall",
      thoughtSignature: "dG9vbC1zaWduYXR1cmU=",
    });
    expect(assistantMessages).toEqual(
      expect.arrayContaining([expect.objectContaining(source)]),
    );
  });

  it("falls visible reasoning back to content for an unknown API", () => {
    const source = { provider: "future", api: "future-api", model: "future-model" };
    const result = prepare(model(source.api, source.provider, source.model), reasoningHistory({ source }));

    expect(result.context.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "visible summary",
    });
  });
});
