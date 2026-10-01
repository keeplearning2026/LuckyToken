import type { Model } from "@earendil-works/pi-ai";

import {
  DEEPSEEK_RESPONSE_BASE_URL,
  DEEPSEEK_RESPONSE_PROVIDER_ID,
} from "./constants.js";

/**
 * The two model facts are copied from `@earendil-works/pi-ai@0.87.0`
 * (`dist/providers/data/deepseek.json`, provider `deepseek`) so the
 * Responses provider serves the same ids, names, thinking levels, input
 * modalities, prices, and limits as the Pi Chat Completions provider.
 *
 * Responses-specific adaptation:
 * - `api`/`baseUrl`/`provider` move to this provider's Responses surface.
 * - `supportsDeveloperRole: false` makes Pi emit a `system` message instead
 *   of `developer`; DeepSeek treats `developer` as `user`.
 * - `supportsLongCacheRetention: false` because DeepSeek rejects
 *   `prompt_cache_retention` (context caching is automatic).
 * - `strict` function tools stay off: DeepSeek's Responses tool schema
 *   documents only `type`/`name`/`description`/`parameters`.
 * - `supportsMidConvoSystemMessages` keeps the Pi catalog's per-model fact
 *   (`deepseek-v4-pro` only).
 */
export const DEEPSEEK_RESPONSE_MODELS: readonly Model<"openai-responses">[] =
  Object.freeze([
    {
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      api: "openai-responses",
      provider: DEEPSEEK_RESPONSE_PROVIDER_ID,
      baseUrl: DEEPSEEK_RESPONSE_BASE_URL,
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        max: "max",
      },
      input: ["text", "image"],
      inputLimits: {
        images: {
          resize: {
            maxWidth: 2000,
            maxHeight: 2000,
            maxBytes: 4718592,
            jpegQuality: 80,
          },
        },
      },
      cost: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.006,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsDeveloperRole: false,
        supportsLongCacheRetention: false,
      },
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-responses",
      provider: DEEPSEEK_RESPONSE_PROVIDER_ID,
      baseUrl: DEEPSEEK_RESPONSE_BASE_URL,
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        max: "max",
      },
      input: ["text"],
      cost: {
        input: 1.32,
        output: 3.96,
        cacheRead: 0.044,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsDeveloperRole: false,
        supportsLongCacheRetention: false,
        supportsMidConvoSystemMessages: true,
      },
    },
  ]);
