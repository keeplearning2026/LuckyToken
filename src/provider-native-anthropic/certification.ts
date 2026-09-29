import type { Model } from "@earendil-works/pi-ai";

/** The single Provider API this lane may claim. */
export const ANTHROPIC_NATIVE_API = "anthropic-messages";
export type AnthropicNativeCertificationAuthType =
  | "api_key"
  | "oauth"
  | "github_copilot"
  | "ambient";

export interface AnthropicNativeCertification {
  readonly provider: string;
  readonly api: typeof ANTHROPIC_NATIVE_API;
  readonly operation: "messages";
  readonly authTypes: readonly AnthropicNativeCertificationAuthType[];
}

/**
 * Closed Provider Native Anthropic certification table.
 *
 * Routing and certification tests derive from the same literals. authTypes
 * records the reviewed envelope branches for each provider; it is release
 * certification data, not a runtime registration or a second lane selector.
 */
export const ANTHROPIC_NATIVE_CERTIFIED: readonly AnthropicNativeCertification[] =
  Object.freeze([
    {
      provider: "anthropic",
      api: ANTHROPIC_NATIVE_API,
      operation: "messages",
      authTypes: ["api_key", "oauth", "ambient"],
    },
    {
      provider: "github-copilot",
      api: ANTHROPIC_NATIVE_API,
      operation: "messages",
      authTypes: ["github_copilot", "ambient"],
    },
    {
      provider: "cloudflare-ai-gateway",
      api: ANTHROPIC_NATIVE_API,
      operation: "messages",
      authTypes: ["api_key", "ambient"],
    },
  ]);

export function isAnthropicNativePassthroughModel(
  model: Model<string>,
): boolean {
  return ANTHROPIC_NATIVE_CERTIFIED.some(
    (entry) => entry.provider === model.provider && entry.api === model.api,
  );
}
