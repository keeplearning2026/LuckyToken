import { isAbsolute, resolve } from "node:path";

/**
 * Runtime Diagnostics configuration. The diagnostics store owns this
 * snapshot; consumers bind it instead of re-parsing raw configuration.
 *
 * Ownership is a versioned contract, not object identity (F9): a
 * structurally valid authoritative snapshot carries an opaque version
 * marker and binds across module-instance boundaries.
 */
export interface RuntimeDiagnosticsConfiguration {
  /** Directory that owns the versioned diagnostics database file. */
  readonly directory: string;
}

const CONFIG_SCHEMA = "luckytoken.runtime_diagnostics.v1";
const CONFIG_MARKER = "__luckytokenRuntimeDiagnosticsV1";

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

export function parseRuntimeDiagnosticsConfiguration(
  value: unknown,
  configDirectory: string,
  path = "runtimeDiagnostics",
): RuntimeDiagnosticsConfiguration {
  const root = record(value ?? {}, path);
  for (const key of Object.keys(root)) {
    if (key !== "directory") throw new Error(`${path}.${key} is unknown`);
  }
  const rawDirectory = nonEmptyString(
    root.directory ?? "state/diagnostics",
    `${path}.directory`,
  );
  const directory = isAbsolute(rawDirectory)
    ? resolve(rawDirectory)
    : resolve(configDirectory, rawDirectory);
  return Object.freeze({
    directory,
    [CONFIG_MARKER]: CONFIG_SCHEMA,
  });
}

export function bindRuntimeDiagnosticsConfiguration(
  value: unknown,
): RuntimeDiagnosticsConfiguration {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, CONFIG_MARKER) ||
    (value as Record<string, unknown>)[CONFIG_MARKER] !== CONFIG_SCHEMA
  ) {
    throw new Error(
      "runtimeDiagnostics configuration is not a diagnostics-owned snapshot",
    );
  }
  return value as RuntimeDiagnosticsConfiguration;
}
