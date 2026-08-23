import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";

class FinalPayloadCaptured extends Error {
  constructor() {
    super("final Pi payload captured");
    this.name = "FinalPayloadCaptured";
  }
}

export async function captureFinalPiPayload(
  start: (
    onPayload: (payload: unknown) => never,
  ) => AssistantMessageEventStream,
): Promise<unknown> {
  let captured: unknown;
  let terminalError: unknown;
  const stream = start((payload) => {
    captured = structuredClone(payload);
    throw new FinalPayloadCaptured();
  });
  for await (const event of stream) {
    if (event.type === "error") terminalError = event.error;
    // The public Pi stream converts the sentinel into its terminal error
    // event. Consuming the stream is required to trigger payload creation.
  }
  if (captured === undefined) {
    const detail =
      typeof terminalError === "object" && terminalError !== null
        ? JSON.stringify(terminalError)
        : String(terminalError ?? "unknown error");
    throw new Error(`Pi adapter ended before invoking onPayload: ${detail}`);
  }
  return captured;
}
