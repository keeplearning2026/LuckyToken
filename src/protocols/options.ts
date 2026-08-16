import type {
  Api,
  AuthResult,
  Model,
  ModelsSimpleStreamOptions,
  ProviderHeaders,
} from "@earendil-works/pi-ai";

/**
 * Narrow Pi-typed request-local model derivation (Ticket 10): the
 * composition root wires the Provider/request-composition implementation
 * here, so Client Protocol modules never import Provider configuration
 * code. The safe default is identity — a handler without a wired resolver
 * performs no Provider-side transformation (models without request-local
 * baseUrl facts are passed through unchanged).
 */
export type RequestModelResolver = (
  model: Model<Api>,
  resolution: AuthResult | undefined,
) => Model<Api>;

/** Safe default: no request-local transformation. */
export const identityRequestModelResolver: RequestModelResolver = (
  model,
) => model;

export class InvocationCompositionFailure extends Error {
  readonly kind = "InvocationCompositionFailure";

  constructor(message: string) {
    super(message);
    this.name = "InvocationCompositionFailure";
  }
}

/**
 * Pi semantic facts a Client Protocol may produce. Source-wire names and
 * infrastructure authority end before this contract.
 */
export interface ClientPiOptions {
  readonly maxTokens?: ModelsSimpleStreamOptions["maxTokens"];
  readonly temperature?: ModelsSimpleStreamOptions["temperature"];
  readonly reasoning?: ModelsSimpleStreamOptions["reasoning"];
  readonly samplingParams?: Readonly<Record<string, unknown>>;
  readonly cacheRetention?: ModelsSimpleStreamOptions["cacheRetention"];
  readonly thinkingBudgets?: Readonly<
    NonNullable<ModelsSimpleStreamOptions["thinkingBudgets"]>
  >;
  readonly metadata?: Readonly<{ user_id?: string }>;
}

export interface InvocationInfrastructureFacts {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly apiKey?: string;
  readonly projectDir?: string;
  readonly telemetryContext?: ModelsSimpleStreamOptions["telemetryContext"];
  readonly env?: ModelsSimpleStreamOptions["env"];
  readonly headers?: ProviderHeaders;
  readonly transport?: ModelsSimpleStreamOptions["transport"];
  readonly timeoutMs?: number;
  readonly websocketConnectTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxRetryDelayMs?: number;
  readonly onPayload?: ModelsSimpleStreamOptions["onPayload"];
  readonly onResponse?: ModelsSimpleStreamOptions["onResponse"];
  readonly transformHeaders?: ModelsSimpleStreamOptions["transformHeaders"];
}

export type RouterOptionDefaults = Readonly<Record<string, unknown>>;

const PROTOCOL_OPTION_KEYS = new Set([
  "maxTokens",
  "temperature",
  "reasoning",
  "samplingParams",
  "cacheRetention",
  "thinkingBudgets",
  "metadata",
]);
const PROTOCOL_METADATA_KEYS = new Set(["user_id"]);
const INFRASTRUCTURE_KEYS = new Set([
  "sessionId",
  "signal",
  "projectDir",
  "apiKey",
  "telemetryContext",
  "env",
  "headers",
  "transport",
  "timeoutMs",
  "websocketConnectTimeoutMs",
  "maxRetries",
  "maxRetryDelayMs",
  "onPayload",
  "onResponse",
  "transformHeaders",
]);
const THINKING_LEVELS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const THINKING_BUDGET_KEYS = new Set(["minimal", "low", "medium", "high"]);
const CACHE_RETENTIONS = new Set(["none", "short", "long"]);
const TRANSPORTS = new Set(["sse", "websocket", "websocket-cached", "auto"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneAndFreezeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezeValue(entry)));
  }
  if (isRecord(value)) {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneAndFreezeValue(entry)]),
    );
    return Object.freeze(clone);
  }
  return value;
}

