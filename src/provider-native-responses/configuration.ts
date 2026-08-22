export interface ProviderNativeResponsesConfiguration {
  readonly transport: {
    readonly maxRetries: number;
    readonly maxRetryDelayMs: number;
  };
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const snapshots = new WeakSet<object>();

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is unknown`);
  }
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  path: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

export function parseProviderNativeResponsesConfiguration(
  value: unknown = {},
  path = "clientProtocols.openai-responses.providerNative",
): ProviderNativeResponsesConfiguration {
  const root = record(value, path);
  keys(root, ["transport"], path);
  const transport = record(
    root.transport === undefined ? {} : root.transport,
    `${path}.transport`,
  );
  keys(transport, ["maxRetries", "maxRetryDelayMs"], `${path}.transport`);
  const snapshot = Object.freeze({
    transport: Object.freeze({
      maxRetries: integer(transport.maxRetries, 0, 0, 100, `${path}.transport.maxRetries`),
      maxRetryDelayMs: integer(
        transport.maxRetryDelayMs,
        60_000,
        0,
        MAX_TIMER_DELAY_MS,
        `${path}.transport.maxRetryDelayMs`,
      ),
    }),
  });
  snapshots.add(snapshot);
  return snapshot;
}

export function bindProviderNativeResponsesConfiguration(
  value: unknown,
): ProviderNativeResponsesConfiguration {
  if (typeof value !== "object" || value === null || !snapshots.has(value)) {
    throw new Error(
      "clientProtocols.openai-responses.providerNative configuration is not a Provider Native Responses-owned snapshot",
    );
  }
  return value as ProviderNativeResponsesConfiguration;
}
