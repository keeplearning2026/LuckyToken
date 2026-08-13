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

describe("14: Responses text, images, files, and reasoning continuity", () => {
  describe("textual content maps exactly", () => {
    it("maps input_text parts exactly into Pi text content", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "exact text" },
                { type: "input_text", text: " second part" },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [
          { type: "text", text: "exact text" },
          { type: "text", text: " second part" },
        ],
      });
    });

    it("maps output_text in a historical assistant message exactly", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "hi" },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "historical answer" }],
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
        { type: "text", text: "historical answer" },
      ]);
    });

    it("maps a message string exactly", () => {
      const invocation = convertResponsesRequest(
        { model: "m", input: "raw string input" },
        1,
        policy(),
      );
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "raw string input" }],
      });
    });

    it("preserves refusal visible text as deterministic textual degradation", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "ask" },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "refusal", refusal: "I cannot do that" }],
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
        { type: "text", text: "I cannot do that" },
      ]);
    });
  });

  describe("message phase is stored in a versioned Responses-owned text signature", () => {
    it("preserves phase in a versioned textSignature envelope, not in model text", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "hi" },
            {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "the answer" }],
            },
          ],
        },
        1,
        policy(),
      );
      const assistant = invocation.context.messages.find(
        (m) => m.role === "assistant",
      );
      const block = (assistant?.content as Array<{
        text: string;
        textSignature?: string;
      }>)[0];
      expect(block?.text).toBe("the answer");
      expect(block?.textSignature).toBeDefined();
      const envelope = JSON.parse(String(block?.textSignature)) as Record<
        string,
        unknown
      >;
      expect(envelope.v).toBe(1);
      expect(envelope.id).toBe("openai-responses");
      expect(envelope.phase).toBe("final_answer");
    });

    it("keeps commentary phase with the same versioned envelope", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "hi" },
            {
              type: "message",
              role: "assistant",
              phase: "commentary",
              content: [{ type: "output_text", text: "interim" }],
            },
          ],
        },
        1,
        policy(),
      );
      const assistant = invocation.context.messages.find(
        (m) => m.role === "assistant",
      );
      const block = (assistant?.content as Array<{
        text: string;
        textSignature?: string;
      }>)[0];
      const envelope = JSON.parse(String(block?.textSignature)) as Record<
        string,
        unknown
      >;
      expect(envelope.phase).toBe("commentary");
      expect(envelope.v).toBe(1);
    });

    it("does not inject phase text into the model-visible text", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "hi" },
            {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "clean answer" }],
            },
          ],
        },
        1,
        policy(),
      );
      const assistant = invocation.context.messages.find(
        (m) => m.role === "assistant",
      );
      const block = (assistant?.content as Array<{
        text: string;
        textSignature?: string;
      }>)[0];
      expect(block?.text).not.toContain("final_answer");
      expect(block?.text).not.toContain("phase");
    });
  });

  describe("base64 data images", () => {
    const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    it("maps a valid base64 data image exactly to bytes and MIME", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: `data:image/png;base64,${PNG_DATA}`,
                },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: PNG_DATA }],
      });
    });

    it("maps an image/jpeg data URL with its own MIME", () => {
      const jpegData = "/9j/4AAQSkZJRg==";
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: `data:image/jpeg;base64,${jpegData}`,
                },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "image", mimeType: "image/jpeg", data: jpegData }],
      });
    });

    it("errors on malformed base64 in a data URL", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_image",
                    image_url: "data:image/png;base64,!!!not-base64!!!",
                  },
                ],
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/base64/i);
    });

    it("errors on a data URL with no MIME type", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_image", image_url: "data:;base64,AAAA" },
                ],
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/MIME|mime|image/i);
    });
  });

  describe("file_id and remote image URLs require a trusted resolver", () => {
    it("errors on input_image.file_id without a resolver", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_image", file_id: "file_123" }],
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/resolver/i);
    });

    it("errors on a remote image_url without a resolver", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_image",
                    image_url: "https://example.com/image.png",
                  },
                ],
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/resolver/i);
    });

    it("resolves file_id through the async resolver into Pi image bytes", async () => {
      const { convertResponsesRequestAsync } = await import(
        "../../src/protocols/openai-responses/request.js"
      );
      const invocation = await convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_image", file_id: "file_owned_1" }],
            },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async (reference, context) => {
            expect(reference.type).toBe("input_image");
            expect(reference.file_id).toBe("file_owned_1");
            expect(context.authority).toBe("openai-responses");
            return [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_image",
                    image_url:
                      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                  },
                ],
              },
            ];
          },
        },
      );
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "image", mimeType: "image/png" }],
      });
    });

    it("resolves a remote image URL through the async resolver into Pi image bytes", async () => {
      const { convertResponsesRequestAsync } = await import(
        "../../src/protocols/openai-responses/request.js"
      );
      const invocation = await convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_image", image_url: "https://cdn.test/a.png" },
              ],
            },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async (reference) => {
            expect(reference.image_url).toBe("https://cdn.test/a.png");
            return [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_image",
                    image_url:
                      "data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAAfQ//+v",
                  },
                ],
              },
            ];
          },
        },
      );
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "image", mimeType: "image/webp" }],
      });
    });

    it("reports an unresolvable image file_id as a notice, never a fabricated placeholder", async () => {
      const { convertResponsesRequestAsync } = await import(
        "../../src/protocols/openai-responses/request.js"
      );
      const invocation = await convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_image", file_id: "file_fail" }],
            },
            { type: "message", role: "user", content: "keep me" },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async () => {
            throw new Error("image resolver failed");
          },
        },
      );
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_reference_unresolved",
        ),
      ).toBe(true);
      const texts = invocation.context.messages
        .filter((m) => m.role === "user")
        .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
      expect(texts).toEqual(["keep me"]);
    });

    it("passes abort signal and limits to image resolution", async () => {
      const { convertResponsesRequestAsync } = await import(
        "../../src/protocols/openai-responses/request.js"
      );
      const controller = new AbortController();
      let received: { signal: AbortSignal | undefined; limits?: unknown } = {
        signal: undefined,
      };
      await convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_image", file_id: "file_abort" }],
            },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async (_reference, context) => {
            received = { signal: context.signal, limits: context.limits };
            return [];
          },
        },
        controller.signal,
        { maxBytes: 4096, maxRedirects: 1 },
      );
      expect(received.signal).toBe(controller.signal);
      expect(received.limits).toMatchObject({ maxBytes: 4096, maxRedirects: 1 });
    });

    it("drops an image-only message when the resolver returns no usable image", async () => {
      const { convertResponsesRequestAsync } = await import(
        "../../src/protocols/openai-responses/request.js"
      );
      const invocation = await convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_image", file_id: "file_unusable" }],
            },
            { type: "message", role: "user", content: "keep me" },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async () => [],
        },
      );
      expect(invocation.context.messages).toHaveLength(1);
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "keep me" }],
      });
    });

    it("keeps text content when only the image part fails to resolve", async () => {
      const { convertResponsesRequestAsync } = await import(
        "../../src/protocols/openai-responses/request.js"
      );
      const invocation = await convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "describe this" },
                { type: "input_image", file_id: "file_partial" },
              ],
            },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async () => {
            throw new Error("fail");
          },
        },
      );
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "describe this" }],
      });
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_reference_unresolved",
        ),
      ).toBe(true);
    });

    it("enforces image MIME/size limits through the resolver limits contract", async () => {
      const { convertResponsesRequestAsync } = await import(
        "../../src/protocols/openai-responses/request.js"
      );
      let receivedLimits: unknown;
      await convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_image", image_url: "https://cdn.test/big.png" },
              ],
            },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async (_reference, context) => {
            receivedLimits = context.limits;
            return [];
          },
        },
        undefined,
        { maxBytes: 100, maxMimeTypes: ["image/png"], maxRedirects: 2 },
      );
      expect(receivedLimits).toMatchObject({
        maxBytes: 100,
        maxMimeTypes: ["image/png"],
        maxRedirects: 2,
      });
    });
  });

  describe("generic non-image input_file", () => {
    it("drops a generic input_file and records a notice without fabricating a marker", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_file", file_id: "file_1" }],
            },
            { type: "message", role: "user", content: "after" },
          ],
        },
        1,
        policy(),
      );
      const userTexts = invocation.context.messages
        .filter((m) => m.role === "user")
        .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
      expect(userTexts).toEqual(["after"]);
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_input_file_dropped",
        ),
      ).toBe(true);
      expect(invocation.context.messages).not.toContainEqual(
        expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: "image" })]) }),
      );
    });
  });

  describe("reasoning continuity", () => {
    it("maps readable reasoning to Pi ThinkingContent", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "step by step" }],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "answer" }],
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
        { type: "thinking", thinking: "step by step" },
        { type: "text", text: "answer" },
      ]);
    });

    it("stores Responses-native continuity state in a versioned provenance-bearing thinkingSignature", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              id: "rs_cont_1",
              encrypted_content: "opaque-responses-state",
              summary: [{ type: "summary_text", text: "visible" }],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "answer" }],
            },
          ],
        },
        1,
        policy(),
      );
      const assistant = invocation.context.messages.find(
        (m) => m.role === "assistant",
      );
      const thinking = (
        assistant?.content as Array<{
          type: string;
          thinking?: string;
          thinkingSignature?: string;
        }>
      ).find((b) => b.type === "thinking");
      expect(thinking?.thinking).toBe("visible");
      expect(thinking?.thinkingSignature).toBeDefined();
      const envelope = JSON.parse(
        String(thinking?.thinkingSignature),
      ) as Record<string, unknown>;
      expect(envelope.v).toBe(1);
      expect(envelope.id).toBe("openai-responses");
      expect(envelope.authority).toBe("openai-responses");
      expect(envelope.encrypted_content).toBe("opaque-responses-state");
      expect(envelope.item_id).toBe("rs_cont_1");
    });

    it("preserves a reasoning-only assistant message without disappearing", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "think only" },
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "trailing thoughts" }],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.messages).toHaveLength(2);
      const assistant = invocation.context.messages[1];
      expect(assistant?.role).toBe("assistant");
      expect(assistant?.content).toEqual([
        { type: "thinking", thinking: "trailing thoughts" },
      ]);
    });

    it("keeps trailing reasoning attached to the last assistant message", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "u" },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "answer" }],
            },
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "after thought" }],
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
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "after thought" },
      ]);
    });

    it("never restores encrypted_content from a foreign arbitrary signature", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "u" },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "answer" }],
            },
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "more" }],
            },
          ],
        },
        1,
        policy(),
      );
      const assistant = invocation.context.messages.find(
        (m) => m.role === "assistant",
      );
      const thinking = (
        assistant?.content as Array<{
          type: string;
          thinkingSignature?: string;
        }>
      ).find((b) => b.type === "thinking");
      // No foreign signature exists here, so no envelope is fabricated.
      expect(thinking?.thinkingSignature).toBeUndefined();
    });

    it("keeps a thinkingSignature only when the item carries encrypted_content", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "plain reasoning" }],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "answer" }],
            },
          ],
        },
        1,
        policy(),
      );
      const assistant = invocation.context.messages.find(
        (m) => m.role === "assistant",
      );
      const thinking = (
        assistant?.content as Array<{
          type: string;
          thinkingSignature?: string;
        }>
      ).find((b) => b.type === "thinking");
      expect(thinking?.thinkingSignature).toBeUndefined();
    });

    it("does not carry continuity state across separate requests", () => {
      const first = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              id: "rs_a",
              encrypted_content: "state-a",
              summary: [{ type: "summary_text", text: "a" }],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "answer a" }],
            },
          ],
        },
        1,
        policy(),
      );
      const second = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              id: "rs_b",
              encrypted_content: "state-b",
              summary: [{ type: "summary_text", text: "b" }],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "answer b" }],
            },
          ],
        },
        2,
        policy(),
      );
      const firstThinking = (
        first.context.messages[0]?.content as Array<{
          thinkingSignature?: string;
        }>
      ).find((b) => b.thinkingSignature !== undefined);
      const secondThinking = (
        second.context.messages[0]?.content as Array<{
          thinkingSignature?: string;
        }>
      ).find((b) => b.thinkingSignature !== undefined);
      expect(JSON.parse(String(firstThinking?.thinkingSignature))).toMatchObject(
        { item_id: "rs_a", encrypted_content: "state-a" },
      );
      expect(JSON.parse(String(secondThinking?.thinkingSignature))).toMatchObject(
        { item_id: "rs_b", encrypted_content: "state-b" },
      );
      // No shared mutable state leaks between invocations.
      expect(first.context.messages).not.toContain("state-b");
    });

    it("preserves reasoning-only history across multiple assistant turns", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            { role: "user", content: "u1" },
            { type: "reasoning", summary: [{ type: "summary_text", text: "t1" }] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "a1" }],
            },
            { role: "user", content: "u2" },
            { type: "reasoning", summary: [{ type: "summary_text", text: "t2" }] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "a2" }],
            },
          ],
        },
        1,
        policy(),
      );
      const assistants = invocation.context.messages.filter(
        (m) => m.role === "assistant",
      );
      expect(assistants).toHaveLength(2);
      expect(assistants[0]?.content).toEqual([
        { type: "thinking", thinking: "t1" },
        { type: "text", text: "a1" },
      ]);
      expect(assistants[1]?.content).toEqual([
        { type: "thinking", thinking: "t2" },
        { type: "text", text: "a2" },
      ]);
    });
  });

  describe("status handling", () => {
    it("converts absent and completed statuses normally", () => {
      const absent = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "a" }],
            },
          ],
        },
        1,
        policy(),
      );
      expect(absent.context.messages).toHaveLength(1);
      const completed = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "a" }],
            },
          ],
        },
        1,
        policy(),
      );
      expect(completed.context.messages).toHaveLength(1);
    });

    it("errors on an in_progress message", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "message",
                role: "assistant",
                status: "in_progress",
                content: [{ type: "output_text", text: "partial" }],
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/in_progress/);
    });

    it("preserves representable content of an incomplete message with a diagnostic", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "assistant",
              status: "incomplete",
              content: [{ type: "output_text", text: "partial answer" }],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.messages).toHaveLength(1);
      const assistant = invocation.context.messages[0];
      expect(assistant?.role).toBe("assistant");
      expect((assistant?.content as Array<{ text: string }>)[0]?.text).toBe(
        "partial answer",
      );
    });

    it("does not inject notice text or guess length for an incomplete message", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "assistant",
              status: "incomplete",
              content: [{ type: "output_text", text: "partial" }],
            },
          ],
        },
        1,
        policy(),
      );
      const texts = JSON.stringify(invocation.context.messages);
      expect(texts).not.toContain("incomplete");
      expect(texts).not.toContain("length");
      expect(texts).not.toContain("notice");
      // Notices are conversion notices, not model-visible text.
      expect(invocation.notices).toHaveLength(0);
    });
  });
});
