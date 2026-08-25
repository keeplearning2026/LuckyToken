import type { CodexFetchFunction } from "../../codex-native-seam.js";
import {
  observeRequestJourney,
  type ClientProtocolHandler,
  type ClientProtocolRequestContext,
} from "../../http.js";
import {
  preserveDirectResponse,
  preserveDirectStatusText,
} from "../../local-native-http-response.js";

export const CODEX_IMAGES_GENERATIONS_URL =
  "https://chatgpt.com/backend-api/codex/images/generations";
export const CODEX_IMAGES_EDITS_URL =
  "https://chatgpt.com/backend-api/codex/images/edits";
export const CODEX_IMAGES_RESPONSE_MAX_BYTES = 100 * 1024 * 1024;

export interface CreateCodexDirectImagesHandlerOptions {
  readonly fetch: CodexFetchFunction;
  readonly maxRequestBytes: number;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "expect",
]);

function connectionHeaders(source: Headers): Set<string> {
  return new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

function requestHeaders(
  source: Headers,
): Headers {
  const connectionScoped = connectionHeaders(source);
  const result = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionScoped.has(lower)
    ) {
      continue;
    }
    result.append(lower, value);
  }
  return result;
}

function responseHeaders(source: Headers): Headers {
  const connectionScoped = connectionHeaders(source);
  const result = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionScoped.has(lower)
    ) {
      continue;
    }
    result.append(lower, value);
  }
  return result;
}

function payloadTooLargeError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "Images request body is too large",
      },
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

function requestReadFailureError(): Response {
  return new Response(null, { status: 500 });
}

function upstreamFailureError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "api_error",
        message: "Upstream images request failed",
      },
    }),
    { status: 502, headers: { "content-type": "application/json" } },
  );
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onAbort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      length += value.byteLength;
      if (length > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // An aborted stream can retain the reader lock briefly.
    }
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

type ImagesEndpoint = "generations" | "edits";

function observeImages(
  context: ClientProtocolRequestContext | undefined,
  observation: Parameters<typeof observeRequestJourney>[1],
): void {
  if (context !== undefined) observeRequestJourney(context, observation);
}

function completeImages(
  context: ClientProtocolRequestContext | undefined,
  response: Response,
  failure?: Readonly<{
    classification: string;
    origin: "client" | "Token" | "provider" | "network_os";
    location: Readonly<{
      phase: "lane_request_preparation" | "upstream_execution" | "lane_response_processing";
      lane: "direct";
      step: string;
    }>;
  }>,
): Response {
  const failed = response.status >= 400;
  if (failed) {
    const incident = failure ?? {
      classification: "upstream_images_http_error",
      origin: "provider" as const,
      location: {
        phase: "lane_response_processing" as const,
        lane: "direct" as const,
        step: "preserve_direct_response",
      },
    };
    observeImages(context, {
      kind: "failure_detected",
      failureId: `${context?.requestId ?? "images"}:${incident.classification}`,
      role: "primary",
      classification: incident.classification,
      origin: incident.origin,
      originPrecision: incident.origin === "network_os" ? "boundary" : "exact",
      location: incident.location,
    });
  }
  const presentationLocation = {
    phase: "client_response_preparation",
    lane: "direct",
    step: failed ? "render_direct_images_error" : "prepare_direct_images_response",
  } as const;
  observeImages(context, {
    kind: "step_entered",
    stepInstanceId: `p6.${presentationLocation.step}`,
    location: presentationLocation,
  });
  observeImages(context, {
    kind: "client_response_prepared",
    status: response.status,
    ...(response.headers.get("content-type") === null
      ? {}
      : { mediaType: response.headers.get("content-type")! }),
    location: presentationLocation,
  });
  observeImages(context, {
    kind: "step_completed",
    stepInstanceId: `p6.${presentationLocation.step}`,
    completion: "success",
    operation: "image_generation",
    protocol: "codex-images",
    location: presentationLocation,
  });
  const outcomeLocation = {
    phase: "outcome_commit",
    lane: "direct",
    step: "commit_request_outcome",
  } as const;
  observeImages(context, {
    kind: "step_entered",
    stepInstanceId: "p7.commit_request_outcome",
    location: outcomeLocation,
  });
  observeImages(context, {
    kind: "work_outcome_committed",
    outcome: failed ? "failed" : "success",
    terminalAuthority: "codex_direct_images_handler",
    location: outcomeLocation,
  });
  observeImages(context, {
    kind: "step_completed",
    stepInstanceId: "p7.commit_request_outcome",
    completion: "success",
    operation: "image_generation",
    protocol: "codex-images",
    location: outcomeLocation,
  });
  return preserveDirectResponse(response);
}

