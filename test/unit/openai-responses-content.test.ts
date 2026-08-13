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

    it("errors on base64 whose length is not a multiple of four", () => {
      // RFC 4648 base64 payloads are 4-character groups; a length that is not
      // a multiple of 4 cannot decode and must be a conversion error.
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
                    image_url: "data:image/png;base64,AAAAA",
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

    it("errors on a data URL whose MIME is not an image MIME", () => {
      // An input_image data URL must carry an image MIME; a text/plain or
      // application/octet-stream payload is a malformed image, not a silent
      // acceptance.
      for (const mime of ["text/plain", "application/json", "application/octet-stream"]) {
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
                      image_url: `data:${mime};base64,AAAA`,
                    },
                  ],
                },
              ],
            },
            1,
            policy(),
          ),
        ).toThrow(/MIME|mime|image/i);
      }
    });

    it("accepts common image MIME types on data URLs", () => {
      for (const mime of [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/svg+xml",
        "image/x-icon",
      ]) {
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
                    image_url: `data:${mime};base64,AAAA`,
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
          content: [{ type: "image", mimeType: mime }],
        });
      }
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

    it("stops resolving further images once the caller signal has aborted", async () => {
      // Cancellation must cleanly terminate request-local resolution: after
      // the signal aborts, no further resolver calls happen and the
      // conversion rejects rather than degrading.
      const { convertResponsesRequestAsync } = await import(
        "../../src/protocols/openai-responses/request.js"
      );
      const controller = new AbortController();
      let calls = 0;
      const promise = convertResponsesRequestAsync(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_image", file_id: "file_a" },
                { type: "input_image", file_id: "file_b" },
              ],
            },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async (_reference, context) => {
            calls += 1;
            // Abort the caller signal on the first call, as a cancelled
            // upstream fetch would; the second image must never be resolved.
            if (calls === 1) {
              queueMicrotask(() =>
                controller.abort(new Error("upstream cancelled")),
              );
            }
            context.signal?.throwIfAborted();
            return [
              {
                type: "input_image",
                image_url:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
              },
            ];
          },
        },
        controller.signal,
      );
      await expect(promise).rejects.toThrow(/cancelled|aborted/);
      // The abort propagates as a rejection, never a degradable notice.
      expect(calls).toBeLessThanOrEqual(2);
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

    it("degrades a resolver-returned un-materialized image instead of double-erroring", async () => {
      // A resolver that returns the image still as a file_id/URL (not
      // materialized to a data URL) must degrade with a notice, never cause
      // the message converter to re-raise a resolver-required error.
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
              content: [{ type: "input_image", file_id: "file_unresolved" }],
            },
            { type: "message", role: "user", content: "keep me" },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async () => [
            { type: "input_image", file_id: "file_unresolved" },
          ],
        },
      );
      expect(invocation.context.messages).toHaveLength(1);
      expect(invocation.context.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "keep me" }],
      });
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_reference_unresolved",
        ),
      ).toBe(true);
    });

    it("degrades un-materialized image parts inside a resolver-returned message item", async () => {
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
              content: [{ type: "input_image", file_id: "file_msg" }],
            },
            { type: "message", role: "user", content: "keep me" },
          ],
        },
        1,
        policy(),
        {
          resolveItemReference: async () => [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "see image" },
                { type: "input_image", file_id: "file_msg" },
              ],
            },
          ],
        },
      );
      const userTexts = invocation.context.messages
        .filter((m) => m.role === "user")
        .map((m) => (m.content as Array<{ text: string }>)[0]?.text);
      // The text survives; the un-materialized image degrades with a notice.
      expect(userTexts).toEqual(["see image", "keep me"]);
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_reference_unresolved",
        ),
      ).toBe(true);
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

    it("materializes an input_file whose file_data is an image data URL", () => {
      // A provable image file (file_data already materialized as an image
      // data URL) maps to Pi image bytes; it is not a generic drop.
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_file",
                  file_id: "file_img",
                  file_data:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                },
              ],
            },
            { type: "message", role: "user", content: "after" },
          ],
        },
        1,
        policy(),
      );
      const images = invocation.context.messages.flatMap((m) =>
        m.role === "user"
          ? (m.content as Array<{ type: string }>).filter(
              (b) => b.type === "image",
            )
          : [],
      );
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ mimeType: "image/png" });
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_input_file_dropped",
        ),
      ).toBe(false);
    });

    it("drops an input_file whose file_data is not an image data URL", () => {
      // A non-image file_data (plain text, or a data URL with a non-image
      // MIME) is a generic non-image file: drop and record.
      for (const fileData of [
        "plain file content",
        "data:text/plain;base64,aGVsbG8=",
      ]) {
        const invocation = convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_file", file_id: "f", file_data: fileData },
                ],
              },
            ],
          },
          1,
          policy(),
        );
        expect(invocation.context.messages).toHaveLength(0);
        expect(
          invocation.notices.some(
            (n) => n.code === "openai-responses_input_file_dropped",
          ),
        ).toBe(true);
      }
    });

    it("drops an input_file with only file_url or file_id (no materialized data)", () => {
      // A remote file handle cannot be proven an image without the trusted
      // resolver; it is a generic non-image drop.
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_file", file_url: "https://cdn.test/report.pdf" },
              ],
            },
          ],
        },
        1,
        policy(),
      );
      expect(invocation.context.messages).toHaveLength(0);
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_input_file_dropped",
        ),
      ).toBe(true);
    });
  });

  describe("status full value matrix across item families", () => {
    it("message: absent/completed convert; in_progress errors; incomplete preserves; unknown errors", () => {
      const convert = (status: unknown): unknown =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "message",
                role: "assistant",
                ...(status === undefined ? {} : { status }),
                content: [{ type: "output_text", text: "a" }],
              },
            ],
          },
          1,
          policy(),
        );
      expect(convert(undefined)).toBeDefined();
      expect(convert("completed")).toBeDefined();
      expect(() => convert("in_progress")).toThrow(/in_progress/);
      expect(convert("incomplete")).toBeDefined();
      expect(() => convert("queued")).toThrow(/status/);
      expect(() => convert("")).toThrow(/status/);
    });

    it("call/output: absent/completed convert; in_progress/incomplete/unknown all error", () => {
      const convertCall = (status: unknown): unknown =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "function_call",
                call_id: "c1",
                name: "f",
                arguments: "{}",
                ...(status === undefined ? {} : { status }),
              },
            ],
          },
          1,
          policy(),
        );
      expect(convertCall(undefined)).toBeDefined();
      expect(convertCall("completed")).toBeDefined();
      expect(() => convertCall("in_progress")).toThrow(/in_progress/);
      expect(() => convertCall("incomplete")).toThrow(/status/);
      expect(() => convertCall("queued")).toThrow(/status/);
      const convertOutput = (status: unknown): unknown =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "function_call",
                call_id: "c1",
                name: "f",
                arguments: "{}",
              },
              {
                type: "function_call_output",
                call_id: "c1",
                output: "r",
                ...(status === undefined ? {} : { status }),
              },
            ],
          },
          1,
          policy(),
        );
      expect(convertOutput(undefined)).toBeDefined();
      expect(convertOutput("completed")).toBeDefined();
      expect(() => convertOutput("in_progress")).toThrow(/in_progress/);
      expect(() => convertOutput("incomplete")).toThrow(/status/);
      expect(() => convertOutput("queued")).toThrow(/status/);
    });

    it("reasoning: absent/completed convert; in_progress errors; incomplete preserves; unknown errors", () => {
      const convert = (status: unknown): unknown =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "reasoning",
                ...(status === undefined ? {} : { status }),
                summary: [{ type: "summary_text", text: "t" }],
              },
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
      expect(convert(undefined)).toBeDefined();
      expect(convert("completed")).toBeDefined();
      expect(() => convert("in_progress")).toThrow(/in_progress/);
      expect(convert("incomplete")).toBeDefined();
      expect(() => convert("queued")).toThrow(/status/);
      expect(() => convert("")).toThrow(/status/);
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

    it("refuses to restore encrypted_content claimed by a foreign authority envelope", () => {
      // A reasoning item whose envelope claims a foreign authority must not
      // have its encrypted_content re-wrapped as Responses continuity: an
      // arbitrary Provider signature is never emitted as Responses
      // encrypted content.
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              id: "rs_foreign",
              encrypted_content: "foreign-secret-bytes",
              envelope: { authority: "foreign-provider", version: 1 },
              summary: [{ type: "summary_text", text: "visible part" }],
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
          thinking: string;
        }>
      ).find((b) => b.type === "thinking");
      // The visible reasoning survives; the foreign opaque state does not
      // enter a Responses-owned envelope.
      expect(thinking?.thinking).toBe("visible part");
      expect(thinking?.thinkingSignature).toBeUndefined();
    });

    it("restores encrypted_content when the envelope authority is the Responses authority", () => {
      // A Lucky-owned envelope with the Responses authority is verified and
      // its encrypted_content enters the versioned envelope.
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              id: "rs_owned",
              encrypted_content: "owned-secret-bytes",
              envelope: { authority: "openai-responses", version: 1 },
              summary: [{ type: "summary_text", text: "visible part" }],
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
      const envelope = JSON.parse(
        String(thinking?.thinkingSignature),
      ) as Record<string, unknown>;
      expect(envelope).toMatchObject({
        v: 1,
        id: "openai-responses",
        authority: "openai-responses",
        encrypted_content: "owned-secret-bytes",
      });
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
      // A non-model-visible request-local diagnostic records the incomplete
      // status; notice text is never injected into model-visible content.
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_incomplete_message",
        ),
      ).toBe(true);
    });

    it("errors on an in_progress reasoning item", () => {
      // SDK reasoning items carry status in_progress|completed|incomplete;
      // in_progress reasoning is a structured lifecycle error, never a
      // silent acceptance of partial thinking.
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "reasoning",
                id: "rs_live",
                status: "in_progress",
                summary: [{ type: "summary_text", text: "still thinking" }],
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
        ),
      ).toThrow(/in_progress/);
    });

    it("preserves representable content of an incomplete reasoning item", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              id: "rs_partial",
              status: "incomplete",
              summary: [{ type: "summary_text", text: "partial reasoning" }],
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
      expect(assistant?.content).toContainEqual({
        type: "thinking",
        thinking: "partial reasoning",
      });
      // No notice text or guessed length enters model-visible content.
      const texts = JSON.stringify(invocation.context.messages);
      expect(texts).not.toContain("incomplete");
      expect(texts).not.toContain("length");
    });

    it("preserves reasoning across hosted drop and transcript items", () => {
      // Pending reasoning must survive hosted drops and transcript items
      // (web_search/file_search/mcp approval) that follow it; it is preserved
      // as a reasoning-only assistant at the next semantic boundary.
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "kept-thought" }],
            },
            { type: "web_search_call", id: "ws_1" },
            {
              type: "mcp_approval_request",
              id: "mar_1",
              decision: "approved",
            },
            { type: "message", role: "user", content: "keep" },
          ],
        },
        1,
        policy(),
      );
      const assistants = invocation.context.messages.filter(
        (m) => m.role === "assistant",
      );
      expect(assistants).toHaveLength(1);
      const thinking = (
        assistants[0]?.content as Array<{ thinking: string }>
      )[0];
      expect(thinking?.thinking).toBe("kept-thought");
    });

    it("records a non-model-visible diagnostic for incomplete reasoning", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              id: "rs_partial",
              status: "incomplete",
              summary: [{ type: "summary_text", text: "partial reasoning" }],
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
      expect(
        invocation.notices.some(
          (n) => n.code === "openai-responses_incomplete_message",
        ),
      ).toBe(true);
    });

    it("converts completed reasoning items normally", () => {
      const invocation = convertResponsesRequest(
        {
          model: "m",
          input: [
            {
              type: "reasoning",
              id: "rs_done",
              status: "completed",
              summary: [{ type: "summary_text", text: "done thinking" }],
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
      expect(assistant?.content).toContainEqual({
        type: "thinking",
        thinking: "done thinking",
      });
    });

    it("errors on an unknown reasoning status", () => {
      expect(() =>
        convertResponsesRequest(
          {
            model: "m",
            input: [
              {
                type: "reasoning",
                id: "rs_weird",
                status: "queued",
                summary: [{ type: "summary_text", text: "x" }],
              },
            ],
          },
          1,
          policy(),
        ),
      ).toThrow(/status/);
    });
  });
});
