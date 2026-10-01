/** DeepSeek's Anthropic-Messages-compatible surface. */
export const DEEPSEEK_ANTHROPIC_PROVIDER_ID = "deepseek-anthropic" as const;
export const DEEPSEEK_ANTHROPIC_PROVIDER_NAME =
  "DeepSeek (Anthropic)" as const;

/**
 * Documented Anthropic `base_url`; the Anthropic SDK appends `/v1/messages`,
 * so requests go to `https://api.deepseek.com/anthropic/v1/messages`.
 */
export const DEEPSEEK_ANTHROPIC_BASE_URL =
  "https://api.deepseek.com/anthropic" as const;
