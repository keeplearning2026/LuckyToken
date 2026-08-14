import type { KnownApi } from "@earendil-works/pi-ai";

/**
 * HTTP failure acquisition methods for Pi provider adapters.
 *
 * Pi has no unified `HttpError` on the Pi IR boundary and no `httpStatus`
 * field on `AssistantMessage`. HTTP information exists inside the provider
 * SDK / adapter and is normally flattened into `AssistantMessage.errorMessage`
 * (or occasionally into `AssistantMessage.diagnostics`). LuckyToken wants the
 * original status/body, so this table records, per Pi `api`, which acquisition
 * method LuckyToken should use and what it can reliably obtain.
 *
 * The Pi `api` value tells LuckyToken *where* and *how* to obtain the HTTP
 * failure, not what the status is. The status/body themselves always come from
 * the upstream HTTP response.
 */
export type HttpFailureAcquisition =
  | {
      readonly kind: "fetch-observation";
      /**
       * The Pi adapter forwards `options.fetch` into the provider SDK / direct
       * fetch call, so LuckyToken can wrap it and observe the real HTTP
       * Response (status, headers, body) before Pi flattens it into
       * `errorMessage`.
       */
      readonly reason: string;
      /**
       * Whether the adapter also produces a structured diagnostic on failure
       * (`AssistantMessage.diagnostics`), usable as a fallback when the fetch
       * observation is unavailable.
       */
      readonly diagnosticFallback: boolean;
    }
  | {
      readonly kind: "diagnostics";
      /**
       * The adapter does not expose an injectable fetch; HTTP failure details
       * are only available through `AssistantMessage.diagnostics`.
       */
      readonly reason: string;
    }
  | {
      readonly kind: "error-message";
      /**
       * The adapter rejects custom fetch and provides no structured
       * diagnostic; only the flattened `AssistantMessage.errorMessage` string
       * (already formatted with status/body by Pi) is available.
       */
      readonly reason: string;
    };

/**
 * Map Pi `KnownApi` values plus LuckyToken-owned adapter apis to their HTTP
 * failure acquisition method.
 *
 * This is the only place in LuckyToken that needs to know the concrete Pi
 * `api` values for HTTP failure acquisition. Everything else treats `api` as
 * an opaque string.
 */
export const httpFailureAcquisitionByApi: Readonly<Record<KnownApi, HttpFailureAcquisition>> = {
  "anthropic-messages": {
    kind: "fetch-observation",
    reason:
      "createClient() forwards options.fetch into new Anthropic({ fetch }) on all three auth paths (API key, OAuth, Copilot); SDK throws on non-2xx, Pi catch flattens to errorMessage. Observe the Response at the fetch boundary.",
    diagnosticFallback: false,
  },
  "openai-responses": {
    kind: "fetch-observation",
    reason:
      "createClient() forwards options.fetch into new OpenAI({ fetch }); SDK throws on non-2xx, Pi catch runs normalizeProviderError/formatProviderError into errorMessage. Observe at the fetch boundary.",
    diagnosticFallback: false,
  },
  "openai-completions": {
    kind: "fetch-observation",
    reason:
      "Adapter forwards options.fetch into the OpenAI SDK; SDK throws on non-2xx, Pi catch runs normalizeProviderError/formatProviderError into errorMessage (including OpenRouter raw metadata). Observe at the fetch boundary.",
    diagnosticFallback: false,
  },
  "azure-openai-responses": {
    kind: "fetch-observation",
    reason:
      "Same OpenAI SDK path as openai-responses: options.fetch is forwarded into the client; SDK throws on non-2xx, Pi catch flattens to errorMessage. Observe at the fetch boundary.",
    diagnosticFallback: false,
  },
  "mistral-conversations": {
    kind: "fetch-observation",
    reason:
      "Adapter calls (options?.fetch ?? globalThis.fetch) directly and throws MistralHttpError(status, body, statusText) on !response.ok; Pi catch flattens to errorMessage. Observe the Response at the fetch boundary.",
    diagnosticFallback: false,
  },
  "openai-codex-responses": {
    kind: "fetch-observation",
    reason:
      "SSE path calls (options?.fetch ?? globalThis.fetch) directly and reads non-2xx body before throwing a friendly error; WebSocket path (default transport) does not use fetch. Observe fetch for the SSE path; WebSocket failures need separate handling.",
    diagnosticFallback: false,
  },
  "pi-messages": {
    kind: "fetch-observation",
    reason:
      "Adapter calls (options?.fetch ?? globalThis.fetch) directly and throws PiMessagesResponseError on !response.ok; it also attaches a structured diagnostic (pi_messages_response_failure) with status/statusText/error/body. Observe at the fetch boundary; diagnostics is a fallback.",
    diagnosticFallback: true,
  },
  "bedrock-converse-stream": {
    kind: "diagnostics",
    reason:
      "Uses the AWS SDK (no injectable fetch); on failure Pi reads $metadata.httpStatusCode and appends a bedrock_response_failure diagnostic with status/errorCode/requestId. Raw HTTP body is weak here; errorMessage also carries the normalized text.",
  },
  "google-generative-ai": {
    kind: "error-message",
    reason:
      "Adapter rejects custom fetch (throws 'Custom fetch is not supported by the Google Generative AI adapter') and provides no structured diagnostic. Only the flattened errorMessage from normalizeProviderError is available; SDK error may carry status/body.",
  },
  "google-vertex": {
    kind: "error-message",
    reason:
      "Adapter rejects custom fetch (throws 'Custom fetch is not supported by the Google Vertex adapter') and provides no structured diagnostic. Only the flattened errorMessage from normalizeProviderError is available; SDK error may carry status/body.",
  },
};

/**
 * Resolve the HTTP failure acquisition method for a Pi `api` value.
 *
 * `Api` is `KnownApi | (string & {})`, so unknown adapter strings are possible.
 * They fail explicitly: LuckyToken must not guess an acquisition method for an
 * adapter it has not audited.
 */
export function resolveHttpFailureAcquisition(
  api: string,
): HttpFailureAcquisition {
  const known = httpFailureAcquisitionByApi[api as KnownApi];
  if (known === undefined) {
    throw new Error(
      `No HTTP failure acquisition method mapped for Pi api: ${api}`,
    );
  }
  return known;
}

/**
 * True when a Pi adapter accepts `options.fetch`, so the Client Protocol
 * handler can install a fetch observer for this `api`.
 *
 * Only Pi `KnownApi` values are considered. LuckyToken-owned adapters with
 * their own request-local failure acquisition (for example CommandCode) never
 * receive an observed fetch and return false here. Unknown adapter strings
 * also return false so no un-audited adapter receives an injected fetch.
 */
export function supportsFetchObservation(api: string): boolean {
  const known = httpFailureAcquisitionByApi[api as KnownApi];
  return known?.kind === "fetch-observation";
}
