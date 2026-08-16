import { isAbsolute, resolve } from "node:path";

/**
 * Request Ledger configuration. The ledger store owns this snapshot;
 * consumers bind it instead of re-parsing raw configuration (same
 * ownership contract as Runtime Diagnostics, Ticket 07).
 */
export interface RequestLedgerConfiguration {
  /** Directory that owns the versioned request-ledger database file. */
  readonly directory: string;
}

const CONFIG_SCHEMA = "luckytoken.request_ledger.v1";
const CONFIG_MARKER = "__luckytokenRequestLedgerV1";

export function parseRequestLedgerConfiguration(
  value: unknown,
  configDirectory: string,
  path = "requestLedger",
): RequestLedgerConfiguration {
  const root = record(value ?? {}, path);
  for (const key of Object.keys(root)) {
    if (key !== "directory") throw new Error(`${path}.${key} is unknown`);
  }
  const rawDirectory = nonEmptyString(
    root.directory ?? "state/request-ledger",
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

export function bindRequestLedgerConfiguration(
  value: unknown,
): RequestLedgerConfiguration {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, CONFIG_MARKER) ||
    (value as Record<string, unknown>)[CONFIG_MARKER] !== CONFIG_SCHEMA
  ) {
    throw new Error(
      "requestLedger configuration is not a ledger-owned snapshot",
    );
  }
  return value as RequestLedgerConfiguration;
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