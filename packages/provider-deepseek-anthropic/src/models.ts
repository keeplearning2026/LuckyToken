import type { Model } from "@earendil-works/pi-ai";

import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_ANTHROPIC_PROVIDER_ID,
} from "./constants.js";

/**
 * The two model facts are copied from `@earendil-works/pi-ai@0.87.0`
 * (`dist/providers/data/deepseek.json`, provider `deepseek`) so the
 * Anthropic provider serves the same ids, names, thinking levels, input
 * modalities, prices, and limits as the Pi Chat Completions provider.
 *
 * Anthropic-surface adaptation:
 * - `api`/`baseUrl`/`provider` move to DeepSeek's `/anthropic` endpoint.
 * - `forceAdaptiveThinking: true` is the only pinned Pi Anthropic-adapter
 *   path that emits `output_config.effort`; DeepSeek documents
 *   `output_config.effort` and accepts adaptive thinking plus effort
 *   low/high/max (probe-verified, including thinking-tool replay).
 * - `supportsLongCacheRetention: false` because DeepSeek ignores
 *   `cache_control` (context caching is automatic) and offers no 1h TTL.
 * - Remaining compat stays at Pi defaults: eager per-tool input streaming
 *   and tool `cache_control` markers were accepted and ignored by DeepSeek;
 *   strict tools are not documented; signatures are non-empty on replay so
 *   `allowEmptySignature` is unnecessary.
 */
export const DEEPSEEK_ANTHROPIC_MODELS: readonly Model<"anthropic-messages">[] =
  Object.freeze([
    {
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      api: "anthropic-messages",
      provider: DEEPSEEK_ANTHROPIC_PROVIDER_ID,
      baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
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
        forceAdaptiveThinking: true,
        supportsLongCacheRetention: false,
      },
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "anthropic-messages",
      provider: DEEPSEEK_ANTHROPIC_PROVIDER_ID,
      baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
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
        forceAdaptiveThinking: true,
        supportsLongCacheRetention: false,
      },
    },
  ]);
