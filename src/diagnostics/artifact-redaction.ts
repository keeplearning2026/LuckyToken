const REDACTED = "[REDACTED]";
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 32_768;
const MAX_REDACTED_BYTES = 256 * 1_024;

const SECRET_KEY =
  /(?:^|[-_.])(?:authorization|proxy[-_]?authorization|api[-_]?key|apikey|cookie|set[-_]?cookie|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token|credential)(?:$|[-_.])/iu;

export type ArtifactRedactionUnavailableReason =
  | "binary_body_not_persisted"
  | "unsupported_media_type"
  | "redaction_incomplete_json"
  | "redaction_invalid_utf8"
  | "redaction_invalid_json"
  | "redaction_budget_exceeded"
  | "redaction_output_exceeded"
  | "redaction_failed";

export interface ArtifactRedactionInput {
  readonly artifactKind: string;
  readonly mediaType?: string;
  readonly bytes: Uint8Array;
  readonly originalBytes: number;
  readonly sourceTruncated: boolean;
}

export type ArtifactRedactionResult =
  | Readonly<{
      kind: "sanitized";
      bytes: Uint8Array;
      redaction: "not_required" | "applied";
      truncated: false;
    }>
  | Readonly<{
      kind: "unavailable";
      redaction: "not_required" | "failed";
      reason: ArtifactRedactionUnavailableReason;
    }>;

interface RedactionBudget {
  nodes: number;
  changed: boolean;
}

class RedactionUnavailable extends Error {
  constructor(readonly reason: ArtifactRedactionUnavailableReason) {
    super(reason);
  }
}

function unavailable(
  reason: ArtifactRedactionUnavailableReason,
  redaction: "not_required" | "failed",
): ArtifactRedactionResult {
  return Object.freeze({ kind: "unavailable", redaction, reason });
}

function jsonMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const essence = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return essence === "application/json" || essence.endsWith("+json");
}

function binaryMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const essence = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return (
    essence === "application/octet-stream" ||
    essence.startsWith("image/") ||
    essence.startsWith("audio/") ||
    essence.startsWith("video/") ||
    essence === "application/pdf" ||
    essence === "application/zip"
  );
}

function scrubString(value: string): string {
  return value
    .replace(
      /\b(bearer|basic|digest|apikey)\s+[A-Za-z0-9._~+/=-]{4,}\b/giu,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    )
    .replace(
      /\b(access[-_]?token|refresh[-_]?token|api[-_]?key|apikey|password|passwd|client[-_]?secret|authorization|credential)\s*=\s*[^\s,;]+/giu,
      (_match, name: string) => `${name}=${REDACTED}`,
    )
    .replace(
      /\b(authorization|proxy[- ]authorization|x-api-key|cookie|set-cookie)\s*:\s*[^\s,;]+/giu,
      (_match, name: string) => `${name}: ${REDACTED}`,
    )
    .replace(/\b(?:lt_|sk-|sk_|key-)[A-Za-z0-9_-]{8,}\b/giu, REDACTED);
}

function sanitizeJson(
  value: unknown,
  depth: number,
  budget: RedactionBudget,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new RedactionUnavailable("redaction_budget_exceeded");
  }
  if (typeof value === "string") {
    const scrubbed = scrubString(value);
    if (scrubbed !== value) budget.changed = true;
    return scrubbed;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry, depth + 1, budget));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = Object.create(null);
    for (const [name, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SECRET_KEY.test(name)) {
        output[name] = REDACTED;
        budget.changed = true;
      } else {
        output[name] = sanitizeJson(entry, depth + 1, budget);
      }
    }
    return output;
  }
  throw new RedactionUnavailable("redaction_invalid_json");
}

/**
 * Synchronous fail-closed artifact redaction. Callers must pass a fresh,
 * bounded copy; this function always returns a different byte buffer and
 * never retains its input.
 */
export function redactRequestArtifact(
  input: ArtifactRedactionInput,
): ArtifactRedactionResult {
  try {
    if (input.sourceTruncated) {
      return unavailable("redaction_incomplete_json", "failed");
    }
    if (!jsonMediaType(input.mediaType)) {
      return binaryMediaType(input.mediaType)
        ? unavailable("binary_body_not_persisted", "not_required")
        : unavailable("unsupported_media_type", "not_required");
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      return unavailable("redaction_invalid_utf8", "failed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded) as unknown;
    } catch {
      return unavailable("redaction_invalid_json", "failed");
    }
    const budget: RedactionBudget = { nodes: 0, changed: false };
    const sanitized = sanitizeJson(parsed, 0, budget);
    const encoded = new TextEncoder().encode(JSON.stringify(sanitized));
    if (encoded.byteLength > MAX_REDACTED_BYTES) {
      return unavailable("redaction_output_exceeded", "failed");
    }
    const bytes = new Uint8Array(encoded.byteLength);
    bytes.set(encoded);
    return Object.freeze({
      kind: "sanitized",
      bytes,
      redaction: budget.changed ? "applied" : "not_required",
      truncated: false,
    });
  } catch (error) {
    return unavailable(
      error instanceof RedactionUnavailable
        ? error.reason
        : "redaction_failed",
      "failed",
    );
  }
}
