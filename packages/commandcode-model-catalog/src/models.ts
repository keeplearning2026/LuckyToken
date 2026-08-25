export type CommandCodePlan = "go" | "goat" | "pro" | "max";

export type CommandCodeReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type CommandCodeThinkingLevel =
  | "off"
  | "minimal"
  | CommandCodeReasoningEffort;

export type CommandCodeThinkingLevelMap = Readonly<
  Record<CommandCodeThinkingLevel, string | null>
>;

export interface CommandCodeModelFacts {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input: readonly ("text" | "image")[];
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: CommandCodeThinkingLevelMap;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly minimumPlan: CommandCodePlan;
}

const explicitThinkingLevelMap = (
  values: Omit<CommandCodeThinkingLevelMap, "off" | "minimal">,
): CommandCodeThinkingLevelMap =>
  Object.freeze({ off: null, minimal: null, ...values });

const NO_SELECTABLE_THINKING_LEVELS = explicitThinkingLevelMap({
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
});
const LOW_MEDIUM_HIGH = explicitThinkingLevelMap({
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
});
const LOW_MEDIUM_HIGH_XHIGH = explicitThinkingLevelMap({
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
});
const LOW_MEDIUM_HIGH_XHIGH_MAX = explicitThinkingLevelMap({
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});
const HIGH_MAX = explicitThinkingLevelMap({
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
});
const LOW_HIGH_MAX = explicitThinkingLevelMap({
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
});
const LOW_MEDIUM_XHIGH = explicitThinkingLevelMap({
  low: "low",
  medium: "medium",
  high: null,
  xhigh: "xhigh",
  max: null,
});
const HIGH_XHIGH = explicitThinkingLevelMap({
  low: null,
  medium: null,
  high: "high",
  xhigh: "xhigh",
  max: null,
});

function freezeAndValidateFacts(
  values: readonly CommandCodeModelFacts[],
): readonly CommandCodeModelFacts[] {
  const ids = new Set<string>();
  return Object.freeze(
    values.map((value) => {
      if (value.id.length === 0 || ids.has(value.id)) {
        throw new Error(`CommandCode model id must be non-empty and unique: ${value.id}`);
      }
      ids.add(value.id);
      if (value.name.length === 0 || value.description.length === 0) {
        throw new Error(`CommandCode model ${value.id} must have a name and description`);
      }
      if (value.input.length === 0 || new Set(value.input).size !== value.input.length) {
        throw new Error(`CommandCode model ${value.id} must have unique input modalities`);
      }
      if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0) {
        throw new Error(`CommandCode model ${value.id} must have a positive context window`);
      }
      if (
        value.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens <= 0)
      ) {
        throw new Error(`CommandCode model ${value.id} must have a positive max output`);
      }
      if (!value.reasoning && value.thinkingLevelMap !== undefined) {
        throw new Error(`CommandCode model ${value.id} cannot declare levels without reasoning`);
      }
      if (value.reasoning && value.thinkingLevelMap === undefined) {
        throw new Error(`CommandCode reasoning model ${value.id} requires an explicit level map`);
      }
      if (value.thinkingLevelMap !== undefined) {
        const keys = Object.keys(value.thinkingLevelMap);
        if (
          keys.join(",") !== "off,minimal,low,medium,high,xhigh,max" ||
          Object.values(value.thinkingLevelMap).some(
            (mapped) => mapped !== null && typeof mapped !== "string",
          )
        ) {
          throw new Error(`CommandCode model ${value.id} has an incomplete level map`);
        }
      }
      return Object.freeze({
        ...value,
        input: Object.freeze([...value.input]),
      });
    }),
  );
}

