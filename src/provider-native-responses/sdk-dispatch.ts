import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * Run one vendor-SDK request and hand the lane the real upstream `Response`.
 *
 * B2′ (`doc/Spec/TokenProviderNativeEnvelopeParityPlan.md` §3.4): the vendor
 * SDK owns the outbound envelope — URL, auth, version/beta/session headers and
 * SDK identity — so Provider Native never re-implements it. The lane still
 * owns the response, because both vendor SDKs consume it: non-2xx responses
 * become `makeStatusError` exceptions with the raw body already drained, and
 * successful streaming responses are parsed into SDK event iterators. The lane
 * must forward upstream status, error body, and live SSE bytes verbatim.
 *
 * The wrapper therefore hands the SDK a synthetic response and keeps the real
 * one. Two deliberate properties:
 *
 * - the SDK's own request signal is NOT forwarded to the real `fetch`; it
 *   carries the SDK client timeout, which would abort a stream the lane is
 *   still reading. Caller cancellation travels on the lane's own signal;
 * - an SDK failure that happened before any response was captured is rethrown
 *   unchanged, so envelope-construction bugs stay visible instead of turning
 *   into "no response".
 */
export async function runShieldedSdkRequest(
  options: {
    readonly fetch: FetchFunction;
    readonly signal: AbortSignal;
    /** Observation-only view of the exact envelope the SDK built. */
    readonly onRequest?: (url: string, init: RequestInit) => void;
  },
  run: (fetchForSdk: FetchFunction) => Promise<unknown>,
): Promise<Response> {
  let captured: Response | undefined;
  const fetchForSdk: FetchFunction = async (input, init) => {
    try {
      options.onRequest?.(String(input), init ?? {});
    } catch {
      // Observation never changes the outbound request.
    }
    const response = await options.fetch(input, {
      ...(init ?? {}),
      signal: options.signal,
    });
    captured = response;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  let sdkError: unknown;
  try {
    await run(fetchForSdk);
  } catch (error) {
    sdkError = error;
  }
  if (captured !== undefined) return captured;
  if (sdkError !== undefined) throw sdkError;
  throw new Error("Provider SDK did not dispatch an upstream request");
}
