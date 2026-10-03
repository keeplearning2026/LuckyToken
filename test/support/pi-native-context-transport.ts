import type { Api, FetchFunction, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { zstdDecompressSync } from "node:zlib";
import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";
import { responsesEnvelopeContext } from "../../src/protocols/openai-responses/request-context.js";

const APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);
const TERMINAL = 'data: {"type":"response.completed","response":{"id":"resp_envelope_query","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n';

// Native input is JSON. Snapshot with the same permitted value normalization
// as SDK serialization, without structuredClone's lower nesting limit.
function snapshotBody(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body));
}

/** Decoded JSON values only: object key order is irrelevant, array order is exact. */
function equalJsonValues(left: unknown, right: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null
      || Array.isArray(a) !== Array.isArray(b)) return false;
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const keys = Object.keys(aRecord);
    if (keys.length !== Object.keys(bRecord).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(bRecord, key)) return false;
      pending.push([aRecord[key], bRecord[key]]);
    }
  }
  return true;
}

/** Token-owned pure preparation seam; only the established deployment rewrite. */
export function projectPiNativeDeployment(
  body: Readonly<Record<string, unknown>>,
  model: Model<Api>,
  piPayload: unknown,
): Readonly<Record<string, unknown>> {
  if (model.api !== "azure-openai-responses") return body;
  if (typeof piPayload !== "object" || piPayload === null || !("model" in piPayload)
    || typeof piPayload.model !== "string") throw new Error("Pi did not resolve an Azure deployment");
  return { ...body, model: piPayload.model };
}

/**
 * Experiment only. Pi owns auth, normalization, endpoint, headers, SDK and
 * compression; the caller owns the already-rewritten native body and Response.
 * No response tee, clone, parsing, retry or SDK error translation is permitted.
 */
export async function sendWithPiEnvelope(
  models: Pick<Models, "streamSimple">,
  model: Model<Api>,
  body: Readonly<Record<string, unknown>>,
  receivedAt: number,
  options: {
    readonly fetch: FetchFunction;
    readonly signal: AbortSignal;
    readonly pi?: Omit<ModelsSimpleStreamOptions,
      "fetch" | "signal" | "onPayload" | "onResponse" | "onProviderStreamEvent" | "maxRetries" | "transport">;
  },
): Promise<Response> {
  if (!APIS.has(model.api)) throw new Error(`Uncertified envelope API: ${model.api}`);
  if (body.model !== model.id) throw new Error("Native model rewrite must precede Pi envelope dispatch");
  // These overlays belong to the discarded semantic body, never the Native
  // body or Azure deployment authority. Keep all actual envelope Model facts.
  const envelopeModel = { ...model };
  delete envelopeModel.samplingParams;
  const piOptions = { ...options.pi };
  delete piOptions.samplingParams;
  const timeoutMs = piOptions.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0))
    throw new Error("Invalid native header timeout");
  let nativeBody = snapshotBody(body);
  const query = convertResponsesRequest(snapshotBody(nativeBody), receivedAt, undefined, "max");
  // Max retains representable content, but Pi must not build that entire
  // discarded body. For these certified APIs, only initiator/image presence
  // affect Context-derived envelope facts; prepare their bounded markers.
  const envelopeContext = responsesEnvelopeContext(nativeBody, receivedAt).context;
  let payloadReplaced = false;
  let captured: Response | undefined;
  let calls = 0;
  let tokenFailure: { readonly cause: unknown } | undefined;
  const fetch: FetchFunction = async (input, init) => {
    const headerDeadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!payloadReplaced || ++calls !== 1) throw new Error("Pi envelope attempted an unexpected dispatch");
      // Discard the SDK timer, which could abort Native's later body read.
      // This deadline stops at response headers; caller cancellation continues.
      const signal = AbortSignal.any([options.signal, headerDeadline.signal]);
      const request = new Request(input, { ...init, signal });
      const wire = new Uint8Array(await request.clone().arrayBuffer());
      const json = request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(wire).toString("utf8")
        : new TextDecoder().decode(wire);
      // N1 permits JSON representation normalization, including -0 -> 0.
      // No fields/array order are exempt from the decoded-wire comparison.
      if (!equalJsonValues(JSON.parse(json), nativeBody)) {
        throw new Error("Pi/SDK changed the native body; dispatch refused");
      }
      signal.throwIfAborted();
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => headerDeadline.abort(new Error("Native response headers timed out")), timeoutMs);
      }
      captured = await options.fetch(request);
      // A custom fetch must not turn an expired/cancelled attempt into success
      // merely by returning a Response after it ignored the request signal.
      signal.throwIfAborted();
      // The real status, headers and body stay untouched in captured, including
      // non-2xx and unknown SSE extensions. Pi sees only this private response.
      return nativeBody.stream === false
        ? new Response("{}", { headers: { "content-type": "application/json" } })
        : new Response(TERMINAL, { headers: { "content-type": "text/event-stream" } });
    } catch (error) {
      tokenFailure ??= { cause: error };
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  let piFailure: string | undefined;
  try {
    const stream = models.streamSimple(envelopeModel, envelopeContext, {
      ...query.options, ...piOptions, fetch, signal: options.signal, transport: "sse", maxRetries: 0,
      onPayload: (payload) => {
        try {
          if (payloadReplaced) throw new Error("Pi attempted to prepare the payload more than once");
          // Azure's deployment is both a model rewrite and an SDK routing fact.
          // With semantic body overlays excluded, Pi's initial model field is its
          // deployment resolution, not a samplingParams override. Certify on upgrade.
          nativeBody = snapshotBody(projectPiNativeDeployment(nativeBody, model, payload));
          payloadReplaced = true;
          // Give Pi/SDK its own object; caller input stays immutable.
          return snapshotBody(nativeBody);
        } catch (error) {
          // Pi may report callback failures as private error events. Record
          // Token's failure independently, so a prior capture cannot mask it.
          tokenFailure ??= { cause: error };
          throw error;
        }
      },
    });
    for await (const event of stream) {
      if (event.type === "error") piFailure = event.error.errorMessage;
    }
    if (tokenFailure) throw tokenFailure.cause;
    // stream=false gives Pi private JSON, not an iterator. Its parser error
    // is irrelevant to the real Response, once the transport checks passed.
    if (captured) return captured;
    throw new Error(piFailure ?? "Pi did not dispatch the native request");
  } catch (error) {
    // A failed attempt retains ownership of its Response. No caller can free
    // an abandoned body. Initiate cancellation, contain even a late rejection,
    // and do not delay the original failure on an unbounded cleanup promise.
    try { void captured?.body?.cancel(error).catch(() => {}); } catch { /* Keep the original failure. */ }
    throw error;
  }
}
