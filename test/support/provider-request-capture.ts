import type {
  AssistantMessageEventStream,
  FetchFunction,
} from "@earendil-works/pi-ai";

class ProviderRequestCaptured extends Error {
  constructor() {
    super("Provider request captured");
    this.name = "ProviderRequestCaptured";
  }
}

export interface CapturedProviderRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export async function captureJsonProviderRequest(
  start: (fetch: FetchFunction) => AssistantMessageEventStream,
): Promise<CapturedProviderRequest> {
  let captured: CapturedProviderRequest | undefined;
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    captured = Object.freeze({
      method: request.method,
      url: request.url,
      body: JSON.parse(await request.clone().text()) as unknown,
    });
    throw new ProviderRequestCaptured();
  };
  const stream = start(fetch);
  for await (const event of stream) {
    // The Pi adapter converts the sentinel into a terminal error event.
    void event;
  }
  if (captured === undefined) {
    throw new Error("Pi adapter ended before dispatching a Provider request");
  }
  return captured;
}

export async function captureJsonGlobalProviderRequest(
  start: () => AssistantMessageEventStream,
): Promise<CapturedProviderRequest> {
  const originalFetch = globalThis.fetch;
  let captured: CapturedProviderRequest | undefined;
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    captured = Object.freeze({
      method: request.method,
      url: request.url,
      body: JSON.parse(await request.clone().text()) as unknown,
    });
    throw new ProviderRequestCaptured();
  };
  globalThis.fetch = fetch as typeof globalThis.fetch;
  try {
    const stream = start();
    for await (const event of stream) {
      // The Pi adapter converts the sentinel into a terminal error event.
      void event;
    }
  } finally {
    if (globalThis.fetch === fetch) globalThis.fetch = originalFetch;
  }
  if (captured === undefined) {
    throw new Error("Pi adapter ended before dispatching a Provider request");
  }
  return captured;
}
