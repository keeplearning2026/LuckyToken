const MAX_URL_CHARACTERS = 8 * 1_024;
const MAX_HEADER_VALUE_CHARACTERS = 8 * 1_024;
const MAX_HEADER_NAMES = 128;

const SAFE_HEADER_NAMES = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "anthropic-beta",
  "anthropic-version",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "date",
  "openai-beta",
  "openai-processing-ms",
  "request-id",
  "retry-after",
  "server",
  "via",
  "x-request-id",
]);

const SAFE_HEADER_PREFIXES = [
  "anthropic-ratelimit-",
  "x-ratelimit-",
] as const;

const SAFE_QUERY_VALUE_NAMES = new Set(["api-version", "version"]);

export interface SafeHttpEnvelopeInput {
  readonly method?: string;
  readonly url?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Headers;
}

function safeUrl(input: string): Readonly<{
  value: string;
  truncated: boolean;
}> {
  const url = new URL(input);
  url.username = "";
  url.password = "";
  for (const name of Array.from(url.searchParams.keys())) {
    if (SAFE_QUERY_VALUE_NAMES.has(name.toLowerCase())) continue;
    url.searchParams.set(name, "[REDACTED]");
  }
  const serialized = url.toString();
  return Object.freeze({
    value: serialized.slice(0, MAX_URL_CHARACTERS),
    truncated: serialized.length > MAX_URL_CHARACTERS,
  });
}

function isSafeHeader(name: string): boolean {
  return SAFE_HEADER_NAMES.has(name) ||
    SAFE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Mechanism-only serializer for diagnostics. It deliberately sees neither a
 * lane nor a request observer, and returns `undefined` on every failure. Only
 * allowlisted header values can leave the data-plane owner through this seam.
 */
export function encodeSafeHttpEnvelope(
  input: SafeHttpEnvelopeInput,
): Uint8Array | undefined {
  try {
    const headers: Record<string, string> = {};
    const omittedHeaderNames: string[] = [];
    const truncatedHeaderNames: string[] = [];
    if (input.headers !== undefined) {
      for (const [sourceName, value] of input.headers.entries()) {
        const name = sourceName.toLowerCase();
        if (!isSafeHeader(name)) {
          if (omittedHeaderNames.length < MAX_HEADER_NAMES) {
            omittedHeaderNames.push(name);
          }
          continue;
        }
        if (value.length > MAX_HEADER_VALUE_CHARACTERS) {
          if (truncatedHeaderNames.length < MAX_HEADER_NAMES) {
            truncatedHeaderNames.push(name);
          }
          continue;
        }
        headers[name] = value;
      }
    }
    omittedHeaderNames.sort();
    truncatedHeaderNames.sort();

    const url = input.url === undefined ? undefined : safeUrl(input.url);
    const value = {
      schema: "Token.diagnostics.safe_http_envelope.v1",
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(url === undefined ? {} : { url: url.value }),
      ...(url?.truncated === true ? { urlTruncated: true } : {}),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.statusText === undefined || input.statusText.length === 0
        ? {}
        : { statusText: input.statusText.slice(0, 1_024) }),
      headerPolicy: "allowlist-v1",
      headers,
      ...(omittedHeaderNames.length === 0 ? {} : { omittedHeaderNames }),
      ...(truncatedHeaderNames.length === 0 ? {} : { truncatedHeaderNames }),
    };
    return new TextEncoder().encode(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function publishSafeHttpEnvelopeArtifact(
  journey: RequestJourneyObserver | undefined,
  input: SafeHttpEnvelopeInput & Readonly<{
    artifactId: string;
    artifactKind: string;
    location: RequestJourneyLocation;
  }>,
): void {
  if (journey === undefined) return;
  try {
    const bytes = encodeSafeHttpEnvelope(input);
    if (bytes === undefined) {
      journey.observe({
        kind: "artifact_observed",
        artifactId: input.artifactId,
        artifactKind: input.artifactKind,
        state: "unavailable",
        reason: "safe_http_envelope_serialization_failed",
        location: input.location,
      });
      return;
    }
    journey.observe({
      kind: "artifact_observed",
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      state: "captured",
      mediaType: "application/json",
      bytes,
      originalBytes: bytes.byteLength,
      capturedBytes: bytes.byteLength,
      truncated: false,
      location: input.location,
    });
  } catch {
    // HTTP serving remains authoritative over diagnostics serialization and
    // publication, including a hostile caller-provided observer.
  }
}
import type {
  RequestJourneyLocation,
  RequestJourneyObserver,
} from "./contract.js";
