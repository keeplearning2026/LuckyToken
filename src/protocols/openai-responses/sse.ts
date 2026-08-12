import type {
  PreparedHttpResponse,
  ResponsesResponseObject,
} from "./response.js";

/**
 * Render a Responses response object as the canonical atomic SSE sequence
 * Codex commits:
 *
 *   response.created          (status "in_progress", output [])
 *   response.output_item.done (one per output item)
 *   response.completed        (full response object)
 *   data: [DONE]
 */
export function renderResponsesSse(
  response: ResponsesResponseObject,
): PreparedHttpResponse {
  const frames: string[] = [];
  frames.push(
    `data: ${JSON.stringify({
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    })}\n\n`,
  );
  response.output.forEach((item, outputIndex) => {
    frames.push(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      })}\n\n`,
    );
  });
  frames.push(`data: ${JSON.stringify({
    type: "response.completed",
    response: { ...response },
  })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return {
    status: 200,
    contentType: "text/event-stream",
    body: new TextEncoder().encode(frames.join("")),
  };
}