/** Current CommandCode model facts, independent of any Pi Provider projection. */
export const COMMANDCODE_MODEL_FACTS: readonly CommandCodeModelFacts[] =
  freezeAndValidateFacts([
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      description: "best combo of speed & intelligence (recommended)",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "pro",
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      description: "prev Sonnet, still fast & capable",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "pro",
    },
    {
      id: "claude-fable-5",
      name: "Claude Fable 5",
      description: "most capable for demanding reasoning & long-horizon agents",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "max",
    },
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      description: "most intelligent Opus for agents and coding",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "max",
    },
    {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      description: "prev flagship, still strong for agents and coding",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "max",
    },
    {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      description: "older Opus, still strong for agents and coding",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "max",
    },
    {
      id: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      description: "fastest & most compact, great for quick tasks",
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 200_000,
      minimumPlan: "pro",
    },
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      description: "frontier model for complex professional work",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_050_000,
      minimumPlan: "goat",
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      description: "balances intelligence and cost",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_050_000,
      minimumPlan: "pro",
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      description: "optimized for cost-sensitive workloads",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH_MAX,
      contextWindow: 1_050_000,
      minimumPlan: "go",
    },
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      description: "latest frontier model for general complex work",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH,
      contextWindow: 400_000,
      minimumPlan: "pro",
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      description: "frontier model for general complex work",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH,
      contextWindow: 400_000,
      minimumPlan: "pro",
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      description: "frontier coding model",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH,
      contextWindow: 400_000,
      minimumPlan: "pro",
    },
    {
      id: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      description: "fast, cost-effective model for everyday tasks",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH,
      contextWindow: 400_000,
      minimumPlan: "pro",
    },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro (latest)",
      description: "hybrid-attention long-context reasoning",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: HIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash (latest)",
      description: "fast hybrid-attention reasoning",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: HIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "deepseek/deepseek-v4-flash-vision-exp",
      name: "DeepSeek V4 Flash Vision (exp)",
      description: "fast hybrid-attention reasoning with vision",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: HIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "moonshotai/Kimi-K3",
      name: "Kimi K3",
      description: "long-horizon coding & knowledge work with 1M context",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "moonshotai/Kimi-K2.7-Code",
      name: "Kimi K2.7 Code",
      description: "improved long-horizon coding with vision",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 256_000,
      minimumPlan: "go",
    },
    {
      id: "moonshotai/Kimi-K2.7-Code-Highspeed",
      name: "Kimi K2.7 Code HighSpeed",
      description: "high-speed long-horizon coding with vision",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 262_000,
      minimumPlan: "go",
    },
    {
      id: "moonshotai/Kimi-K2.6",
      name: "Kimi K2.6",
      description: "long-horizon coding with vision",
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 256_000,
      minimumPlan: "go",
    },
    {
      id: "moonshotai/Kimi-K2.5",
      name: "Kimi K2.5",
      description: "multimodal frontend coding",
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 256_000,
      minimumPlan: "go",
    },
    {
      id: "zai-org/GLM-5.3",
      name: "GLM-5.3",
      description: "frontier coding with emergent cyber capabilities",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: LOW_HIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "zai-org/GLM-5.2",
      name: "GLM-5.2",
      description: "powerful coding with 1M context and long-horizon tasks",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: HIGH_MAX,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "zai-org/GLM-5.2-Fast",
      name: "GLM-5.2 Fast",
      description: "high-throughput GLM-5.2 with 1M context",
      input: ["text"],
      reasoning: false,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "zai-org/GLM-5.1",
      name: "GLM-5.1",
      description: "long-horizon autonomous coding agent",
      input: ["text"],
      reasoning: false,
      contextWindow: 200_000,
      minimumPlan: "go",
    },
    {
      id: "zai-org/GLM-5",
      name: "GLM-5",
      description: "multi-mode thinking & long-range planning",
      input: ["text"],
      reasoning: false,
      contextWindow: 200_000,
      minimumPlan: "go",
    },
    {
      id: "MiniMaxAI/MiniMax-M3",
      name: "MiniMax M3",
      description: "frontier coding, agents & native multimodality",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "MiniMaxAI/MiniMax-M2.7",
      name: "MiniMax M2.7",
      description: "end-to-end software engineering agent",
      input: ["text"],
      reasoning: false,
      contextWindow: 200_000,
      minimumPlan: "go",
    },
    {
      id: "MiniMaxAI/MiniMax-M2.5",
      name: "MiniMax M2.5",
      description: "cross-platform full-stack agentic dev",
      input: ["text"],
      reasoning: false,
      contextWindow: 200_000,
      minimumPlan: "go",
    },
    {
      id: "xiaomi/mimo-v2.5-pro",
      name: "MiMo V2.5 Pro",
      description: "high-capability long-context agentic coding",
      input: ["text"],
      reasoning: false,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "xiaomi/mimo-v2.5",
      name: "MiMo V2.5",
      description: "efficient long-context agentic coding",
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "Qwen/Qwen3.8-Max",
      name: "Qwen 3.8 Max",
      description: "autonomous long-horizon coding & professional work",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_XHIGH,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "Qwen/Qwen3.8-27B",
      name: "Qwen 3.8 27B",
      description: "compact vision-language coding & agentic work",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_XHIGH,
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      minimumPlan: "go",
    },
    {
      id: "Qwen/Qwen3.7-Max",
      name: "Qwen 3.7 Max",
      description: "frontier coding & long-horizon agent execution",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "Qwen/Qwen3.7-Plus",
      name: "Qwen 3.7 Plus",
      description: "agentic coding & reasoning at lower cost",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "Qwen/Qwen3.7-Flash",
      name: "Qwen 3.7 Flash",
      description: "fast low-cost agentic coding & reasoning",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "Qwen/Qwen3.6-Max-Preview",
      name: "Qwen 3.6 Max Preview",
      description: "vibe coding & efficient agent execution",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 200_000,
      minimumPlan: "go",
    },
    {
      id: "Qwen/Qwen3.6-Plus",
      name: "Qwen 3.6 Plus",
      description: "agentic coding & reasoning",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 200_000,
      minimumPlan: "go",
    },
    {
      id: "stepfun/Step-3.7-Flash",
      name: "Step 3.7 Flash",
      description: "multimodal sparse-MoE reasoning",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 256_000,
      minimumPlan: "go",
    },
    {
      id: "stepfun/Step-3.5-Flash",
      name: "Step 3.5 Flash",
      description: "fast sparse-MoE agentic reasoning",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "tencent/hy3-paid",
      name: "Tencent Hy3",
      description: "sparse-MoE reasoning & agentic tool use",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 262_144,
      minimumPlan: "go",
    },
    {
      id: "google/gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      description: "higher-quality coding & agentic workflows, fewer tokens",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH,
      contextWindow: 1_000_000,
      minimumPlan: "goat",
    },
    {
      id: "google/gemini-3.6-flash",
      name: "Gemini 3.6 Flash",
      description: "previous Gemini Flash, still fast & capable",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH,
      contextWindow: 1_000_000,
      minimumPlan: "pro",
    },
    {
      id: "google/gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      description: "Pro-level coding proficiency, parallel agentic execution",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH,
      contextWindow: 1_000_000,
      minimumPlan: "pro",
    },
    {
      id: "google/gemini-3.5-flash-lite",
      name: "Gemini 3.5 Flash Lite",
      description: "upgraded agentic capabilities, ideal for subagents",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH,
      contextWindow: 1_000_000,
      minimumPlan: "pro",
    },
    {
      id: "google/gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash Lite",
      description: "high-volume workhorse model with implicit caching",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH,
      contextWindow: 1_000_000,
      minimumPlan: "pro",
    },
    {
      id: "sakana/fugu-ultra",
      name: "Fugu Ultra",
      description: "multi-agent orchestration across frontier models",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: HIGH_XHIGH,
      contextWindow: 1_000_000,
      minimumPlan: "max",
    },
    {
      id: "nvidia/nemotron-3-ultra-550b-a55b",
      name: "Nemotron 3 Ultra",
      description: "open reasoning model for long-horizon autonomous agents",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "thinkingmachines/inkling",
      name: "Inkling",
      description: "multimodal MoE reasoning",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 256_000,
      minimumPlan: "go",
    },
    {
      id: "thinkingmachines/inkling-small",
      name: "Inkling Small",
      description: "lightweight MoE reasoning at lower cost and latency",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "stealth/ox-alpha",
      name: "Ox Alpha",
      description: "long-horizon coding, agentic work & visual context",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_HIGH_MAX,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      minimumPlan: "go",
    },
    {
      id: "poolside/laguna-s-2.1-free",
      name: "Laguna S 2.1",
      description: "open-weight agentic coding and long-horizon work",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 256_000,
      maxOutputTokens: 32_768,
      minimumPlan: "go",
    },
    {
      id: "meta/muse-spark-1.1",
      name: "Muse Spark 1.1",
      description: "agentic performance, tool use, and computer use",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "pro",
    },
    {
      id: "meta/muse-spark-1.2",
      name: "Muse Spark 1.2",
      description: "coding-optimized for agentic workflows and large codebases",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "goat",
    },
    {
      id: "meta/muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      description: "Muse Spark 1.2 at ~95% off",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: NO_SELECTABLE_THINKING_LEVELS,
      contextWindow: 1_000_000,
      minimumPlan: "go",
    },
    {
      id: "xai/grok-4.5",
      name: "Grok 4.5",
      description: "smartest model for coding, agentic tasks, knowledge work",
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH,
      contextWindow: 500_000,
      minimumPlan: "go",
    },
    {
      id: "xai/grok-4.6",
      name: "Grok 4.6",
      description: "frontier performance on coding, knowledge work, and STEM",
      input: ["text"],
      reasoning: true,
      thinkingLevelMap: LOW_MEDIUM_HIGH_XHIGH,
      contextWindow: 500_000,
      minimumPlan: "goat",
    },
  ]);
