import type { FetchFunction } from "@earendil-works/pi-ai";

import type { ProviderUsageProbe } from "../contract.js";
import { createDeepSeekBalanceUsageProbe } from "./deepseek-balance.js";

const PROVIDER_ID = "deepseek-anthropic";

export function createDeepSeekAnthropicUsageProbe(
  fetch: FetchFunction,
): ProviderUsageProbe {
  return createDeepSeekBalanceUsageProbe(fetch, {
    providerId: PROVIDER_ID,
    acceptedBasePaths: ["/anthropic"],
  });
}
