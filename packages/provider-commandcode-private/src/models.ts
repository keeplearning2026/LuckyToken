import type { Model } from "@earendil-works/pi-ai";

import {
  COMMANDCODE_API_ID,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_PROVIDER_ID,
} from "./constants.js";

/**
 * CommandCode built-in model catalog.
 *
 * Authoritative source: `doc/# CommandCode 1.9.0 模型信息表.md` (static
 * analysis of the official command-code@1.9.0 bundle). Model ids, context
 * windows, per-1M-token USD pricing, input modalities, and reasoning effort
 * support all come from that file. Models with no listed reasoning effort
 * keep a full-effort map so `mapReasoningLevel` fallbacks still apply.
 * Update this file to add/change models; there is no runtime fetch.
 */

export interface CommandCodeModelSource {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly inputCost: number;
  readonly outputCost: number;
  readonly cacheReadCost: number;
  readonly cacheWriteCost: number;
  readonly text: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  /** Official reasoning effort support (e.g. ["high","max"]); empty = full. */
  readonly reasoningEfforts?: readonly string[];
  /** Official per-model output limit when the bundled catalog declares one. */
  readonly maxOutputTokens?: number;
}

function price(value: string): number {
  if (value === "—" || value === "Free" || value === "free") return 0;
  // Strip a "+N" usage multiplier suffix and a secondary discounted price,
  // then parse the primary USD figure.
  const primary = value.split("+")[0]?.split("$").find((part) => part.length > 0);
  const numeric = Number.parseFloat(primary ?? "");
  return Number.isFinite(numeric) ? numeric : 0;
}

