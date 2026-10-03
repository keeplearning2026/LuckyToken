import type { Api, FetchFunction, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import { convertResponsesRequest } from "../../src/protocols/openai-responses/request.js";

const APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);
const TERMINAL = 'data: {"type":"response.completed","response":{"id":"resp_envelope_query","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n';

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
  let nativeBody = structuredClone(body);
  const query = convertResponsesRequest(structuredClone(nativeBody), receivedAt, undefined, "max");
  let payloadReplaced = false;
  let captured: Response | undefined;
  let calls = 0;
  let transportError: unknown;
  const fetch: FetchFunction = async (input, init) => {
    try {
      if (!payloadReplaced || ++calls !== 1) throw new Error("Pi envelope attempted an unexpected dispatch");
      // The SDK's timer owns only its internal response. Caller cancellation
      // owns the real response stream, as in the current Native SDK shield.
      const request = new Request(input, { ...init, signal: options.signal });
      const wire = new Uint8Array(await request.clone().arrayBuffer());
      const json = request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(wire).toString("utf8")
        : new TextDecoder().decode(wire);
      if (!isDeepStrictEqual(JSON.parse(json), nativeBody)) {
        throw new Error("Pi/SDK changed the native body; dispatch refused");
      }
      captured = await options.fetch(request);
      // The real status, headers and body stay untouched in captured, including
      // non-2xx and unknown SSE extensions. Pi sees only this private response.
      return nativeBody.stream === false
        ? new Response("{}", { headers: { "content-type": "application/json" } })
        : new Response(TERMINAL, { headers: { "content-type": "text/event-stream" } });
    } catch (error) {
      transportError = error;
      throw error;
    }
  };
  let piFailure: string | undefined;
  const stream = models.streamSimple(model, query.context, {
    ...query.options, ...options.pi, fetch, signal: options.signal, transport: "sse", maxRetries: 0,
    onPayload: (payload) => {
      if (payloadReplaced) throw new Error("Pi attempted to prepare the payload more than once");
      // Azure's deployment is both a model rewrite and an SDK routing fact.
      // Reuse Pi's resolved name instead of duplicating its env/map rules.
      nativeBody = structuredClone(projectPiNativeDeployment(nativeBody, model, payload));
      payloadReplaced = true;
      // Give Pi/SDK its own object; caller input stays immutable.
      return structuredClone(nativeBody);
    },
  });
  for await (const event of stream) {
    if (event.type === "error") piFailure = event.error.errorMessage;
  }
  if (transportError) throw transportError;
  if (captured) return captured;
  throw new Error(piFailure ?? "Pi did not dispatch the native request");
}
