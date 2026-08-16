/**
 * Ticket 14 alias registry domain — the pure, deterministic overlay of the
 * two layers:
 *
 * - curated defaults (lower layer): static, versioned, shipped by
 *   LuckyToken; an untouched default follows the current defaults version,
 *   so a default upgrade can change it;
 * - explicit user mappings (authority layer): the manually editable
 *   `model-aliases.json`; a user mapping always wins and is never silently
 *   replaced by a default upgrade.
 *
 * Invariants (acceptance criteria):
 *
 * - one external alias maps to exactly one canonical (providerId, modelId);
 * - at most one effective alias per canonical target: a proposal that would
 *   produce a duplicate canonical target is rejected with a `duplicate`
 *   error instead of guessing which alias wins;
 * - validation against the authoritative Ticket 11 catalog snapshot
 *   distinguishes `invalid` (malformed alias/target), `ambiguous` (a target
 *   that cannot name one canonical model, or an alias colliding with the
 *   canonical provider/model selector syntax), `unknown` (well-formed but
 *   absent from the active catalog) and `duplicate` (canonical target
 *   already mapped) — without ever replacing the active registry.
 *
 * All inputs are injected (catalog snapshot facts, defaults, defaults
 * version) so tests are deterministic; this module never touches the
 * filesystem, the clock, or the wire. The projection shapes are the one
 * authoritative Control Plane contract.
 */

import type {
  AliasCanonicalTarget,
  AliasValidationErrorProjection,
  EffectiveAliasProjection,
  EffectiveAliasRegistryProjection,
} from "@luckytoken/application-control-plane/control-plane";

/** One curated default alias mapping (the lower layer). */
export interface CuratedAliasDefault {
  readonly alias: string;
  readonly provider: string;
  readonly model: string;
}

/** The alias may be at most this long; longer keys are rejected as
 *  invalid (bounded, value-safe). */
export const MAX_ALIAS_LENGTH = 128;

/** Canonical separator between provider and model in string targets and in
 *  canonical selectors; an alias containing it collides with canonical
 *  Provider/model selector syntax and is rejected as ambiguous. */
const CANONICAL_SEPARATOR = "/";

/** Deterministic canonical key for one canonical target. */
export function canonicalTargetKey(target: AliasCanonicalTarget): string {
  return `${target.provider}\u0000${target.model}`;
}

/**
 * Compute the catalog-independent configured alias mappings: every alias
 * key that owns a parseable, non-duplicate canonical target, whether or
 * not that target is currently in the active catalog.
 *
 * The effective registry (control plane) keeps catalog-membership
 * validation and reports out-of-catalog targets as `unknown` errors; the
 * data plane needs the mapping to survive a catalog swap so it can render
 * `model_unavailable` for a configured alias whose target left the active
 * catalog (Ticket 15). Rejected proposals never enter the file, so a
 * mapping this function serves always came from the transparent user file
 * or the curated defaults — never from a guessed repair.
 */
export function computeConfiguredAliasMappings(input: {
  readonly userAliases: Readonly<Record<string, unknown>>;
  readonly defaults: readonly CuratedAliasDefault[];
}): ReadonlyMap<string, AliasCanonicalTarget> {
  const byAlias = new Map<string, AliasCanonicalTarget>();
  const claimedTargets = new Set<string>();
  const userAliasKeys = new Set(Object.keys(input.userAliases));
  const claim = (alias: string, ref: unknown): void => {
    const keyError = aliasKeyError(alias);
    if (keyError !== undefined) return;
    const parsed = parseAliasTarget(ref);
    if ("error" in parsed) return;
    const key = canonicalTargetKey(parsed.target);
    if (claimedTargets.has(key)) return;
    byAlias.set(alias, parsed.target);
    claimedTargets.add(key);
  };
  for (const [alias, ref] of Object.entries(input.userAliases)) {
    claim(alias, ref);
  }
  for (const curated of input.defaults) {
    // The user owns the alias key even when their mapping is broken: the
    // curated default must never silently replace it.
    if (userAliasKeys.has(curated.alias)) continue;
    claim(curated.alias, {
      provider: curated.provider,
      model: curated.model,
    });
  }
  return byAlias;
}

export function parseAliasTarget(
  ref: unknown,
): { readonly target: AliasCanonicalTarget } | { readonly error: Omit<AliasValidationErrorProjection, "alias"> } {
  if (typeof ref === "string") {
    const separator = ref.indexOf(CANONICAL_SEPARATOR);
    if (separator < 0) {
      return {
        error: {
          code: "ambiguous",
          message: `Target "${ref}" is ambiguous: it does not name a Provider and one model id can be served by many Providers.`,
        },
      };
    }
    const provider = ref.slice(0, separator);
    const model = ref.slice(separator + 1);
    if (
      provider.trim() !== provider ||
      model.trim() !== model ||
      provider.length === 0 ||
      model.length === 0 ||
      model.includes(CANONICAL_SEPARATOR)
    ) {
      return {
        error: {
          code: "invalid",
          message: `Target "${ref}" is not valid: it must be "provider/model" with non-empty, non-whitespace-padded parts.`,
        },
      };
    }
    return { target: { provider, model } };
  }
  if (typeof ref === "object" && ref !== null && !Array.isArray(ref)) {
    const record = ref as Record<string, unknown>;
    const provider = record.provider;
    const model = record.model;
    if (
      typeof provider !== "string" ||
      typeof model !== "string" ||
      provider.trim() !== provider ||
      model.trim() !== model ||
      provider.length === 0 ||
      model.length === 0
    ) {
      return {
        error: {
          code: "invalid",
          message: "The target is not valid: provider and model must be non-empty strings without surrounding whitespace.",
        },
      };
    }
    return { target: { provider, model } };
  }
  return {
    error: {
      code: "invalid",
      message: "The target is not valid: it must be an object { provider, model } or a \"provider/model\" string.",
    },
  };
}

