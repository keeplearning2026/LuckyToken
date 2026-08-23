/**
 * Universal credential-redaction choke point (Ticket 07).
 *
 * Every untrusted value a producer submits — message text, nested details,
 * error/cause chains, header maps, Pi credentials — passes through exactly
 * one recursive sanitizer before anything is persisted, queried, or emitted.
 * The sanitizer never invokes attacker getters, toJSON, or toString, is
 * bounded in depth, breadth, and size, and replaces credential values so they
 * can never be reconstructed from persisted bytes.
 */

const MAX_DEPTH = 12;
const MAX_OBJECT_ENTRIES = 128;
const MAX_ARRAY_ENTRIES = 256;
const MAX_TEXT = 4_096;
const MAX_NAME = 128;
const MAX_REDACTED_NAME = 16;

/** Preserved scheme/type names, e.g. `Bearer`, `Basic`, `Digest`, `ApiKey`. */
const SCHEME_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const SAFE_NAME = /^[A-Za-z0-9_.:/#@ -]{0,128}$/u;

const REDACTED = "[REDACTED]";
const OMITTED = "[OMITTED]";
const CIRCULAR = "[CIRCULAR]";

/** HTTP header names that carry authentication capability. */
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
]);

/** Dangerous prototype keys that are always omitted from sanitized JSON. */
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Credential-bearing keys in any object/record position (mixed case). The
 * same key set covers query parameters, form fields, JSON facts, and
 * environment maps. Value shapes (Pi api_key/access/refresh, bearer strings)
 * are handled by value-shape rules below.
 */
const SECRET_KEY = /(?:^|[-_.])(?:authorization|proxy[-_]?authorization|api[-_]?key|apikey|cookie|set[-_]?cookie|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token|credential)(?:$|[-_.])/iu;

const PLAIN_KEY = /^[A-Za-z0-9_.:-]{1,128}$/u;
const BINARY_KEY = /(?:^|_)(?:data|bytes|binary|image|file|base64)(?:$|_)/iu;

/** Bounded-scan substring that indicates "entire value is a credential". */
const CREDENTIAL_VALUE =
  /(?:^|[^a-z0-9])(?:bearer|basic|digest|apikey|api[-_]?key|token|secret|credential|password|passwd|client[-_]?secret|access[-_]?token|refresh[-_]?token)\b[^a-z0-9]?/iu;

/** Redaction markers that must never be re-scanned as credential text. */
const MARKER = /^\[(?:REDACTED|OMITTED|CIRCULAR|OVERSIZED)\]$/u;

/** Text forms like `cookie=...`, `password=...`, `api_key=...`. */
const TEXT_KEY_VALUE_FORM =
  /\b(?:cookie|set-cookie|password|passwd|api[-_]?key|apikey|authorization|proxy[- ]authorization|client[-_]?secret|access[-_]?token|refresh[-_]?token|secret|token|credential)\s*=\s*[^\s,;]+/giu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isPlainValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function safeName(value: string): string {
  if (SAFE_NAME.test(value)) return value;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (SAFE_NAME.test(cleaned)) return cleaned;
  return cleaned.length <= MAX_REDACTED_NAME
    ? cleaned
    : `${cleaned.slice(0, MAX_REDACTED_NAME)}…`;
}

