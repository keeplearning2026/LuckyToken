import { isAbsolute, resolve } from "node:path";

/**
 * Deep Diagnostics capture configuration. The capture store owns this
 * snapshot; consumers bind it instead of re-parsing raw configuration
 * (same ownership contract as Runtime Diagnostics, Ticket 07, and the
 * Request Ledger, Ticket 18).
 *
 * `enabled` is the configuration default for the global capture state; the
 * live enable/disable authority is the registered hot-apply setting
 * `diagnostics.deepCapture.enabled` in the settings registry. Retention is
 * bounded by age (from the acceptance-time snapshot) and by capacity; the
 * per-record body cap is applied before the universal redaction choke point.
 */
export interface DeepDiagnosticsConfiguration {
  /** Directory that owns the versioned deep-capture database file. */
  readonly directory: string;
  /** Default enable state; the settings registry governs the live toggle. */
  readonly enabled: boolean;
  /** Per-record total capture payload budget in bytes: the serialized
   *  committed record (request body + response body + headers + timing +
   *  envelope) never exceeds `min(maxCaptureBytes, frame ceiling)`, so
   *  every accepted configuration stays retrievable through the framed
   *  Control Plane seam. */
  readonly maxCaptureBytes: number;
  /** Age retention in ms, measured from the acceptance-time snapshot. */
  readonly retentionAgeMs: number;
  /** Capacity retention: maximum committed capture rows. */
  readonly maxCaptures: number;
}

const CONFIG_SCHEMA = "luckytoken.deep_diagnostics.v1";
const CONFIG_MARKER = "__luckytokenDeepDiagnosticsV1";

const DEFAULT_MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETENTION_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CAPTURES = 1_000;

export function parseDeepDiagnosticsConfiguration(
  value: unknown,
  configDirectory: string,
  path = "deepDiagnostics",
): DeepDiagnosticsConfiguration {
  const root = record(value ?? {}, path);
  for (const key of Object.keys(root)) {
    if (
      key !== "directory" &&
      key !== "enabled" &&
      key !== "maxCaptureBytes" &&
      key !== "retentionAgeMs" &&
      key !== "maxCaptures"
    ) {
      throw new Error(`${path}.${key} is unknown`);
    }
  }
  const rawDirectory = nonEmptyString(
    root.directory ?? "state/deep-diagnostics",
    `${path}.directory`,
  );
  const directory = isAbsolute(rawDirectory)
    ? resolve(rawDirectory)
    : resolve(configDirectory, rawDirectory);
  const enabled = booleanValue(root.enabled ?? false, `${path}.enabled`);
  const maxCaptureBytes = boundedInteger(
    root.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES,
    `${path}.maxCaptureBytes`,
    1_024,
    64 * 1024 * 1024,
  );
  const retentionAgeMs = boundedInteger(
    root.retentionAgeMs ?? DEFAULT_RETENTION_AGE_MS,
    `${path}.retentionAgeMs`,
    0,
    365 * 24 * 60 * 60 * 1_000,
  );
  const maxCaptures = boundedInteger(
    root.maxCaptures ?? DEFAULT_MAX_CAPTURES,
    `${path}.maxCaptures`,
    1,
    100_000,
  );
  return Object.freeze({
    directory,
    enabled,
    maxCaptureBytes,
    retentionAgeMs,
    maxCaptures,
    [CONFIG_MARKER]: CONFIG_SCHEMA,
  });
}

export function bindDeepDiagnosticsConfiguration(
  value: unknown,
): DeepDiagnosticsConfiguration {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, CONFIG_MARKER) ||
    (value as Record<string, unknown>)[CONFIG_MARKER] !== CONFIG_SCHEMA
  ) {
    throw new Error(
      "deepDiagnostics configuration is not a capture-owned snapshot",
    );
  }
  return value as DeepDiagnosticsConfiguration;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${path} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}
