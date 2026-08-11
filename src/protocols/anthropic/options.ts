import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

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
}

export type RouterOptionDefaults = Readonly<Record<string, unknown>>;

const PROTOCOL_OPTION_KEYS = new Set(["maxTokens", "temperature", "metadata"]);
const PROTOCOL_METADATA_KEYS = new Set(["user_id"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProtocolOptions(options: ModelsSimpleStreamOptions): void {
  for (const key of Object.keys(options)) {
    if (!PROTOCOL_OPTION_KEYS.has(key)) {
      throw new InvocationCompositionFailure(
        `Anthropic protocol options do not own Pi option: ${key}`,
      );
    }
  }
  if (
    !Number.isSafeInteger(options.maxTokens) ||
    (options.maxTokens as number) <= 0
  ) {
    throw new InvocationCompositionFailure(
      "Anthropic protocol maxTokens must remain a positive safe integer",
    );
  }
  if (
    options.temperature !== undefined &&
    (typeof options.temperature !== "number" ||
      !Number.isFinite(options.temperature))
  ) {
    throw new InvocationCompositionFailure(
      "Anthropic protocol temperature must remain finite",
    );
  }
  if (options.metadata !== undefined) {
    if (!isRecord(options.metadata)) {
      throw new InvocationCompositionFailure("Protocol metadata must be an object");
    }
    for (const key of Object.keys(options.metadata)) {
      if (!PROTOCOL_METADATA_KEYS.has(key)) {
        throw new InvocationCompositionFailure(
          `Anthropic Client Protocol does not own metadata.${key}`,
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
    maxTokens: protocolOptions.maxTokens as number,
    sessionId: infrastructure.sessionId,
    signal: infrastructure.signal,
  };
  if (protocolOptions.temperature !== undefined) {
    effective.temperature = protocolOptions.temperature;
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