/** Keyed non-reversible fingerprint; never raw SHA-256 of a secret. */
export function createDiagnosticFingerprint(
  value: string,
  key: Uint8Array,
): string {
  const message = new TextEncoder().encode(value);
  const material = new Uint8Array(key.length + message.length);
  material.set(key);
  material.set(message, key.length);
  let hash = 0x811c9dc5;
  for (const byte of material) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fp:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sanitizeText(value: string): string {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  const redacted = withoutControls
    .replace(/\b(bearer|basic|digest|apikey)\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(
      /\b(?:authorization|proxy[- ]authorization|x-api-key|cookie|set-cookie)\s*:\s*[^\s,;]+/giu,
      (header) => `${header.split(":")[0]!.trim()}: ${REDACTED}`,
    )
    .replace(TEXT_KEY_VALUE_FORM, (form) => `${form.split("=")[0]!.trim()}=${REDACTED}`)
    .replace(/\b(?:lt_|sk-|sk_|key-)[A-Za-z0-9_-]{12,}\b/giu, REDACTED)
    .replace(
      /\b[a-z][a-z0-9-]*(?:token|key|secret|password|credential)[a-z0-9-]*[-_][A-Za-z0-9_-]{8,}\b/giu,
      REDACTED,
    );
  return redacted.length <= MAX_TEXT
    ? redacted
    : `${redacted.slice(0, MAX_TEXT)}…`;
}

/** Shared string values: credential-shaped values are fully replaced. */
function sanitizeSharedString(
  value: string,
  scrub: ((value: string) => string) | undefined,
): string {
  const scrubbed = applyScrub(value, scrub);
  if (MARKER.test(scrubbed) || scrubbed === SCRUB_FAILED) return scrubbed;
  if (CREDENTIAL_VALUE.test(scrubbed) && scrubbed.length <= 512) {
    return sanitizeCredentialValue(scrubbed);
  }
  return sanitizeText(scrubbed);
}

/**
 * Known-value scrubbing runs first (before pattern rules) so arbitrary
 * user-chosen tokens such as `hunter2` are removed even when embedded in
 * benignly named facts.
 */
export interface CredentialScrubber {
  readonly scrubText: (text: string) => string;
  readonly scrubValue: (value: unknown) => unknown;
}

export function createCredentialScrubber(
  known: readonly { readonly value: string; readonly label?: string }[],
): CredentialScrubber {
  const values = known
    .map((entry) => entry.value)
    .filter((value) => value.length > 0);
  const labels = new Set(
    known
      .map((entry) => entry.label)
      .filter((label): label is string => label !== undefined && label.length > 0),
  );
  const escape = (text: string): string =>
    text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern =
    values.length === 0
      ? null
      : new RegExp(values.map(escape).join("|"), "gu");
  const labelPattern =
    labels.size === 0
      ? null
      : new RegExp(
          `\\b(?:${[...labels].map(escape).join("|")})\\s*[:=]\\s*[^\\s,;]+`,
          "giu",
        );

  const scrubText = (text: string): string => {
    let redacted = text;
    if (pattern !== null) redacted = redacted.replace(pattern, REDACTED);
    if (labelPattern !== null) {
      redacted = redacted.replace(labelPattern, (_match, ...rest) => {
        const label = rest.at(-2) as string | undefined;
        const safeLabel =
          typeof label === "string" && label.length <= 128
            ? label
            : "credential";
        return `${safeLabel}=${REDACTED}`;
      });
    }
    return redacted;
  };

  const scrubValue = (value: unknown): unknown => {
    if (typeof value === "string") return scrubText(value);
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => scrubValue(entry)));
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const output: Record<string, unknown> = Object.create(null);
      for (const [name, entry] of Object.entries(record)) {
        output[name] = scrubValue(entry);
      }
      return Object.freeze(output);
    }
    return value;
  };

  return Object.freeze({
    scrubText,
    scrubValue: scrubValue as (value: unknown) => unknown,
  });
}

/**
 * Own-data-field reader: only plain data descriptors; accessor properties
 * (getters/proxies) are never invoked — they read as undefined.
 */
function readDataField(value: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor === undefined || descriptor.get !== undefined
    ? undefined
    : descriptor.value;
}

/** Canonical lowercase header name from an own-data string field. */
function headerNameOf(value: unknown): string | undefined {
  const name = readDataField(value as Record<string, unknown>, "name");
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function sanitizeHeaderValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
  scrub: ((value: string) => string) | undefined,
): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return sanitizeSharedString(value, scrub);
  return sanitizeValue(value, depth + 1, seen, scrub);
}

/** Valid header-name token (letters/digits/hyphens), used for pair detection. */
const HEADER_NAME_TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/u;

/**
 * Maps one [name, value] header tuple through the header path. Secret names
 * (case-insensitive) remove authentication capability for any value type;
 * nonsecret complex values recurse safely.
 */
