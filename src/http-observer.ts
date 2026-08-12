import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * Raw body snapshot of a non-2xx HTTP response.
 *
 * "Raw" here means the response body bytes exposed by the Fetch API, not the
 * bytes on the wire before transfer/content decoding.
 */
export type HttpObservedBody = Uint8Array;

/**
 * Outcome of the latest observed HTTP attempt.
 *
 * A successful (2xx) response records status/headers only; the body is never
 * cloned or read, so a model streaming response is not copied. A non-2xx
 * response is cloned and fully snapshot before the original Response is
 * returned to the Pi SDK, so the observation is complete before any Pi
 * terminal event can arrive. A rejected fetch (transport failure, e.g.
 * ECONNRESET) is recorded as `transport-error` so it is never confused with
 * an older HTTP status.
 */
export type HttpObservation =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly statusText: string;
      readonly headers: Headers;
      readonly body?: HttpObservedBody;
    }
  | {
      readonly kind: "transport-error";
      readonly error: unknown;
    };

type PendingObservation = {
  kind: "pending";
};

type MutableObservation = PendingObservation | HttpObservation;

/**
 * Invocation-local observer for Pi provider HTTP requests.
 *
 * One instance is created per Pi invocation (per `execute()` call) and its
 * `observedFetch` is passed to Pi as `options.fetch`. It keeps exactly one
 * slot, the latest fetch *call*, not the latest completion: each call replaces
 * `latest` with a fresh pending object, so when concurrent attempts resolve
 * out of order the final `latest` still names the most recently started call.
 * Adapter-level retries are therefore handled naturally (each retry is a new
 * fetch call), while future assistant-level retries (`retryAssistantCall`)
 * must create a fresh observer per invocation and must not reuse one.
 */
export class HttpObserver {
  private latest: MutableObservation | undefined;
  readonly observedFetch: FetchFunction;

  constructor(baseFetch: FetchFunction = globalThis.fetch) {
    this.observedFetch = (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
      const current: PendingObservation = { kind: "pending" };
      this.latest = current;

      return baseFetch(input, init).then(async (response) => {
        const observation = await snapshotResponse(response);
        // Mutate the pending slot captured at call time: `latest` still
        // points at the most recently *started* call even when concurrent
        // attempts resolve out of order.
        Object.assign(current, observation);
        return response;
      }, (error: unknown) => {
        Object.assign(current, { kind: "transport-error", error });
        throw error;
      });
    };
  }

  /** Latest observed outcome, or undefined when no fetch call has been made. */
  get latestObservation(): HttpObservation | undefined {
    return this.latest?.kind === "pending" ? undefined : this.latest;
  }
}

async function snapshotResponse(response: Response): Promise<HttpObservation> {
  if (response.ok) {
    return {
      kind: "response",
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    };
  }

  // Clone and fully read the error body before returning the original Response
  // to the SDK, so the observation is complete when Pi emits its terminal.
  const buffer = await response.clone().arrayBuffer();
  return {
    kind: "response",
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    body: new Uint8Array(buffer),
  };
}
