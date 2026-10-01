/** DeepSeek's OpenAI-Responses-compatible surface. */
export const DEEPSEEK_RESPONSE_PROVIDER_ID = "deepseek-response" as const;
export const DEEPSEEK_RESPONSE_PROVIDER_NAME = "DeepSeek (Responses)" as const;

/**
 * `https://api.deepseek.com` is the documented `base_url`; the Responses
 * endpoint is `POST /responses`, which the OpenAI-compatible client appends
 * to this root. `https://api.deepseek.com/v1` is not used because the
 * documented Responses base_url carries no version segment.
 */
export const DEEPSEEK_RESPONSE_BASE_URL = "https://api.deepseek.com" as const;
