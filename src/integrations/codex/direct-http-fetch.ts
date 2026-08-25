import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import type { CodexFetchFunction } from "../../codex-native-seam.js";

function requestBody(init: RequestInit | undefined): Uint8Array | undefined {
  const body = init?.body;
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError("Codex Direct HTTP transport requires an opaque byte body");
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function requestHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers);
  return input instanceof Request ? new Headers(input.headers) : new Headers();
}

function nodeRequestHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers);
}

function responseHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

/**
 * Raw HTTP transport for Codex Direct Mode. Unlike Fetch, Node's http/https
 * client does not transparently decode Content-Encoding, so the upstream
 * response body and representation headers remain mutually authoritative.
 */
export function createCodexDirectHttpFetch(): CodexFetchFunction {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const body = requestBody(init);
    const headers = requestHeaders(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const request = url.protocol === "http:" ? httpRequest : url.protocol === "https:" ? httpsRequest : undefined;
    if (request === undefined) throw new TypeError(`Unsupported Direct HTTP protocol: ${url.protocol}`);

    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      let upstreamResponse: IncomingMessage | undefined;
      const finishReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        const reason = signal?.reason;
        const error =
          reason instanceof Error ? reason : new Error("Direct HTTP request aborted");
        upstreamResponse?.destroy(error);
        client.destroy(error);
      };
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      const client = request(
        url,
        {
          method,
          headers: nodeRequestHeaders(headers),
        },
        (upstream) => {
          if (settled) {
            upstream.destroy();
            return;
          }
          settled = true;
          upstreamResponse = upstream;
          upstream.once("close", cleanup);
          const status = upstream.statusCode ?? 502;
          const responseInit: ResponseInit = {
            status,
            statusText: upstream.statusMessage ?? "",
            headers: responseHeaders(upstream.rawHeaders),
          };
          if (status === 204 || status === 205 || status === 304) {
            upstream.resume();
            resolve(new Response(null, responseInit));
            return;
          }
          resolve(
            new Response(
              Readable.toWeb(upstream) as ReadableStream<Uint8Array>,
              responseInit,
            ),
          );
        },
      );
      client.once("error", finishReject);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (body === undefined) client.end();
      else client.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    });
  }) as CodexFetchFunction;
}
