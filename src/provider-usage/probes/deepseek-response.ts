import type { FetchFunction } from "@earendil-works/pi-ai";

import type { ProviderUsageProbe } from "../contract.js";
import { createDeepSeekBalanceUsageProbe } from "./deepseek-balance.js";

const PROVIDER_ID = "deepseek-response";

export function createDeepSeekResponseUsageProbe(
  fetch: FetchFunction,
): ProviderUsageProbe {
  return createDeepSeekBalanceUsageProbe(fetch, {
    providerId: PROVIDER_ID,
    acceptedBasePaths: ["/", "/v1"],
  });
}
