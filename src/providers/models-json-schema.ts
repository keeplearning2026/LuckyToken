/**
 * Extracted from `pi-agent/packages/coding-agent/src/core/model-config.ts`
 * (upstream @earendil-works/pi-coding-agent, MIT-licensed schema infra).
 *
 * Extracted as the smallest coherent subset so Token's models.json is
 * schema-compatible with the Pi ecosystem. Local modifications:
 * - `normalizePath` replaced with `node:path` `resolve`;
 * - added `loadText` for tests / callers that already hold the content.
 * No other behavior changed; keep this file in sync with upstream on update.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

const PercentileCutoffsSchema = Type.Object({
  p50: Type.Optional(Type.Number()),
  p75: Type.Optional(Type.Number()),
  p90: Type.Optional(Type.Number()),
  p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
  allow_fallbacks: Type.Optional(Type.Boolean()),
  require_parameters: Type.Optional(Type.Boolean()),
  data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
  zdr: Type.Optional(Type.Boolean()),
  enforce_distillable_text: Type.Optional(Type.Boolean()),
  order: Type.Optional(Type.Array(Type.String())),
  only: Type.Optional(Type.Array(Type.String())),
  ignore: Type.Optional(Type.Array(Type.String())),
  quantizations: Type.Optional(Type.Array(Type.String())),
  sort: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Object({
        by: Type.Optional(Type.String()),
        partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
    ]),
  ),
  max_price: Type.Optional(
    Type.Object({
      prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    }),
  ),
  preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
  preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

const VercelGatewayRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String())),
});

const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object({
  off: Type.Optional(ThinkingLevelMapValueSchema),
  minimal: Type.Optional(ThinkingLevelMapValueSchema),
  low: Type.Optional(ThinkingLevelMapValueSchema),
  medium: Type.Optional(ThinkingLevelMapValueSchema),
  high: Type.Optional(ThinkingLevelMapValueSchema),
  xhigh: Type.Optional(ThinkingLevelMapValueSchema),
  max: Type.Optional(ThinkingLevelMapValueSchema),
});

const ChatTemplateKwargScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const ChatTemplateKwargVariableSchema = Type.Object({
  $var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort")]),
  omitWhenOff: Type.Optional(Type.Boolean()),
});
const ChatTemplateKwargSchema = Type.Union([ChatTemplateKwargScalarSchema, ChatTemplateKwargVariableSchema]);

const OpenAICompletionsCompatSchema = Type.Object({
  supportsStore: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(
    Type.Union([
      Type.Literal("openai"),
      Type.Literal("openrouter"),
      Type.Literal("together"),
      Type.Literal("baseten"),
      Type.Literal("deepseek"),
      Type.Literal("zai"),
      Type.Literal("qwen"),
      Type.Literal("chat-template"),
      Type.Literal("qwen-chat-template"),
      Type.Literal("string-thinking"),
      Type.Literal("ant-ling"),
    ]),
  ),
  chatTemplateKwargs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargSchema)),
  chatTemplateArgs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargSchema)),
  cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
  openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
  vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
  supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
  supportsStrictMode: Type.Optional(Type.Boolean()),
  sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
  deferredToolsMode: Type.Optional(Type.Literal("kimi")),
  sessionAffinityFormat: Type.Optional(
    Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
  ),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  sessionAffinityFormat: Type.Optional(
    Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
  ),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
  supportsStrictMode: Type.Optional(Type.Boolean()),
  supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
  supportsAdditionalTools: Type.Optional(Type.Boolean()),
  supportsToolSearch: Type.Optional(Type.Boolean()),
});

const AnthropicMessagesCompatSchema = Type.Object({
  supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
  sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
  supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
  supportsTemperature: Type.Optional(Type.Boolean()),
  forceAdaptiveThinking: Type.Optional(Type.Boolean()),
  allowEmptySignature: Type.Optional(Type.Boolean()),
  supportsStrictTools: Type.Optional(Type.Boolean()),
  supportsToolReferences: Type.Optional(Type.Boolean()),
});

const ProviderCompatSchema = Type.Union([
  OpenAICompletionsCompatSchema,
  OpenAIResponsesCompatSchema,
  AnthropicMessagesCompatSchema,
]);

const ModelCostRatesSchema = {
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
};
const ModelCostTierSchema = Type.Object({
  inputTokensAbove: Type.Number(),
  ...ModelCostRatesSchema,
});
const ModelCostSchema = Type.Object({
  ...ModelCostRatesSchema,
  tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
});

const ModelDefinitionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  cost: Type.Optional(ModelCostSchema),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(ProviderCompatSchema),
});

const ModelOverrideSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  cost: Type.Optional(
    Type.Object({
      input: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
      cacheRead: Type.Optional(Type.Number()),
      cacheWrite: Type.Optional(Type.Number()),
      tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
    }),
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  oauth: Type.Optional(Type.Literal("radius")),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(ProviderCompatSchema),
  authHeader: Type.Optional(Type.Boolean()),
  models: Type.Optional(Type.Array(ModelDefinitionSchema)),
  modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigSchema = Type.Object({
  providers: Type.Record(Type.String(), ProviderConfigSchema),
});
const validateModelsConfig = Compile(ModelsConfigSchema);

/**
 * Schema-validate an already-parsed models.json document value (Ticket 08).
 * Errors carry actionable dotted paths (e.g. `providers.ollama.models.0.id`)
 * and never echo the offending value, so they are safe to surface verbatim
 * under the credential boundary.
 */
export function validateModelsJsonValue(
  value: unknown,
):
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>;
    } {
  if (!validateModelsConfig.Check(value)) {
    const errors = validateModelsConfig
      .Errors(value)
      .map((error) => ({
        path: formatValidationPath(error),
        message: error.message,
      }));
    return errors.length === 0
      ? {
          valid: false,
          errors: [{ path: "root", message: "Unknown schema error" }],
        }
      : { valid: false, errors: Object.freeze(errors) };
  }
  return { valid: true };
}

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;
type ModelsJson = Static<typeof ModelsConfigSchema>;

function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
    const requiredProperty = requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** One immutable load of models.json. */
export class ModelConfig {
  private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
  private readonly error: string | undefined;

  private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
    this.providers = providers;
    this.error = error;
  }

  static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
    if (!modelsJsonPath) return new ModelConfig(new Map());
    const path = resolve(modelsJsonPath);
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
      return new ModelConfig(
        new Map(),
        `Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
      );
    }
    return ModelConfig.parse(content);
  }

  /** Parse models.json from an in-memory string (Token addition). */
  static parse(content: string): ModelConfig {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(content));
    } catch (error) {
      return new ModelConfig(
        new Map(),
        `Failed to parse models.json: ${error instanceof Error ? error.message : error}`,
      );
    }

    if (!validateModelsConfig.Check(parsed)) {
      const errors =
        validateModelsConfig
          .Errors(parsed)
          .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
          .join("\n") || "Unknown schema error";
      return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}`);
    }

    const config = parsed as ModelsJson;
    const providers = new Map<string, ModelsJsonProvider>();
    for (const [providerId, provider] of Object.entries(config.providers)) {
      providers.set(providerId, deepFreeze(structuredClone(provider)));
    }
    return new ModelConfig(providers);
  }

  getProvider(providerId: string): ModelsJsonProvider | undefined {
    return this.providers.get(providerId);
  }

  getProviderIds(): readonly string[] {
    return [...this.providers.keys()];
  }

  getError(): string | undefined {
    return this.error;
  }
}