function aliasKeyError(alias: string): Omit<AliasValidationErrorProjection, "alias"> | undefined {
  if (alias.length === 0) {
    return { code: "invalid", message: "An alias must not be empty." };
  }
  if (alias.trim() !== alias) {
    return {
      code: "invalid",
      message: `Alias "${alias}" is not valid: it must not start or end with whitespace.`,
    };
  }
  if (alias.includes(CANONICAL_SEPARATOR)) {
    return {
      code: "ambiguous",
      message: `Alias "${alias}" is ambiguous: it uses the reserved Provider/model separator "/".`,
    };
  }
  if (alias.length > MAX_ALIAS_LENGTH) {
    return {
      code: "invalid",
      message: `Alias "${alias}" is not valid: it is longer than ${MAX_ALIAS_LENGTH} characters.`,
    };
  }
  return undefined;
}

type EntryOutcome =
  | { readonly kind: "effective"; readonly target: AliasCanonicalTarget }
  | { readonly kind: "error"; readonly error: AliasValidationErrorProjection };

function evaluateEntry(
  alias: string,
  ref: unknown,
  claimedTargets: ReadonlySet<string>,
  knownTargets: ReadonlySet<string>,
): EntryOutcome {
  const keyError = aliasKeyError(alias);
  if (keyError !== undefined) {
    return { kind: "error", error: { alias, ...keyError } };
  }
  const parsed = parseAliasTarget(ref);
  if ("error" in parsed) {
    return { kind: "error", error: { alias, ...parsed.error } };
  }
  const key = canonicalTargetKey(parsed.target);
  if (claimedTargets.has(key)) {
    return {
      kind: "error",
      error: {
        alias,
        code: "duplicate",
        message: `Alias "${alias}" duplicates a canonical target that is already mapped: only one effective alias per Provider/model is allowed.`,
      },
    };
  }
  if (!knownTargets.has(key)) {
    return {
      kind: "error",
      error: {
        alias,
        code: "unknown",
        message: `Target "${parsed.target.provider}/${parsed.target.model}" of alias "${alias}" is not in the active catalog.`,
      },
    };
  }
  return { kind: "effective", target: parsed.target };
}

/**
 * Compute the one authoritative effective registry from the user file
 * (authority layer) over the curated defaults (lower layer). User aliases
 * are evaluated first and claim their canonical targets; a user alias that
 * fails validation still owns its alias key, so no default can silently
 * replace a broken user mapping. Defaults then fill untouched aliases and
 * are validated against the same catalog facts; a default that collides or
 * is unknown is reported, never guessed.
 */
export function computeEffectiveAliasRegistry(input: {
  readonly userAliases: Readonly<Record<string, unknown>>;
  readonly defaults: readonly CuratedAliasDefault[];
  readonly defaultsVersion: number;
  readonly catalogVersion: number;
  readonly knownTargets: ReadonlySet<string>;
}): EffectiveAliasRegistryProjection {
  const aliases: EffectiveAliasProjection[] = [];
  const errors: AliasValidationErrorProjection[] = [];
  const claimedTargets = new Set<string>();
  const userAliasKeys = new Set(Object.keys(input.userAliases));
  for (const [alias, ref] of Object.entries(input.userAliases)) {
    const outcome = evaluateEntry(alias, ref, claimedTargets, input.knownTargets);
    if (outcome.kind === "error") {
      errors.push(outcome.error);
      continue;
    }
    aliases.push({ alias, target: outcome.target, layer: "user" });
    claimedTargets.add(canonicalTargetKey(outcome.target));
  }
  for (const curated of input.defaults) {
    // The user owns the alias key even when their mapping is broken: the
    // curated default must never silently replace it.
    if (userAliasKeys.has(curated.alias)) continue;
    const outcome = evaluateEntry(
      curated.alias,
      { provider: curated.provider, model: curated.model },
      claimedTargets,
      input.knownTargets,
    );
    if (outcome.kind === "error") {
      errors.push(outcome.error);
      continue;
    }
    aliases.push({
      alias: curated.alias,
      target: outcome.target,
      layer: "default",
    });
    claimedTargets.add(canonicalTargetKey(outcome.target));
  }
  return Object.freeze({
    defaultsVersion: input.defaultsVersion,
    aliases: Object.freeze(aliases),
    errors: Object.freeze(errors),
  });
}
