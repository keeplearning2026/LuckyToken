import { describe, expect, it } from "vitest";

import { redactRequestArtifact } from "../../src/diagnostics/artifact-redaction.js";

function redact(mediaType: string, text: string) {
  return redactRequestArtifact({
    artifactKind: "fixture",
    mediaType,
    bytes: new TextEncoder().encode(text),
    originalBytes: Buffer.byteLength(text),
    sourceTruncated: false,
  });
}

describe("full-document artifact redaction", () => {
  it("redacts every JSONL record", () => {
    const result = redact(
      "application/x-ndjson",
      '{"value":1,"api_key":"line-secret"}\n{"authorization":"Bearer line-secret","safe":true}\n',
    );
    expect(result.kind).toBe("sanitized");
    if (result.kind !== "sanitized") return;
    const text = new TextDecoder().decode(result.bytes);
    expect(text).toContain('"value":1');
    expect(text).toContain('"safe":true');
    expect(text).not.toContain("line-secret");
    expect(result.redaction).toBe("applied");
  });

  it("redacts framed SSE JSON payloads and preserves the terminal marker", () => {
    const result = redact(
      "text/event-stream; charset=utf-8",
      'event: response.output_text.delta\ndata: {"delta":"safe","token":"sse-secret"}\n\ndata: [DONE]\n\n',
    );
    expect(result.kind).toBe("sanitized");
    if (result.kind !== "sanitized") return;
    const text = new TextDecoder().decode(result.bytes);
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('data: {"delta":"safe","token":"[REDACTED]"}');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("sse-secret");
  });

  it("fails closed for an SSE data payload that is neither JSON nor [DONE]", () => {
    expect(redact("text/event-stream", "data: unclassified plaintext\n\n"))
      .toMatchObject({
        kind: "unavailable",
        redaction: "failed",
        reason: "redaction_invalid_json",
      });
  });
});
