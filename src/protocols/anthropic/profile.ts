import { InvalidRequest, UnsupportedFeature } from "./failures.js";

export interface AnthropicHeaderView {
  get(name: string): string | null;
}

export interface ResolvedAnthropicSourceProfile {
  version: string;
}

const VERSION_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const IMPLEMENTED_VERSION = "2023-06-01";

export function resolveAnthropicSourceProfile(
  headers: AnthropicHeaderView,
): ResolvedAnthropicSourceProfile {
  const rawVersion = headers.get("anthropic-version");
  if (
    rawVersion === null ||
    rawVersion !== rawVersion.trim() ||
    !VERSION_PATTERN.test(rawVersion)
  ) {
    throw new InvalidRequest("anthropic-version must be one date-version value");
  }

  return { version: rawVersion };
}

export function assertImplementedAnthropicProfile(
  profile: ResolvedAnthropicSourceProfile,
): void {
  if (profile.version !== IMPLEMENTED_VERSION) {
    throw new UnsupportedFeature(
      "Only anthropic-version=2023-06-01 is implemented",
    );
  }
}
