import type { FetchFunction, Model, Models, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { boundAnthropicEnvelopeContext } from "../../src/protocols/anthropic/request-context.js";
import { projectAnthropicNativeBody } from "../../src/provider-native-anthropic/body-projection.js";
import { AnthropicPassthroughTransportError, type passthroughAnthropicRequest } from "../../src/provider-native-anthropic/transport.js";

const TERMINAL = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_query","type":"message","role":"assistant","model":"query","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

/** Isolated composition with the existing Native auth/retry/response coordinator. */
export function createAnthropicPiNativeRequestSender(models: Pick<Models, "stream">): typeof passthroughAnthropicRequest {
  return async (input) => {
    if (input.model.api !== "anthropic-messages") throw new Error("Uncertified Anthropic envelope API");
    const prepared = projectAnthropicNativeBody({ rawBody: input.rawBody, modelId: input.model.id, mode: input.bodyProjectionMode });
    try {
      return await sendAnthropicWithPiEnvelope(models, { ...input.model, api: "anthropic-messages" }, JSON.parse(prepared.body), 0, {
        fetch: input.fetch, signal: input.signal,
        ...(input.authMode === "api_key" || input.authMode === "oauth" ? { credentialKind: input.authMode } : {}),
        pi: { apiKey: input.apiKey ?? "",
          ...(input.composedHeaders ? { headers: input.composedHeaders } : {}),
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.requestTimeoutMs === undefined ? {} : { timeoutMs: input.requestTimeoutMs }),
        },
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      throw new AnthropicPassthroughTransportError(error);
    }
  };
}

function equalJsonValues(left: unknown, right: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null
      || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]]);
    }
  }
  return true;
}

/** Test-only public-Pi experiment. Caller supplies an already-approved Native
 * body. Pi owns URL/auth/betas/SDK; its temporary JSON and synthetic response
 * never become the real request/response. Production Native stays unchanged. */
export async function sendAnthropicWithPiEnvelope(
  models: Pick<Models, "stream">,
  model: Model<"anthropic-messages">,
  body: Readonly<Record<string, unknown>>,
  receivedAt: number,
  options: {
    readonly fetch: FetchFunction;
    readonly signal: AbortSignal;
    /** Captured managed kind; already-resolved key/headers are passed in pi.
     * Ambient requests leave this omitted and retain Pi's auth selection. */
    readonly credentialKind?: "api_key" | "oauth";
    readonly pi?: Omit<ModelsApiStreamOptions<"anthropic-messages">,
      "fetch" | "signal" | "onPayload" | "onResponse" | "onProviderStreamEvent" | "maxRetries" | "client" | "thinkingEnabled">;
  },
): Promise<Response> {
  if (model.api !== "anthropic-messages") throw new Error("Uncertified Anthropic envelope API");
  if (body.model !== model.id) throw new Error("Native model rewrite must precede Pi envelope dispatch");
  const nativeJson = JSON.stringify(body);
  const nativeBody = JSON.parse(nativeJson) as Record<string, unknown>;
  const query = parseAnthropicTextInvocation(nativeBody, receivedAt, "max");
  const context = boundAnthropicEnvelopeContext(query.context, receivedAt);
  const piOptions = { ...options.pi };
  let queryCredential: string | undefined;
  if (piOptions.apiKey === "") {
    // Explicit empty key means the caller has already resolved header-owned
    // auth. Do not consult ambient credentials or send the query branch key.
    const hasAuth = Object.entries(piOptions.headers ?? {}).some(([name, value]) =>
      ["authorization", "x-api-key", "cf-aig-authorization"].includes(name.toLowerCase())
      && typeof value === "string" && value.trim().length > 0);
    if (!hasAuth) throw new Error("Resolved header-owned auth is missing");
    queryCredential = `Token-envelope-query-${randomUUID()}`;
    piOptions.apiKey = options.credentialKind === "oauth" ? `sk-ant-oat-${queryCredential}` : queryCredential;
    piOptions.headers = { "x-api-key": null, authorization: null, ...piOptions.headers };
  } else if (options.credentialKind !== undefined) {
    const actualKey = piOptions.apiKey;
    if (!actualKey) throw new Error("Captured credential kind requires a resolved credential");
    const oauth = options.credentialKind === "oauth";
    if (oauth !== actualKey.includes("sk-ant-oat")) {
      // Public options select Pi's client/identity/beta branch. A query-only
      // branch marker is overridden by the real Provider-owned auth header;
      // it is never a wire credential. No Pi client/header code is copied.
      queryCredential = `Token-envelope-query-${randomUUID()}`;
      piOptions.apiKey = oauth ? `sk-ant-oat-${queryCredential}` : queryCredential;
      const headers: Record<string, string | null> = {};
      // Real credentials occupy the SDK-default position, below Model and
      // options headers. Fold case before merging, retaining null omissions.
      for (const source of [oauth ? { authorization: `Bearer ${actualKey}` } : { "x-api-key": actualKey }, model.headers, piOptions.headers])
        for (const [name, value] of Object.entries(source ?? {})) headers[name.toLowerCase()] = value;
      piOptions.headers = headers;
    }
  }
  const thinkingEnabled = query.options.reasoning !== undefined;
  const timeoutMs = options.pi?.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new Error("Invalid native header timeout");
  let prepared = false;
  let calls = 0;
  let captured: Response | undefined;
  let tokenFailure: { readonly cause: unknown } | undefined;
  const fetch: FetchFunction = async (input, init) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!prepared || ++calls !== 1) throw new Error("Pi envelope attempted an unexpected dispatch");
      const deadline = new AbortController();
      const signal = AbortSignal.any([options.signal, deadline.signal]);
      const template = new Request(input, init);
      const headers = new Headers(template.headers);
      if (queryCredential && [...headers.values()].some((value) => value.includes(queryCredential)))
        throw new Error("Pi query credential escaped into the native envelope");
      if (headers.has("content-encoding")) throw new Error("Uncertified Anthropic body encoding");
      // Length must describe the substituted body, never Pi's discarded JSON.
      headers.delete("content-length");
      const request = new Request(template, { body: nativeJson, headers, signal });
      if (!equalJsonValues(await request.clone().json(), nativeBody)) throw new Error("Native body changed before dispatch");
      signal.throwIfAborted();
      if (timeoutMs !== undefined && timeoutMs > 0)
        timer = setTimeout(() => deadline.abort(new Error("Native response headers timed out")), timeoutMs);
      captured = await options.fetch(request);
      signal.throwIfAborted();
      return new Response(TERMINAL, { headers: { "content-type": "text/event-stream" } });
    } catch (error) {
      tokenFailure ??= { cause: error };
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    let piFailure: string | undefined;
    const stream = models.stream(model, context, {
      ...query.options, ...piOptions, thinkingEnabled, fetch, signal: options.signal, maxRetries: 0,
      onPayload: () => {
        try {
          if (prepared) throw new Error("Pi attempted to prepare the payload more than once");
          prepared = true;
        } catch (error) { tokenFailure ??= { cause: error }; throw error; }
      },
    });
    for await (const event of stream) if (event.type === "error") piFailure = event.error.errorMessage;
    if (tokenFailure) throw tokenFailure.cause;
    options.signal.throwIfAborted();
    if (captured) return captured;
    throw new Error(piFailure ?? "Pi did not dispatch the native request");
  } catch (error) {
    try { void captured?.body?.cancel(error).catch(() => {}); } catch { /* Retain original cause. */ }
    throw error;
  }
}
