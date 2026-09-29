import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * Run one Anthropic SDK request and hand the lane the real upstream
 * `Response`. Lane-local copy of the same B2′ shield the Responses lane owns:
 * the two preservation lanes never share a transport, so each keeps its own.
 *
 * The SDK owns the outbound envelope (URL with its beta query, auth, version
 * and beta headers, SDK identity, timeout header). The lane owns the response:
 * SDK error handling consumes non-2xx bodies, and streaming responses are
 * parsed into SDK event iterators, while the lane must forward upstream status,
 * error body, and live SSE bytes verbatim.
 *
 * The SDK's own request signal is deliberately not forwarded — it carries the
 * SDK client timeout, which would abort a stream the lane is still reading.
 */
export async function runShieldedAnthropicRequest(
  options: {
    readonly fetch: FetchFunction;
    readonly signal: AbortSignal;
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
  throw new Error("Anthropic SDK did not dispatch an upstream request");
}