function sanitizeHeaderTuple(
  name: string,
  headerValue: unknown,
  depth: number,
  seen: Set<object>,
  scrub: ((value: string) => string) | undefined,
): unknown {
  const trimmed = name.trim();
  if (trimmed.length === 0) return sanitizeValue([name, headerValue], depth + 1, seen, scrub);
  const canonical = trimmed.toLowerCase();
  const keptName = trimmed.slice(0, MAX_NAME);
  if (SECRET_HEADER_NAMES.has(canonical)) {
    return Object.freeze([keptName, REDACTED]);
  }
  return Object.freeze([
    keptName,
    sanitizeHeaderValue(headerValue, depth, seen, scrub),
  ]);
}

/**
 * Element-wise header-array recursion (F4): inside a header context, every
 * array element is inspected independently. Any 2-element [name, value]
 * whose first element is a string header-name token goes through the header
 * tuple path (secret names redact regardless of surrounding array uniformity
 * or value type); other elements recurse safely while retaining header
 * context where necessary. No all-or-nothing array classification.
 */
function sanitizeHeaderArrayElement(
  element: unknown,
  depth: number,
  seen: Set<object>,
  scrub: ((value: string) => string) | undefined,
  headerContext: boolean,
): unknown {
  if (Array.isArray(element) && element.length >= 2) {
    const [rawName, headerValue] = element as [unknown, unknown];
    if (typeof rawName === "string") {
      const trimmed = rawName.trim();
      if (HEADER_NAME_TOKEN.test(trimmed)) {
        return sanitizeHeaderTuple(trimmed, headerValue, depth, seen, scrub);
      }
    }
    // Non-token first element: this array is itself an ordinary value array;
    // recurse generically but keep header context for its elements.
    return Object.freeze(
      (element as unknown[]).map((entry) =>
        sanitizeHeaderArrayElement(entry, depth + 1, seen, scrub, headerContext),
      ),
    );
  }
  if (isRecord(element)) {
    const name = headerNameOf(element);
    if (name !== undefined && HEADER_NAME_TOKEN.test(name.trim())) {
      const headerValue = readDataField(element, "value");
      const scheme = readDataField(element, "scheme");
      const canonical = name.trim().toLowerCase();
      const keptName = name.trim().slice(0, MAX_NAME);
      if (SECRET_HEADER_NAMES.has(canonical)) {
        return Object.freeze({
          name: keptName,
          value: REDACTED,
          ...(typeof scheme === "string"
            ? {
                scheme:
                  SCHEME_NAME.test(scheme) && scheme.length <= 32
                    ? scheme
                    : REDACTED,
              }
            : {}),
        });
      }
      return Object.freeze({
        name: keptName,
        value: sanitizeHeaderValue(headerValue, depth, seen, scrub),
      });
    }
    return sanitizeValue(element, depth + 1, seen, scrub);
  }
  if (headerContext && Array.isArray(element)) {
    return Object.freeze(
      element.map((entry) =>
        sanitizeHeaderArrayElement(entry, depth + 1, seen, scrub, headerContext),
      ),
    );
  }
  return sanitizeValue(element, depth + 1, seen, scrub);
}

/**
 * Header name/value normalization: accepts maps, [name, value] pairs,
 * arrays-of-pairs, and {name, value} tuples at any nesting. Secret header
 * names (case-insensitive) remove authentication capability regardless of
 * value type; nonsecret complex values recurse safely.
 */
function sanitizeHeader(
  value: unknown,
  depth: number,
  seen: Set<object>,
  scrub: ((value: string) => string) | undefined,
): unknown {
  if (typeof value === "string") return sanitizeSharedString(value, scrub);
  if (isRecord(value)) {
    const name = headerNameOf(value);
    if (name !== undefined) {
      const headerValue = readDataField(value, "value");
      const scheme = readDataField(value, "scheme");
      const canonical = name.toLowerCase();
      const keptName = name.slice(0, MAX_NAME);
      if (SECRET_HEADER_NAMES.has(canonical)) {
        return Object.freeze({
          name: keptName,
          value: REDACTED,
          ...(typeof scheme === "string"
            ? {
                scheme:
                  SCHEME_NAME.test(scheme) && scheme.length <= 32
                    ? scheme
                    : REDACTED,
              }
            : {}),
        });
      }
      return Object.freeze({
        name: keptName,
        value: sanitizeHeaderValue(headerValue, depth, seen, scrub),
      });
    }
  }
  if (Array.isArray(value)) {
    // Element-wise recursion: every element is inspected independently, so
    // mixed arrays (secret pairs + junk/objects/nulls) never lose context.
    return Object.freeze(
      value.map((element) =>
        sanitizeHeaderArrayElement(element, depth + 1, seen, scrub, true),
      ),
    );
  }
  return sanitizeValue(value, depth + 1, seen, scrub);
}