function buildModel(
  source: CommandCodeModelSource,
): Model<typeof COMMANDCODE_API_ID> {
  const input: Array<"text" | "image"> = [];
  if (source.text) input.push("text");
  if (source.vision) input.push("image");
  Object.freeze(input);
  const cost = Object.freeze({
    input: source.inputCost,
    output: source.outputCost,
    cacheRead: source.cacheReadCost,
    cacheWrite: source.cacheWriteCost,
  });
  const thinkingLevelMap: Record<string, string | null> = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  for (const effort of source.reasoningEfforts ?? [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    thinkingLevelMap[effort] = effort;
  }
  return Object.freeze({
    id: source.id,
    name: source.name,
    api: COMMANDCODE_API_ID,
    provider: COMMANDCODE_PROVIDER_ID,
    baseUrl: COMMANDCODE_BASE_URL,
    reasoning: source.reasoning,
    ...(source.reasoning ? { thinkingLevelMap: Object.freeze(thinkingLevelMap) } : {}),
    input,
    cost,
    contextWindow: source.contextWindow,
    maxTokens: source.maxOutputTokens ?? 64_000,
  });
}

function model(
  id: string,
  name: string,
  contextWindow: number,
  inputCost: string,
  outputCost: string,
  cacheReadCost: string,
  cacheWriteCost: string,
  caps: string,
  reasoningEfforts?: string,
  maxOutputTokens?: number,
): CommandCodeModelSource {
  return {
    id,
    name,
    contextWindow,
    inputCost: price(inputCost),
    outputCost: price(outputCost),
    cacheReadCost: price(cacheReadCost),
    cacheWriteCost: price(cacheWriteCost),
    text: caps.includes("T"),
    vision: caps.includes("V"),
    reasoning: caps.includes("R"),
    ...(reasoningEfforts === undefined
      ? {}
      : {
          reasoningEfforts: reasoningEfforts
            .split("/")
            .map((entry) => entry.trim()),
        }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export const COMMANDCODE_MODEL_SOURCES: readonly CommandCodeModelSource[] = Object.freeze([
  model("meta/muse-spark-1.2", "Muse Spark 1.2", 1_000_000, "$1.25", "$4.25", "$0.15", "—", "T/V/R"),
  model("meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 1_000_000, "$0.10", "$0.20", "$0.002", "—", "T/V"),
  model("Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1_000_000, "$2.00", "$6.00", "$0.25", "$2.50", "T/V/R", "low/medium/xhigh"),
  model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (latest)", 1_000_000, "$0.14", "$0.28", "$0.0028", "—", "T/R", "high/max"),
  model("thinkingmachines/inkling-small", "Inkling Small", 1_000_000, "$0.50", "$1.20", "$0.10", "—", "T/V/R"),
  model("Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1_000_000, "$0.03", "$0.13", "$0.006", "$0.038", "T/V/R"),
  model("poolside/laguna-s-2.1-free", "Laguna S 2.1", 256_000, "Free", "Free", "Free", "—", "T/R", undefined, 32_000),
  model("thinkingmachines/inkling", "Inkling", 256_000, "$1.00", "$4.05", "$0.17", "—", "RTV"),
  model("moonshotai/Kimi-K3", "Kimi K3", 1_000_000, "$3.00", "$15.00", "$0.30", "—", "T/V/R"),
  model("gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000, "$0.10", "$0.60", "$0.01", "$0.125", "T/V/R", "low/medium/high/xhigh/max"),
  model("xai/grok-4.5", "Grok 4.5", 500_000, "$2.00", "$6.00", "$0.50", "—", "T/V/R", "low/medium/high"),
  model("tencent/hy3-paid", "Tencent Hy3", 262_000, "$0.14", "$0.58", "$0.035", "—", "T/R"),
  model("zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1_000_000, "$3.00", "$10.25", "$0.50", "—", "T"),
  model("zai-org/GLM-5.2", "GLM-5.2", 1_000_000, "$1.40", "$4.40", "$0.26", "—", "T/R", "high/max"),
  model("moonshotai/Kimi-K2.7-Code-Highspeed", "Kimi K2.7 Code HighSpeed", 262_000, "$1.90", "$8.00", "$0.38", "—", "T/V/R"),
  model("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256_000, "$0.95", "$4.00", "$0.19", "—", "T/V/R"),
  model("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1_000_000, "$0.60", "$2.40", "$0.12", "—", "T/R"),
  model("MiniMaxAI/MiniMax-M3", "MiniMax M3", 1_000_000, "$0.30", "$1.20", "$0.06", "—", "T/V/R"),
  model("Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1_000_000, "$0.40", "$1.60", "$0.08", "$0.50", "T/V/R"),
  model("stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256_000, "$0.20", "$1.15", "$0.04", "—", "T/V/R"),
  model("xiaomi/mimo-v2.5", "MiMo V2.5", 1_000_000, "$0.14", "$0.28", "$0.0028", "—", "T/V"),
  model("xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000, "$0.435", "$0.87", "$0.0036", "—", "T"),
  model("Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1_000_000, "$2.50", "$7.50", "$0.50", "$3.13", "T/R"),
  model("stepfun/Step-3.5-Flash", "Step 3.5 Flash", 1_000_000, "$0.10", "$0.30", "$0.02", "—", "T/R"),
  model("zai-org/GLM-5.1", "GLM-5.1", 200_000, "$1.40", "$4.40", "$0.26", "—", "T"),
  model("MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200_000, "$0.30", "$1.20", "$0.06", "—", "T"),
  model("Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200_000, "$1.30", "$7.80", "$0.26", "$1.63", "T/R"),
  model("Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200_000, "$0.50", "$3.00", "$0.10", "—", "T/V/R"),
  model("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, "$0.435", "$0.87", "$0.003625", "—", "T/R", "high/max"),
  model("moonshotai/Kimi-K2.6", "Kimi K2.6", 256_000, "$0.95", "$4.00", "$0.16", "—", "T/V"),
  model("zai-org/GLM-5", "GLM-5", 200_000, "$0.80", "$2.56", "$0.16", "—", "T"),
  model("moonshotai/Kimi-K2.5", "Kimi K2.5", 256_000, "$0.60", "$3.00", "$0.10", "—", "T/V"),
  model("MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200_000, "$0.30", "$1.20", "$0.03", "—", "T"),
]);

function buildCatalog(
  sources: readonly CommandCodeModelSource[],
): readonly Model<typeof COMMANDCODE_API_ID>[] {
  return sources.map(buildModel);
}

export const COMMANDCODE_MODELS: readonly Model<typeof COMMANDCODE_API_ID>[] =
  Object.freeze(buildCatalog(COMMANDCODE_MODEL_SOURCES));


export function findCommandCodeModel(
  id: string,
): Model<typeof COMMANDCODE_API_ID> | undefined {
  return COMMANDCODE_MODELS.find((entry) => entry.id === id);
}
