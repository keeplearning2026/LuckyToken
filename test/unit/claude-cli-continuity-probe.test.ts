import { describe, expect, it } from "vitest";

import { injectClaudeContinuityProbe } from "../online/run-claude-cli.js";

describe("Claude CLI continuity capability probe", () => {
  it("injects one item-local extension into an Anthropic SSE text block", async () => {
    const source = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":"answer"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const projected = await injectClaudeContinuityProbe(
      new Response(source, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "content-length": String(source.length),
        },
      }),
      "MARKER",
    );
    const body = await projected.text();

    expect(projected.headers.has("content-length")).toBe(false);
    expect(body).toContain('"type":"thinking","thinking":"","signature":""');
    expect(body).toContain('"luckytoken_continuity"');
    expect(body).toContain('"target":"text"');
    expect(body).toContain('"value":"CLAUDE_CONTINUITY_MARKER"');
    expect(body.match(/luckytoken_continuity/gu)).toHaveLength(1);
  });

  it("fails diagnostically when the response has no attachable text block", async () => {
    await expect(
      injectClaudeContinuityProbe(
        new Response(
          'data: {"type":"content_block_start","content_block":{"type":"thinking","thinking":""}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
        "MARKER",
      ),
    ).rejects.toThrow(/no_text_block/iu);
  });
});