/**
 * Nested Error/cause chain: sanitize name, message, code, and safe
 * correlation ids; never retain raw stack frames. All reads go through own
 * data descriptors — attacker getters are never invoked.
 */
function sanitizeError(
  error: unknown,
  depth: number,
  seen: Set<object>,
  scrub: ((value: string) => string) | undefined,
): unknown {
  if (error instanceof Error) {
    const asRecord = error as unknown as Record<string, unknown>;
    const nameValue = readDataField(asRecord, "name");
    const messageValue = readDataField(asRecord, "message");
    const codeValue = readDataField(asRecord, "code");
    const causeValue = readDataField(asRecord, "cause");
    const name =
      typeof nameValue === "string"
        ? sanitizeSharedString(nameValue, scrub).slice(0, MAX_NAME)
        : "";
    const message =
      typeof messageValue === "string"
        ? sanitizeSharedString(messageValue, scrub)
        : "";
    const code =
      typeof codeValue === "string"
        ? sanitizeSharedString(codeValue, scrub).slice(0, MAX_NAME)
        : undefined;
    const cause =
      depth + 1 < MAX_DEPTH && causeValue !== undefined
        ? sanitizeValue(causeValue, depth + 1, seen, scrub)
        : OMITTED;
    return Object.freeze({
      name: name || "Error",
      message,
      ...(code === undefined ? {} : { code }),
      ...(cause === undefined ? {} : { cause }),
    });
  }
  return sanitizeValue(error, depth + 1, seen, scrub);
}