function createCodexDirectImagesHandler(
  options: CreateCodexDirectImagesHandlerOptions,
  endpoint: ImagesEndpoint,
): ClientProtocolHandler {
  const pathname = `/v1/images/${endpoint}`;
  const upstreamBase =
    endpoint === "generations"
      ? CODEX_IMAGES_GENERATIONS_URL
      : CODEX_IMAGES_EDITS_URL;
  return Object.freeze({
    method: "POST",
    pathname,
    async handle(
      request: Request,
      context?: ClientProtocolRequestContext,
    ): Promise<Response> {
      const laneLocation = {
        phase: "request_resolution",
        lane: "direct",
        step: "commit_direct_images_lane",
      } as const;
      observeImages(context, {
        kind: "step_entered",
        stepInstanceId: "p2.commit_direct_images_lane",
        location: laneLocation,
      });
      observeImages(context, {
        kind: "lane_committed",
        lane: "direct",
        location: laneLocation,
      });
      observeImages(context, {
        kind: "step_completed",
        stepInstanceId: "p2.commit_direct_images_lane",
        completion: "success",
        operation: "image_generation",
        protocol: "codex-images",
        location: laneLocation,
      });
      const callerEnvelopeLocation = {
        phase: "lane_request_preparation",
        lane: "direct",
        step: "preserve_caller_envelope",
      } as const;
      observeImages(context, {
        kind: "step_entered",
        stepInstanceId: "p3.preserve_caller_envelope",
        location: callerEnvelopeLocation,
      });
      observeImages(context, {
        kind: "step_completed",
        stepInstanceId: "p3.preserve_caller_envelope",
        completion: "success",
        location: callerEnvelopeLocation,
      });
      const envelopeLocation = {
        phase: "lane_request_preparation",
        lane: "direct",
        step: "construct_direct_envelope",
      } as const;
      observeImages(context, {
        kind: "step_entered",
        stepInstanceId: "p3.construct_direct_envelope",
        location: envelopeLocation,
      });
      const declaredLength = request.headers.get("content-length")?.trim();
      if (
        declaredLength !== undefined &&
        /^\d+$/u.test(declaredLength) &&
        Number(declaredLength) > options.maxRequestBytes
      ) {
        observeImages(context, {
          kind: "step_completed",
          stepInstanceId: "p3.construct_direct_envelope",
          completion: "failed",
          location: envelopeLocation,
        });
        return completeImages(context, payloadTooLargeError(), {
          classification: "images_request_too_large",
          origin: "client",
          location: envelopeLocation,
        });
      }
      let body: Uint8Array<ArrayBuffer> | undefined;
      try {
        body = await readBoundedBody(
          request.body,
          options.maxRequestBytes,
          request.signal,
        );
      } catch (error) {
        if (request.signal.aborted) throw error;
        observeImages(context, {
          kind: "step_completed",
          stepInstanceId: "p3.construct_direct_envelope",
          completion: "failed",
          location: envelopeLocation,
        });
        return completeImages(context, requestReadFailureError(), {
          classification: "images_request_body_read_failed",
          origin: "network_os",
          location: envelopeLocation,
        });
      }
      if (body === undefined) {
        observeImages(context, {
          kind: "step_completed",
          stepInstanceId: "p3.construct_direct_envelope",
          completion: "failed",
          location: envelopeLocation,
        });
        return completeImages(context, payloadTooLargeError(), {
          classification: "images_request_too_large",
          origin: "client",
          location: envelopeLocation,
        });
      }
      observeImages(context, {
        kind: "step_completed",
        stepInstanceId: "p3.construct_direct_envelope",
        completion: "success",
        location: envelopeLocation,
      });
      const dispatchLocation = {
        phase: "upstream_execution",
        lane: "direct",
        step: "dispatch_direct_transport",
      } as const;
      observeImages(context, {
        kind: "step_entered",
        stepInstanceId: "p4.dispatch_direct_transport",
        location: dispatchLocation,
      });
      let upstream: Response;
      try {
        upstream = await options.fetch(
          `${upstreamBase}${new URL(request.url).search}`,
          {
            method: "POST",
            headers: requestHeaders(request.headers),
            body,
            signal: request.signal,
            redirect: "manual",
          },
        );
      } catch (error) {
        if (request.signal.aborted) throw error;
        observeImages(context, {
          kind: "step_completed",
          stepInstanceId: "p4.dispatch_direct_transport",
          completion: "failed",
          location: dispatchLocation,
        });
        return completeImages(context, upstreamFailureError(), {
          classification: "upstream_images_connection_failed",
          origin: "network_os",
          location: dispatchLocation,
        });
      }
      observeImages(context, {
        kind: "step_completed",
        stepInstanceId: "p4.dispatch_direct_transport",
        completion: "success",
        location: dispatchLocation,
      });
      const preserveLocation = {
        phase: "lane_response_processing",
        lane: "direct",
        step: "preserve_direct_response",
      } as const;
      observeImages(context, {
        kind: "step_entered",
        stepInstanceId: "p5.preserve_direct_response",
        location: preserveLocation,
      });
      const responseLength = upstream.headers.get("content-length")?.trim();
      if (
        responseLength !== undefined &&
        /^\d+$/u.test(responseLength) &&
        Number(responseLength) > CODEX_IMAGES_RESPONSE_MAX_BYTES
      ) {
        void upstream.body?.cancel().catch(() => undefined);
        observeImages(context, {
          kind: "step_completed",
          stepInstanceId: "p5.preserve_direct_response",
          completion: "failed",
          location: preserveLocation,
        });
        return completeImages(context, upstreamFailureError(), {
          classification: "upstream_images_response_too_large",
          origin: "provider",
          location: preserveLocation,
        });
      }
      let responseBody: Uint8Array<ArrayBuffer> | undefined;
      try {
        responseBody = await readBoundedBody(
          upstream.body,
          CODEX_IMAGES_RESPONSE_MAX_BYTES,
          request.signal,
        );
      } catch (error) {
        if (request.signal.aborted) throw error;
        observeImages(context, {
          kind: "step_completed",
          stepInstanceId: "p5.preserve_direct_response",
          completion: "failed",
          location: preserveLocation,
        });
        return completeImages(context, upstreamFailureError(), {
          classification: "upstream_images_response_read_failed",
          origin: "network_os",
          location: preserveLocation,
        });
      }
      if (responseBody === undefined) {
        observeImages(context, {
          kind: "step_completed",
          stepInstanceId: "p5.preserve_direct_response",
          completion: "failed",
          location: preserveLocation,
        });
        return completeImages(context, upstreamFailureError(), {
          classification: "upstream_images_response_too_large",
          origin: "provider",
          location: preserveLocation,
        });
      }
      observeImages(context, {
        kind: "step_completed",
        stepInstanceId: "p5.preserve_direct_response",
        completion: "success",
        location: preserveLocation,
      });
      return preserveDirectStatusText(completeImages(context, new Response(
        upstream.status === 204 || upstream.status === 205 || upstream.status === 304
          ? null
          : responseBody,
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders(upstream.headers),
        },
      )));
    },
  });
}

export function createCodexDirectImagesGenerationsHandler(
  options: CreateCodexDirectImagesHandlerOptions,
): ClientProtocolHandler {
  return createCodexDirectImagesHandler(options, "generations");
}

export function createCodexDirectImagesEditsHandler(
  options: CreateCodexDirectImagesHandlerOptions,
): ClientProtocolHandler {
  return createCodexDirectImagesHandler(options, "edits");
}
