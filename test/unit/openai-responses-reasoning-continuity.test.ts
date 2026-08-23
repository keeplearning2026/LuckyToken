import { describe, expect, it } from "vitest";

import {
  decodeResponsesContinuity,
  encodeResponsesContinuity,
} from "../../src/protocols/openai-responses/reasoning-continuity.js";

describe("OpenAI Responses reasoning continuity codec", () => {
  it("round-trips an item-local thinking signature with source provenance", () => {
    const source = {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
    } as const;
    const attachment = {
      source,
      target: "thinking",
      kind: "opaque-signature",
      value: "opaque-thinking-signature",
    } as const;

    const envelope = encodeResponsesContinuity({
      source,
      attachments: [attachment],
    });
    const decoded = decodeResponsesContinuity(
      {
        type: "reasoning",
        luckytoken_continuity: envelope,
      },
      { type: "reasoning" },
    );

    expect(envelope).toEqual({
      version: 1,
      source,
      attachments: [
        {
          target: "thinking",
          kind: "opaque-signature",
          value: "opaque-thinking-signature",
        },
      ],
    });
    expect(decoded).toEqual({ source, attachments: [attachment], notices: [] });
  });

  it("round-trips the redacted representation only on an opaque thinking attachment", () => {
    const source = {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
    } as const;
    const attachment = {
      source,
      target: "thinking",
      kind: "opaque-signature",
      value: "opaque-redacted-data",
      representation: "redacted",
    } as const;
    const envelope = encodeResponsesContinuity({ source, attachments: [attachment] });

    expect(envelope?.attachments).toEqual([
      {
        target: "thinking",
        kind: "opaque-signature",
        value: "opaque-redacted-data",
        representation: "redacted",
      },
    ]);
    expect(
      decodeResponsesContinuity(
        { type: "reasoning", luckytoken_continuity: envelope },
        { type: "reasoning" },
      ),
    ).toEqual({ source, attachments: [attachment], notices: [] });
  });

  it("rejects a redacted marker on a reconstructable field selector", () => {
    const decoded = decodeResponsesContinuity(
      {
        type: "reasoning",
        luckytoken_continuity: {
          version: 1,
          source: {
            provider: "provider-test",
            api: "openai-completions",
            model: "model-test",
          },
          attachments: [
            {
              target: "thinking",
              kind: "reasoning-field-selector",
              value: "reasoning_content",
              representation: "redacted",
            },
          ],
        },
      },
      { type: "reasoning" },
    );

    expect(decoded.attachments).toEqual([]);
    expect(decoded.notices.map((notice) => notice.code)).toEqual([
      "openai-responses_continuity_attachment_invalid",
    ]);
  });

  it("round-trips a text signature only at its owning content part", () => {
    const source = {
      provider: "google",
      api: "google-generative-ai",
      model: "gemini-test",
    } as const;
    const attachment = {
      source,
      target: "text",
      partIndex: 1,
      kind: "opaque-signature",
      value: "thought-signature",
    } as const;
    const envelope = encodeResponsesContinuity({
      source,
      attachments: [attachment],
    });

    expect(
      decodeResponsesContinuity(
        { luckytoken_continuity: envelope },
        { type: "message", contentPartCount: 2 },
      ),
    ).toEqual({ source, attachments: [attachment], notices: [] });
  });

  it("round-trips a tool-call signature only at its owning call id", () => {
    const source = {
      provider: "google-vertex",
      api: "google-vertex",
      model: "gemini-test",
    } as const;
    const attachment = {
      source,
      target: "toolCall",
      callId: "call_1",
      kind: "opaque-signature",
      value: "tool-thought-signature",
    } as const;
    const envelope = encodeResponsesContinuity({
      source,
      attachments: [attachment],
    });

    expect(
      decodeResponsesContinuity(
        { luckytoken_continuity: envelope },
        { type: "toolCall", callId: "call_1" },
      ),
    ).toEqual({ source, attachments: [attachment], notices: [] });
  });

  it("round-trips source provenance without inventing an opaque attachment", () => {
    const source = {
      provider: "openai",
      api: "openai-responses",
      model: "gpt-test",
    } as const;
    const envelope = encodeResponsesContinuity({ source, attachments: [] });

    expect(envelope).toEqual({ version: 1, source, attachments: [] });
    expect(
      decodeResponsesContinuity(
        { type: "reasoning", luckytoken_continuity: envelope },
        { type: "reasoning" },
      ),
    ).toEqual({ source, attachments: [], notices: [] });
  });

  it("ignores a misplaced attachment with a bounded conversion notice", () => {
    const decoded = decodeResponsesContinuity(
      {
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
              partIndex: 4,
              kind: "opaque-signature",
              value: "signature",
            },
          ],
        },
      },
      { type: "message", contentPartCount: 1 },
    );

    expect(decoded.attachments).toEqual([]);
    expect(decoded.notices.map((notice) => notice.code)).toEqual([
      "openai-responses_continuity_attachment_invalid",
    ]);
  });

  it("rejects unknown versions and extension keys without affecting visible content", () => {
    const source = {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
    };
    const attachment = {
      target: "thinking",
      kind: "opaque-signature",
      value: "signature",
    };
    const unknownVersion = decodeResponsesContinuity(
      {
        luckytoken_continuity: {
          version: 2,
          source,
          attachments: [attachment],
        },
      },
      { type: "reasoning" },
    );
    const extraKey = decodeResponsesContinuity(
      {
        luckytoken_continuity: {
          version: 1,
          source,
          attachments: [attachment],
          raw_provider_body: {},
        },
      },
      { type: "reasoning" },
    );

    expect(unknownVersion.attachments).toEqual([]);
    expect(extraKey.attachments).toEqual([]);
    expect(unknownVersion.notices.map((notice) => notice.code)).toEqual([
      "openai-responses_continuity_envelope_invalid",
    ]);
    expect(extraKey.notices.map((notice) => notice.code)).toEqual([
      "openai-responses_continuity_envelope_invalid",
    ]);
  });

  it("rejects every attachment that competes for the same semantic target", () => {
    const decoded = decodeResponsesContinuity(
      {
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
              value: "first",
            },
            {
              target: "thinking",
              kind: "opaque-signature",
              value: "second",
            },
          ],
        },
      },
      { type: "reasoning" },
    );

    expect(decoded.attachments).toEqual([]);
    expect(decoded.notices.map((notice) => notice.code)).toEqual([
      "openai-responses_continuity_attachment_duplicate",
      "openai-responses_continuity_attachment_duplicate",
    ]);
  });
});
