import type { FetchFunction, Model } from "@earendil-works/pi-ai";

export interface PassthroughAnthropicRequestOptions {
  readonly model: Model<string>;
  readonly rawBody: string;
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
  readonly fetch: FetchFunction;
}

/**
 * Forward an Anthropic Messages request verbatim to an upstream Anthropic
 * endpoint.
 *
 * The client's raw request body is sent unchanged (so provider-specific
 * fields such as `top_p` / `context_management` / `stop_sequences` are never
 * dropped by LuckyToken conversion), authenticated with `x-api-key`, and the
 * upstream response is returned as-is. The caller decides whether to buffer
 * it (Atomic) before writing to the client.
 */
export async function passthroughAnthropicRequest(
  options: PassthroughAnthropicRequestOptions,
): Promise<Response> {
  const { model, rawBody, apiKey, signal, fetch: fetchImpl } = options;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      `No API key configured for passthrough provider: ${model.provider}`,
    );
  }
  const endpoint = new URL("/v1/messages", model.baseUrl).toString();
  return fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: rawBody,
    signal,
  });
}
