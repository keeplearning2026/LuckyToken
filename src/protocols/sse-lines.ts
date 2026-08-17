/**
 * Shared bounded SSE framing for buffered passthrough response projection
 * (Ticket 15 repair).
 *
 * WHATWG SSE line framing accepts `\r`, `\n` and `\r\n` terminators and an
 * optional leading UTF-8 BOM; a naive `split("\n")` lets `\r`-only streams
 * and BOM-prefixed streams bypass event recognition. This module parses an
 * already-buffered body into order-preserving frames and renders them back
 * canonically. Non-data fields (event:, id:, retry:, comments, unknown
 * fields) keep their original text and order; `data:` lines keep their
 * payloads. Blank lines separate frames. Only the projector's JSON/model
 * policy decides pass-through versus failure; framing itself is permissive
 * exactly like the WHATWG parser.
 */

export type SseFrameLine =
  | { readonly kind: "field"; readonly text: string }
  | { readonly kind: "data"; readonly payload: string };

export interface SseFrame {
  /** Original non-blank lines in order; data payloads carry no prefix. */
  readonly lines: readonly SseFrameLine[];
}

export function parseSseFrames(text: string): readonly SseFrame[] {
  // TextDecoder already strips a leading UTF-8 BOM; strip defensively so a
  // preserved U+FEFF can never hide the first line from recognition.
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (index < withoutBom.length) {
    const ch = withoutBom[index];
    if (ch === "\r") {
      lines.push(withoutBom.slice(start, index));
      index += withoutBom[index + 1] === "\n" ? 2 : 1;
      start = index;
    } else if (ch === "\n") {
      lines.push(withoutBom.slice(start, index));
      index += 1;
      start = index;
    } else {
      index += 1;
    }
  }
  if (start < withoutBom.length) lines.push(withoutBom.slice(start));

  const frames: SseFrame[] = [];
  let current: SseFrameLine[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    frames.push(Object.freeze({ lines: Object.freeze(current) }));
    current = [];
  };
  for (const line of lines) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line === "data" || line.startsWith("data:")) {
      // WHATWG: one optional leading space after "data:" is stripped.
      current.push({ kind: "data", payload: line.slice(5).replace(/^ /u, "") });
      continue;
    }
    current.push({ kind: "field", text: line });
  }
  flush();
  return Object.freeze(frames);
}

/** Render one frame canonically: fields verbatim, data as `data: payload`,
 *  one blank line after the frame. */
export function renderSseFrame(frame: SseFrame): string {
  if (frame.lines.length === 0) return "\n";
  const rendered = frame.lines
    .map((line) =>
      line.kind === "data" ? `data: ${line.payload}` : line.text,
    )
    .join("\n");
  return `${rendered}\n\n`;
}

/** The joined JSON payload of one frame ("" when the frame has no data). */
export function sseFramePayload(frame: SseFrame): string {
  return frame.lines
    .filter((line): line is Extract<SseFrameLine, { kind: "data" }> => line.kind === "data")
    .map((line) => line.payload)
    .join("\n");
}
