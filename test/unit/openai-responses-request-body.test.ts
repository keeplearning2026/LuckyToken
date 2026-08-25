import {
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  ResponsesRequestBodyTooLargeError,
  UnsupportedResponsesContentEncodingError,
  readResponsesRequestBody,
} from "../../src/protocols/openai-responses/request-body.js";

function request(body: Uint8Array | string, encoding?: string): Request {
  return new Request("http://Token.test/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(encoding === undefined ? {} : { "content-encoding": encoding }),
    },
    body: body as BodyInit,
  });
}

describe("OpenAI Responses bounded request body", () => {
  const json = JSON.stringify({ model: "gpt-native", input: "hello" });
  const bytes = Buffer.from(json, "utf8");

  it.each([
    ["identity", bytes],
    ["zstd", zstdCompressSync(bytes)],
    ["gzip", gzipSync(bytes)],
    ["deflate", deflateSync(bytes)],
  ])("decodes %s without changing the JSON text", async (encoding, encoded) => {
    const result = await readResponsesRequestBody(
      request(encoded, encoding === "identity" ? undefined : encoding),
      1024 * 1024,
    );
    expect(result.text).toBe(json);
    expect(result.json).toEqual({ model: "gpt-native", input: "hello" });
  });

  it("rejects unsupported and multi-valued content encodings instead of guessing", async () => {
    await expect(
      readResponsesRequestBody(request(bytes, "br"), 1024),
    ).rejects.toBeInstanceOf(UnsupportedResponsesContentEncodingError);
    await expect(
      readResponsesRequestBody(request(bytes, "zstd, gzip"), 1024),
    ).rejects.toBeInstanceOf(UnsupportedResponsesContentEncodingError);
  });

  it("bounds both the transport bytes and decompressed bytes", async () => {
    await expect(
      readResponsesRequestBody(request(bytes), 8),
    ).rejects.toBeInstanceOf(ResponsesRequestBodyTooLargeError);

    const compressed = zstdCompressSync(Buffer.from("x".repeat(4096)));
    await expect(
      readResponsesRequestBody(request(compressed, "zstd"), 512),
    ).rejects.toBeInstanceOf(ResponsesRequestBodyTooLargeError);
  });
});