function validateSnapshotValue(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvocationCompositionFailure(`${path} must contain only finite numbers`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new InvocationCompositionFailure(`${path} must not contain cycles`);
    }
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new InvocationCompositionFailure(`${path} must not contain sparse arrays`);
      }
      validateSnapshotValue(value[index], `${path}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) {
      throw new InvocationCompositionFailure(`${path} must not contain cycles`);
    }
    ancestors.add(value);
    for (const [key, entry] of Object.entries(value)) {
      validateSnapshotValue(entry, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  throw new InvocationCompositionFailure(`${path} must contain immutable JSON values`);
}

function validateSamplingParams(value: unknown): void {
  if (!isRecord(value)) {
    throw new InvocationCompositionFailure("samplingParams must be an object");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || entry === undefined) {
      throw new InvocationCompositionFailure(`samplingParams.${key || "<empty>"} is invalid`);
    }
    validateSnapshotValue(entry, `samplingParams.${key}`);
  }
}

function validateThinkingBudgets(value: unknown): void {
  if (!isRecord(value)) {
    throw new InvocationCompositionFailure("thinkingBudgets must be an object");
  }
  for (const [key, budget] of Object.entries(value)) {
    if (!THINKING_BUDGET_KEYS.has(key)) {
      throw new InvocationCompositionFailure(`Unknown thinkingBudgets.${key}`);
    }
    if (!Number.isSafeInteger(budget) || (budget as number) <= 0) {
      throw new InvocationCompositionFailure(
        `thinkingBudgets.${key} must be a positive safe integer`,
      );
    }
  }
}

function validateProtocolOptions(options: ClientPiOptions): void {
  if (!isRecord(options)) {
    throw new InvocationCompositionFailure("Client Protocol options must be an object");
  }
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
    (typeof options.reasoning !== "string" ||
      !THINKING_LEVELS.has(options.reasoning))
  ) {
    throw new InvocationCompositionFailure(
      "Client Protocol reasoning must be a known thinking level",
    );
  }
  if (options.samplingParams !== undefined) {
    validateSamplingParams(options.samplingParams);
  }
  if (
    options.cacheRetention !== undefined &&
    (typeof options.cacheRetention !== "string" ||
      !CACHE_RETENTIONS.has(options.cacheRetention))
  ) {
    throw new InvocationCompositionFailure("cacheRetention must be none, short, or long");
  }
  if (options.thinkingBudgets !== undefined) {
    validateThinkingBudgets(options.thinkingBudgets);
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

function validateInfrastructure(infrastructure: InvocationInfrastructureFacts): void {
  if (!isRecord(infrastructure)) {
    throw new InvocationCompositionFailure("Infrastructure facts must be an object");
  }
  for (const key of Object.keys(infrastructure)) {
    if (!INFRASTRUCTURE_KEYS.has(key)) {
      throw new InvocationCompositionFailure(`Unknown infrastructure fact: ${key}`);
    }
  }
  if (typeof infrastructure.sessionId !== "string" || infrastructure.sessionId.length === 0) {
    throw new InvocationCompositionFailure("Auth must own one non-empty sessionId");
  }
  if (
    typeof infrastructure.signal !== "object" ||
    infrastructure.signal === null ||
    typeof infrastructure.signal.aborted !== "boolean" ||
    typeof infrastructure.signal.addEventListener !== "function"
  ) {
    throw new InvocationCompositionFailure("HTTP lifecycle must own one AbortSignal");
  }
  if (infrastructure.projectDir !== undefined && typeof infrastructure.projectDir !== "string") {
    throw new InvocationCompositionFailure("Infrastructure projectDir must be a string");
  }
  if (
    infrastructure.apiKey !== undefined &&
    (typeof infrastructure.apiKey !== "string" || infrastructure.apiKey.length === 0)
  ) {
    throw new InvocationCompositionFailure("Infrastructure apiKey must be a non-empty string");
  }
  for (const [key, value, minimum] of [
    ["timeoutMs", infrastructure.timeoutMs, 1],
    ["websocketConnectTimeoutMs", infrastructure.websocketConnectTimeoutMs, 1],
    ["maxRetryDelayMs", infrastructure.maxRetryDelayMs, 0],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < minimum || value > MAX_TIMER_DELAY_MS)
    ) {
      throw new InvocationCompositionFailure(
        `${key} must be an integer from ${minimum} through ${MAX_TIMER_DELAY_MS}`,
      );
    }
  }
  if (
    infrastructure.maxRetries !== undefined &&
    (!Number.isSafeInteger(infrastructure.maxRetries) || infrastructure.maxRetries < 0)
  ) {
    throw new InvocationCompositionFailure("maxRetries must be a non-negative safe integer");
  }
  if (infrastructure.headers !== undefined) {
    if (!isRecord(infrastructure.headers)) {
      throw new InvocationCompositionFailure("Infrastructure headers must be an object");
    }
    for (const [name, value] of Object.entries(infrastructure.headers)) {
      if (name.length === 0 || (typeof value !== "string" && value !== null)) {
        throw new InvocationCompositionFailure(`Infrastructure header ${name || "<empty>"} is invalid`);
      }
    }
  }
  if (infrastructure.env !== undefined) {
    if (!isRecord(infrastructure.env)) {
      throw new InvocationCompositionFailure("Infrastructure env must be an object");
    }
    for (const [name, value] of Object.entries(infrastructure.env)) {
      if (name.length === 0 || typeof value !== "string") {
        throw new InvocationCompositionFailure(
          `Infrastructure environment value ${name || "<empty>"} is invalid`,
        );
      }
    }
  }
  if (
    infrastructure.transport !== undefined &&
    (typeof infrastructure.transport !== "string" ||
      !TRANSPORTS.has(infrastructure.transport))
  ) {
    throw new InvocationCompositionFailure("Infrastructure transport is invalid");
  }
  if (
    infrastructure.telemetryContext !== undefined &&
    (typeof infrastructure.telemetryContext !== "object" ||
      infrastructure.telemetryContext === null ||
      typeof infrastructure.telemetryContext.startSpan !== "function")
  ) {
    throw new InvocationCompositionFailure("Infrastructure telemetryContext is invalid");
  }
  for (const [key, callback] of [
    ["onPayload", infrastructure.onPayload],
    ["onResponse", infrastructure.onResponse],
    ["transformHeaders", infrastructure.transformHeaders],
  ] as const) {
    if (callback !== undefined && typeof callback !== "function") {
      throw new InvocationCompositionFailure(`Infrastructure ${key} must be a function`);
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
  protocolOptions: ClientPiOptions,
  infrastructure: InvocationInfrastructureFacts,
  routerDefaults: RouterOptionDefaults = {},
): ModelsSimpleStreamOptions {
  validateProtocolOptions(protocolOptions);
  validateRouterDefaults(routerDefaults);
  validateInfrastructure(infrastructure);

  const effective: ModelsSimpleStreamOptions = {
    sessionId: infrastructure.sessionId,
    signal: infrastructure.signal,
  };
  if (infrastructure.apiKey !== undefined) effective.apiKey = infrastructure.apiKey;
  if (protocolOptions.maxTokens !== undefined) {
    effective.maxTokens = protocolOptions.maxTokens;
  }
  if (infrastructure.telemetryContext !== undefined) {
    effective.telemetryContext = infrastructure.telemetryContext;
  }
  if (infrastructure.env !== undefined) {
    effective.env = cloneAndFreezeValue(infrastructure.env) as NonNullable<
      ModelsSimpleStreamOptions["env"]
    >;
  }
  if (infrastructure.headers !== undefined) {
    effective.headers = cloneAndFreezeValue(infrastructure.headers) as ProviderHeaders;
  }
  if (infrastructure.transport !== undefined) effective.transport = infrastructure.transport;
  if (infrastructure.timeoutMs !== undefined) effective.timeoutMs = infrastructure.timeoutMs;
  if (infrastructure.websocketConnectTimeoutMs !== undefined) {
    effective.websocketConnectTimeoutMs = infrastructure.websocketConnectTimeoutMs;
  }
  if (infrastructure.maxRetries !== undefined) effective.maxRetries = infrastructure.maxRetries;
  if (infrastructure.maxRetryDelayMs !== undefined) {
    effective.maxRetryDelayMs = infrastructure.maxRetryDelayMs;
  }
  if (infrastructure.onPayload !== undefined) effective.onPayload = infrastructure.onPayload;
  if (infrastructure.onResponse !== undefined) effective.onResponse = infrastructure.onResponse;
  if (infrastructure.transformHeaders !== undefined) {
    effective.transformHeaders = infrastructure.transformHeaders;
  }
  if (protocolOptions.temperature !== undefined) {
    effective.temperature = protocolOptions.temperature;
  }
  if (protocolOptions.reasoning !== undefined) {
    effective.reasoning = protocolOptions.reasoning;
  }
  if (protocolOptions.samplingParams !== undefined) {
    effective.samplingParams = cloneAndFreezeValue(
      protocolOptions.samplingParams,
    ) as Record<string, unknown>;
  }
  if (protocolOptions.cacheRetention !== undefined) {
    effective.cacheRetention = protocolOptions.cacheRetention;
  }
  if (protocolOptions.thinkingBudgets !== undefined) {
    effective.thinkingBudgets = cloneAndFreezeValue(
      protocolOptions.thinkingBudgets,
    ) as NonNullable<ModelsSimpleStreamOptions["thinkingBudgets"]>;
  }

  const metadata: Record<string, unknown> = {};
  if (protocolOptions.metadata?.user_id !== undefined) {
    metadata.user_id = protocolOptions.metadata.user_id;
  }
  if (infrastructure.projectDir !== undefined) {
    metadata.projectDir = infrastructure.projectDir;
  }
  if (Object.keys(metadata).length > 0) {
    effective.metadata = cloneAndFreezeValue(metadata) as Record<string, unknown>;
  }
  return Object.freeze(effective);
}
