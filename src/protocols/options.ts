import type {
  FetchFunction,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

export class InvocationCompositionFailure extends Error {
  readonly kind = "InvocationCompositionFailure";

  constructor(message: string) {
    super(message);
    this.name = "InvocationCompositionFailure";
  }
}

export interface InvocationInfrastructureFacts {
  sessionId: string;
  signal: AbortSignal;
  projectDir?: string;
  /**
   * Optional fetch for provider HTTP requests. The Pi adapter forwards this
   * into the provider SDK / direct fetch call, so LuckyToken can observe the
   * real HTTP Response before Pi flattens it into `errorMessage`. This is
   * infrastructure, not protocol semantics: it never changes what the client
   * protocol owns.
   */
  fetch?: FetchFunction;
}

export type RouterOptionDefaults = Readonly<Record<string, unknown>>;

const PROTOCOL_OPTION_KEYS = new Set([
  "maxTokens",
  "temperature",
  "reasoning",
  "metadata",
]);
const PROTOCOL_METADATA_KEYS = new Set(["user_id"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProtocolOptions(options: ModelsSimpleStreamOptions): void {
  for (const key of Object.keys(options)) {
    if (!PROTOCOL_OPTION_KEYS.has(key)) {
      throw new InvocationCompositionFailure(
        `Client Protocol options do not own Pi option: ${key}`,
      );
    }
  }
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) || (options.maxTokens as number) <= 0)
  ) {
    throw new InvocationCompositionFailure(
      "Client Protocol maxTokens must remain a positive safe integer",
    );
  }
  if (
    options.temperature !== undefined &&
    (typeof options.temperature !== "number" ||
      !Number.isFinite(options.temperature))
  ) {
    throw new InvocationCompositionFailure(
      "Client Protocol temperature must remain finite",
    );
  }
  if (
    options.reasoning !== undefined &&
    !["low", "medium", "high", "xhigh", "max"].includes(options.reasoning)
  ) {
    throw new InvocationCompositionFailure(
      "Client Protocol reasoning must be a known thinking level",
    );
  }
  if (options.metadata !== undefined) {
    if (!isRecord(options.metadata)) {
      throw new InvocationCompositionFailure("Protocol metadata must be an object");
    }
    for (const key of Object.keys(options.metadata)) {
      if (!PROTOCOL_METADATA_KEYS.has(key)) {
        throw new InvocationCompositionFailure(
          `Client Protocol does not own metadata.${key}`,
        );
      }
    }
    if (
      options.metadata.user_id !== undefined &&
      typeof options.metadata.user_id !== "string"
    ) {
      throw new InvocationCompositionFailure("metadata.user_id must remain a string");
    }
  }
}

function validateRouterDefaults(defaults: RouterOptionDefaults): void {
  const keys = Object.keys(defaults);
  if (keys.length === 0) return;
  if (isRecord(defaults.metadata)) {
    for (const key of Object.keys(defaults.metadata)) {
      if (key === "user_id" || key === "projectDir") {
        throw new InvocationCompositionFailure(
          `Router defaults do not own reserved metadata.${key}`,
        );
      }
      throw new InvocationCompositionFailure(
        `Router metadata.${key} has no classified v1 policy`,
      );
    }
  }
  throw new InvocationCompositionFailure(
    `Router option ${keys[0] ?? "unknown"} has no classified v1 policy`,
  );
}

export function composeOptions(
  protocolOptions: ModelsSimpleStreamOptions,
  infrastructure: InvocationInfrastructureFacts,
  routerDefaults: RouterOptionDefaults = {},
): ModelsSimpleStreamOptions {
  validateProtocolOptions(protocolOptions);
  validateRouterDefaults(routerDefaults);
  if (infrastructure.sessionId.length === 0) {
    throw new InvocationCompositionFailure("Auth must own one non-empty sessionId");
  }

  const effective: ModelsSimpleStreamOptions = {
    sessionId: infrastructure.sessionId,
    signal: infrastructure.signal,
  };
  if (protocolOptions.maxTokens !== undefined) {
    effective.maxTokens = protocolOptions.maxTokens;
  }
  if (infrastructure.fetch !== undefined) {
    effective.fetch = infrastructure.fetch;
  }
  if (protocolOptions.temperature !== undefined) {
    effective.temperature = protocolOptions.temperature;
  }
  if (protocolOptions.reasoning !== undefined) {
    effective.reasoning = protocolOptions.reasoning;
  }

  const metadata: Record<string, unknown> = {};
  if (protocolOptions.metadata?.user_id !== undefined) {
    metadata.user_id = protocolOptions.metadata.user_id;
  }
  if (infrastructure.projectDir !== undefined) {
    metadata.projectDir = infrastructure.projectDir;
  }
  if (Object.keys(metadata).length > 0) effective.metadata = metadata;
  return effective;
}