function sanitizeCredentialValue(value: string): string {
  if (value.length > 512) return REDACTED;
  return REDACTED;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
  scrub: ((value: string) => string) | undefined,
): unknown {
  if (isPlainValue(value)) {
    if (typeof value === "string") {
      const scrubbed = applyScrub(value, scrub);
      if (MARKER.test(scrubbed) || scrubbed === SCRUB_FAILED) return scrubbed;
      if (CREDENTIAL_VALUE.test(scrubbed) && scrubbed.length <= 512) {
        return sanitizeCredentialValue(scrubbed);
      }
      return sanitizeText(scrubbed);
    }
    return value;
  }
  if (value === undefined) return OMITTED;
  if (depth >= MAX_DEPTH) return OMITTED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // F4: element-wise inspection at any nesting. A 2-element array whose
      // first element is a string header-name token routes through the header
      // tuple path when the name is a secret header (regardless of the
      // surrounding array's uniformity). Ordinary semantic pairs (e.g.
      // coordinates) keep their numeric values on the generic path.
      const elementSanitized = value.map((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) {
          const [rawName, headerValue] = entry as [unknown, unknown];
          if (
            typeof rawName === "string" &&
            HEADER_NAME_TOKEN.test(rawName.trim()) &&
            SECRET_HEADER_NAMES.has(rawName.trim().toLowerCase())
          ) {
            return sanitizeHeaderTuple(rawName.trim(), headerValue, depth + 1, seen, scrub);
          }
        }
        return sanitizeValue(entry, depth + 1, seen, scrub);
      });
      if (value.length > MAX_ARRAY_ENTRIES) {
        return Object.freeze([...elementSanitized.slice(0, MAX_ARRAY_ENTRIES), OMITTED]);
      }
      return Object.freeze(elementSanitized);
    }
    if (!isRecord(value)) {
      // Date/URL/Map/Set or arbitrary objects: only well-known plain fields.
      if (value instanceof Date) return value.toISOString();
      return OMITTED;
    }
    // F2: header name/value records are recognized at any nesting — a record
    // carrying an own `name` string is a header tuple and routes through the
    // header sanitizer (secret names redact any value type).
    if (headerNameOf(value) !== undefined) {
      return sanitizeHeader(value, depth, seen, scrub);
    }
    const output: Record<string, unknown> = Object.create(null);
    let entries = 0;
    try {
      for (const rawName of Object.keys(value)) {
        if (DANGEROUS_KEYS.has(rawName)) continue;
        if (entries >= MAX_OBJECT_ENTRIES) {
          output["[omitted]"] = OMITTED;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, rawName);
        // Data descriptors only: accessor properties (getters/proxies) are
        // never invoked — the value is omitted instead.
        if (descriptor === undefined || descriptor.get !== undefined) {
          entries += 1;
          output[safeName(rawName)] = OMITTED;
          continue;
        }
        entries += 1;
        const entry = descriptor.value;
        const name = PLAIN_KEY.test(rawName) ? rawName : safeName(rawName);
        if (name.length === 0) continue;
        if (SECRET_KEY.test(rawName)) {
          // A credential key may carry a {name, value} pair (form field,
          // query parameter): redact the value too.
          if (
            isRecord(entry) &&
            typeof readDataField(entry, "value") === "string"
          ) {
            output[name] = Object.freeze({
              ...(typeof readDataField(entry, "name") === "string"
                ? { name: sanitizeText(String(readDataField(entry, "name"))).slice(0, MAX_NAME) }
                : {}),
              value: REDACTED,
            });
          } else {
            output[name] = REDACTED;
          }
          continue;
        }
        if (BINARY_KEY.test(rawName)) {
          output[name] = OMITTED;
          continue;
        }
        if (rawName === "error" || rawName === "cause" || rawName === "errors") {
          output[name] = sanitizeError(entry, depth + 1, seen, scrub);
          continue;
        }
        if (
          /header|headers|requestHeaders|responseHeaders|set-cookie|cookie/iu.test(
            rawName,
          )
        ) {
          output[name] = sanitizeHeader(entry, depth + 1, seen, scrub);
          continue;
        }
        output[name] = sanitizeValue(entry, depth + 1, seen, scrub);
      }
    } catch {
      output["[omitted]"] = OMITTED;
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}

/**
 * Fixed safe marker used when the owner scrubber throws (F4): the raw value
 * is never persisted/delivered, and the thrown error message is never
 * echoed. The scrub failure replaces the unsafe text entirely.
 */
const SCRUB_FAILED = "[SCRUB_FAILED]";

export interface RedactionResult {
  readonly text: string;
  details?: Readonly<Record<string, unknown>>;
  errors?: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Applies the owner scrubber inside the universal choke point. A throwing
 * scrubber fails closed: the value is replaced with the fixed safe marker;
 * neither the raw input nor the thrown error message may escape.
 */
function applyScrub(
  value: string,
  scrub: ((value: string) => string) | undefined,
): string {
  if (scrub === undefined) return value;
  try {
    return scrub(value);
  } catch {
    return SCRUB_FAILED;
  }
}

export function redactDiagnostic(
  text: string,
  details: unknown,
  error: unknown,
  scrub?: (value: string) => string,
): RedactionResult {
  const scrubbedText = applyScrub(text, scrub);
  const sanitizedText = sanitizeText(scrubbedText);
  const result: RedactionResult = { text: sanitizedText };
  if (details !== undefined) {
    const sanitized = sanitizeValue(details, 0, new Set(), scrub);
    if (isRecord(sanitized)) result.details = sanitized;
  }
  if (error !== undefined) {
    const sanitized = sanitizeError(error, 0, new Set(), scrub);
    if (sanitized !== null && typeof sanitized === "object") {
      result.errors = Object.freeze([sanitized as Record<string, unknown>]);
    }
  }
  return result;
}

export function redactDiagnosticText(
  text: string,
  scrub?: (value: string) => string,
): string {
  return sanitizeText(applyScrub(text, scrub));
}
