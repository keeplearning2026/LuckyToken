import type { CuratedAliasDefault } from "./domain.js";

/**
 * Ticket 14 curated default alias mappings — the LOWER layer of the global
 * alias registry.
 *
 * The defaults are static, versioned, and shipped with LuckyToken. The
 * user-owned `model-aliases.json` stores ONLY explicit user mappings, so an
 * untouched curated default automatically follows the current defaults
 * version: a default upgrade can change it, while a user-modified mapping
 * is never silently replaced. A curated default that does not resolve in
 * the active catalog is reported as a validation error, never guessed.
 *
 * The version MUST be bumped whenever this list changes, so projections
 * and tests can distinguish defaults generations.
 */
export const CURATED_ALIAS_DEFAULTS_VERSION = 1;

export const curatedAliasDefaults: readonly CuratedAliasDefault[] =
  Object.freeze([
    { alias: "gpt-4o", provider: "openai", model: "gpt-4o" },
    { alias: "gpt-4o-mini", provider: "openai", model: "gpt-4o-mini" },
    { alias: "claude-sonnet-4", provider: "anthropic", model: "claude-sonnet-4" },
    { alias: "claude-opus-4", provider: "anthropic", model: "claude-opus-4-8" },
    { alias: "deepseek-chat", provider: "deepseek", model: "deepseek-v4-flash" },
  ]);
