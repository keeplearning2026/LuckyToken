export interface AnthropicConfiguration {
  readonly conversion: {
    readonly request: {
      readonly unknownContent: "error" | "ignore";
      readonly localCacheControl: "ignore" | "promote";
    };
    readonly response: { readonly unknownPiContent: "error" | "ignore" };
  };
}

const snapshots = new WeakSet<object>();

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key} is unknown`);
}
function choice<T extends string>(value: unknown, fallback: T, allowed: readonly T[], path: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  return value as T;
}
export function parseAnthropicConfiguration(value: unknown = {}, path = "clientProtocols.anthropic-messages"): AnthropicConfiguration {
  const root = record(value, path); keys(root, ["conversion"], path);
  const conversion = record(root.conversion === undefined ? {} : root.conversion, `${path}.conversion`); keys(conversion, ["request", "response"], `${path}.conversion`);
  const request = record(conversion.request === undefined ? {} : conversion.request, `${path}.conversion.request`); keys(request, ["unknownContent", "localCacheControl"], `${path}.conversion.request`);
  const response = record(conversion.response === undefined ? {} : conversion.response, `${path}.conversion.response`); keys(response, ["unknownPiContent"], `${path}.conversion.response`);
  const snapshot = Object.freeze({ conversion: Object.freeze({
    request: Object.freeze({
      unknownContent: choice(request.unknownContent, "error", ["error", "ignore"], `${path}.conversion.request.unknownContent`),
      localCacheControl: choice(request.localCacheControl, "ignore", ["ignore", "promote"], `${path}.conversion.request.localCacheControl`),
    }),
    response: Object.freeze({ unknownPiContent: choice(response.unknownPiContent, "error", ["error", "ignore"], `${path}.conversion.response.unknownPiContent`) }),
  }) });
  snapshots.add(snapshot);
  return snapshot;
}

export function bindAnthropicConfiguration(value: unknown): AnthropicConfiguration {
  if (typeof value !== "object" || value === null || !snapshots.has(value)) {
    throw new Error("clientProtocols.anthropic-messages configuration is not an Anthropic-owned snapshot");
  }
  return value as AnthropicConfiguration;
}
