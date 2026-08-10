import { InvalidRequest, UnsupportedFeature } from "./failures.js";

export interface AnthropicHeaderView {
  get(name: string): string | null;
  entries(): IterableIterator<[string, string]>;
}

export interface ResolvedAnthropicSourceProfile {
  version: string;
  betas: ReadonlySet<string>;
  userProfileIdPresent: boolean;
  unclassifiedAnthropicHeaders: readonly string[];
}

const VERSION_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const BETA_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const IMPLEMENTED_VERSION = "2023-06-01";
const KNOWN_ANTHROPIC_HEADERS = new Set([
  "anthropic-version",
  "anthropic-beta",
  "anthropic-user-profile-id",
]);

function canonicalAnthropicHeaderName(name: string): string {
  const lower = name.toLowerCase();
  return lower.startsWith("x-anthropic-") ? lower.slice(2) : lower;
}

function parseBetas(raw: string | null): ReadonlySet<string> {
  if (raw === null || raw.trim().length === 0) return new Set();
  const tokens = raw.split(",").map((token) => token.trim());
  if (tokens.some((token) => token.length === 0 || !BETA_PATTERN.test(token))) {
    throw new InvalidRequest("anthropic-beta contains a malformed beta identifier");
  }
  return new Set(tokens);
}

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

  const unclassifiedAnthropicHeaders: string[] = [];
  let userProfileIdPresent = false;
  for (const [wireName] of headers.entries()) {
    const name = canonicalAnthropicHeaderName(wireName);
    if (name === "anthropic-user-profile-id") userProfileIdPresent = true;
    if (
      name.startsWith("anthropic-") &&
      !KNOWN_ANTHROPIC_HEADERS.has(name)
    ) {
      unclassifiedAnthropicHeaders.push(name);
    }
  }

  return {
    version: rawVersion,
    betas: parseBetas(headers.get("anthropic-beta")),
    userProfileIdPresent,
    unclassifiedAnthropicHeaders,
  };
}

export function assertImplementedAnthropicProfile(
  profile: ResolvedAnthropicSourceProfile,
): void {
  if (
    profile.version === IMPLEMENTED_VERSION &&
    profile.betas.size === 0 &&
    profile.userProfileIdPresent
  ) {
    throw new InvalidRequest(
      "anthropic-user-profile-id requires the user-profiles beta",
    );
  }
  if (profile.version !== IMPLEMENTED_VERSION || profile.betas.size > 0) {
    throw new UnsupportedFeature(
      "Only anthropic-version=2023-06-01 without active beta is implemented",
    );
  }
}
