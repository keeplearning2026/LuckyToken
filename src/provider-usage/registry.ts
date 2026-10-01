import type { FetchFunction } from "@earendil-works/pi-ai";

import type { ProviderUsageProbe } from "./contract.js";
import { createAnthropicUsageProbe } from "./probes/anthropic.js";
import { createCommandCodeGoatUsageProbe } from "./probes/commandcode-goat.js";
import { createCommandCodePrivateUsageProbe } from "./probes/commandcode-private.js";
import { createDeepSeekAnthropicUsageProbe } from "./probes/deepseek-anthropic.js";
import { createDeepSeekResponseUsageProbe } from "./probes/deepseek-response.js";
import { createDeepSeekUsageProbe } from "./probes/deepseek.js";
import { createKimiCodingUsageProbe } from "./probes/kimi-coding.js";
import { createMiniMaxUsageProbe } from "./probes/minimax.js";
import { createMiniMaxCnUsageProbe } from "./probes/minimax-cn.js";
import { createMoonshotAiUsageProbe } from "./probes/moonshotai.js";
import { createMoonshotAiCnUsageProbe } from "./probes/moonshotai-cn.js";
import { createOpenAiCodexUsageProbe } from "./probes/openai-codex.js";
import { createOpenCodeGoUsageProbe } from "./probes/opencode-go.js";
import { createOpenRouterUsageProbe } from "./probes/openrouter.js";
import { createXaiUsageProbe } from "./probes/xai.js";
import { createZaiUsageProbe } from "./probes/zai.js";
import { createZaiCodingCnUsageProbe } from "./probes/zai-coding-cn.js";

export function createBuiltInProviderUsageProbes(
  fetch: FetchFunction,
): readonly ProviderUsageProbe[] {
  return Object.freeze([
    createCommandCodeGoatUsageProbe(fetch),
    createCommandCodePrivateUsageProbe(fetch),
    createOpenCodeGoUsageProbe(fetch),
    createKimiCodingUsageProbe(fetch),
    createDeepSeekUsageProbe(fetch),
    createDeepSeekAnthropicUsageProbe(fetch),
    createDeepSeekResponseUsageProbe(fetch),
    createOpenRouterUsageProbe(fetch),
    createMiniMaxUsageProbe(fetch),
    createMiniMaxCnUsageProbe(fetch),
    createMoonshotAiUsageProbe(fetch),
    createMoonshotAiCnUsageProbe(fetch),
    createZaiUsageProbe(fetch),
    createZaiCodingCnUsageProbe(fetch),
    createAnthropicUsageProbe(fetch),
    createXaiUsageProbe(fetch),
    createOpenAiCodexUsageProbe(fetch),
  ]);
}
