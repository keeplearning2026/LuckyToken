import type {
  PreparedHttpResponse,
  ResponsesResponseObject,
} from "./response.js";

/**
 * Render a complete Responses response object as the canonical atomic SSE
 * sequence:
 *
 *   response.created          (status "in_progress", output [])
 *   response.output_item.done (one per output item, ordered)
 *   response.completed | response.incomplete | response.failed (status match)
 *   data: [DONE]
 *
 * Every schema event carries a monotonically increasing `sequence_number`
 * starting at 0. The terminal type is derived from the Response object's
 * `status` field — never from a string — and matches it exactly:
 *
 * - completed  → response.completed   with error/incomplete_details null
 * - incomplete → response.incomplete  with legal details, error null
 * - failed     → response.failed      with a non-null error
 *
 * `[DONE]` is a compatibility terminator, never a substitute for the semantic
 * terminal event.
 */
export function renderResponsesSse(
  response: ResponsesResponseObject,
): PreparedHttpResponse {
  const frames: string[] = [];
  let sequence = 0;
  frames.push(
    `data: ${JSON.stringify({
      type: "response.created",
      sequence_number: sequence,
      response: { ...response, status: "in_progress", output: [] },
    })}\n\n`,
  );
  sequence += 1;
  response.output.forEach((item, outputIndex) => {
    frames.push(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        sequence_number: sequence,
        output_index: outputIndex,
        item,
      })}\n\n`,
    );
    sequence += 1;
  });
  const terminalType =
    response.status === "completed"
      ? "response.completed"
      : response.status === "incomplete"
        ? "response.incomplete"
        : "response.failed";
  frames.push(
    `data: ${JSON.stringify({
      type: terminalType,
      sequence_number: sequence,
      response: { ...response },
    })}\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  return {
    status: 200,
    contentType: "text/event-stream",
    body: new TextEncoder().encode(frames.join("")),
  };
}
