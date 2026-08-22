import type { Api, Model } from "@earendil-works/pi-ai";

interface CommandCodeModelCapability {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly text: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly reasoningEfforts?: readonly string[];
  readonly maxOutputTokens?: number;
}

export interface CommandCodeModelProjection<TApi extends Api> {
  readonly provider: string;
  readonly api: TApi;
  readonly baseUrl: string;
}

const UNTRACKED_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

function capability(
  id: string,
  name: string,
  contextWindow: number,
  caps: string,
  reasoningEfforts?: string,
  maxOutputTokens?: number,
): CommandCodeModelCapability {
  return Object.freeze({
    id,
    name,
    contextWindow,
    text: caps.includes("T"),
    vision: caps.includes("V"),
    reasoning: caps.includes("R"),
    ...(reasoningEfforts === undefined
      ? {}
      : {
          reasoningEfforts: Object.freeze(
            reasoningEfforts.split("/").map((entry) => entry.trim()),
          ),
        }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
}

/**
 * Stable model capability facts shared by the CommandCode integrations.
 *
 * Pricing is intentionally absent because it changes independently of model
 * capabilities and LuckyToken has no live pricing authority.
 */
const COMMANDCODE_MODEL_CAPABILITIES: readonly CommandCodeModelCapability[] =
  Object.freeze([
    capability("meta/muse-spark-1.2", "Muse Spark 1.2", 1_000_000, "T/V/R"),
    capability("meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 1_000_000, "T/V"),
    capability("Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1_000_000, "T/V/R", "low/medium/xhigh"),
    capability("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (latest)", 1_000_000, "T/R", "high/max"),
    capability("thinkingmachines/inkling-small", "Inkling Small", 1_000_000, "T/V/R"),
    capability("Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1_000_000, "T/V/R"),
    capability("poolside/laguna-s-2.1-free", "Laguna S 2.1", 256_000, "T/R", undefined, 32_000),
    capability("thinkingmachines/inkling", "Inkling", 256_000, "RTV"),
    capability("moonshotai/Kimi-K3", "Kimi K3", 1_000_000, "T/V/R"),
    capability("gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000, "T/V/R", "low/medium/high/xhigh/max"),
    capability("xai/grok-4.5", "Grok 4.5", 500_000, "T/V/R", "low/medium/high"),
    capability("tencent/hy3-paid", "Tencent Hy3", 262_000, "T/R"),
    capability("zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1_000_000, "T"),
    capability("zai-org/GLM-5.2", "GLM-5.2", 1_000_000, "T/R", "high/max"),
    capability("moonshotai/Kimi-K2.7-Code-Highspeed", "Kimi K2.7 Code HighSpeed", 262_000, "T/V/R"),
    capability("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256_000, "T/V/R"),
    capability("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1_000_000, "T/R"),
    capability("MiniMaxAI/MiniMax-M3", "MiniMax M3", 1_000_000, "T/V/R"),
    capability("Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1_000_000, "T/V/R"),
    capability("stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256_000, "T/V/R"),
    capability("xiaomi/mimo-v2.5", "MiMo V2.5", 1_000_000, "T/V"),
    capability("xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000, "T"),
    capability("Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1_000_000, "T/R"),
    capability("stepfun/Step-3.5-Flash", "Step 3.5 Flash", 1_000_000, "T/R"),
    capability("zai-org/GLM-5.1", "GLM-5.1", 200_000, "T"),
    capability("MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200_000, "T"),
    capability("Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200_000, "T/R"),
    capability("Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200_000, "T/V/R"),
    capability("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, "T/R", "high/max"),
    capability("moonshotai/Kimi-K2.6", "Kimi K2.6", 256_000, "T/V"),
    capability("zai-org/GLM-5", "GLM-5", 200_000, "T"),
    capability("moonshotai/Kimi-K2.5", "Kimi K2.5", 256_000, "T/V"),
    capability("MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200_000, "T"),
  ]);

function buildThinkingLevelMap(
  capability: CommandCodeModelCapability,
): Readonly<Record<string, string | null>> | undefined {
  if (!capability.reasoning) return undefined;
  const result: Record<string, string | null> = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  for (const effort of capability.reasoningEfforts ?? [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    result[effort] = effort;
  }
  return Object.freeze(result);
}

function projectModel<TApi extends Api>(
  capability: CommandCodeModelCapability,
  projection: CommandCodeModelProjection<TApi>,
): Model<TApi> {
  const input: Array<"text" | "image"> = [];
  if (capability.text) input.push("text");
  if (capability.vision) input.push("image");
  Object.freeze(input);
  const thinkingLevelMap = buildThinkingLevelMap(capability);
  return Object.freeze({
    id: capability.id,
    name: capability.name,
    api: projection.api,
    provider: projection.provider,
    baseUrl: projection.baseUrl,
    reasoning: capability.reasoning,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    input,
    cost: UNTRACKED_COST,
    contextWindow: capability.contextWindow,
    maxTokens: capability.maxOutputTokens ?? 64_000,
  });
}

export function createCommandCodeModelCatalog<TApi extends Api>(
  projection: CommandCodeModelProjection<TApi>,
): readonly Model<TApi>[] {
  return Object.freeze(
    COMMANDCODE_MODEL_CAPABILITIES.map((entry) =>
      projectModel(entry, projection),
    ),
  );
}
