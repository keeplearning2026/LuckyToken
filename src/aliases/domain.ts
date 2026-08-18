/**
 * Alias registry domain (Provider Activation Spec v1.0 §5.7/§5.8/§11.5) —
 * the pure, deterministic overlay of two layers:
 *
 * - generated defaults (lower layer): every canonical target in the
 *   authoritative Catalog derives its default alias deterministically as
 *   `${providerId}/${modelId}`. Generated defaults are a pure function of
 *   the Catalog and are never persisted to `model-aliases.json`. A model
 *   whose id contains `/` keeps the full text
 *   (`commandcode-private/deepseek/deepseek-v4-flash`).
 * - explicit user overrides (authority layer): the manually editable
 *   `model-aliases.json`; a valid user override claims its canonical
 *   target and suppresses that target's generated default. Removing the
 *   override restores the generated default automatically.
 *
 * Invariants (acceptance criteria):
 *
 * - every Catalog model has exactly one effective alias (the generated
 *   `provider/model` until a user override replaces it);
 * - one external alias maps to exactly one canonical (providerId, modelId);
 * - at most one effective alias per canonical target: a proposal that would
 *   produce a duplicate canonical target is rejected with a `duplicate`
 *   error instead of guessing which alias wins;
 * - validation against the authoritative Catalog snapshot distinguishes
 *   `invalid` (malformed alias/target), `ambiguous` (a target that cannot
 *   name one canonical model), `unknown` (well-formed but absent from the
 *   active Catalog) and `duplicate` (canonical target already mapped) —
 *   without ever replacing the active registry. Alias text is an opaque
 *   external identity and may contain `/`; canonical identity is
 *   determined only by the explicit mapped target. The generated alias
 *   string is never parsed to reconstruct canonical identity.
 *
 * All inputs are injected (Catalog snapshot facts) so tests are
 * deterministic; this module never touches the filesystem, the clock, or
 * the wire. The projection shapes are the one authoritative Control Plane
 * contract.
 */

import type {
  AliasCanonicalTarget,
  AliasValidationErrorProjection,
  EffectiveAliasProjection,
  EffectiveAliasRegistryProjection,
} from "@luckytoken/application-control-plane/control-plane";

/** One canonical Catalog target (the authoritative model set). */
export interface AliasCatalogTarget {
  readonly provider: string;
  readonly model: string;
}

/** The alias may be at most this long; longer keys are rejected as
 *  invalid (bounded, value-safe). */
export const MAX_ALIAS_LENGTH = 128;

/** Canonical separator between provider and model in string-form targets.
 *  Alias keys are opaque external identities and may contain this character. */
const CANONICAL_SEPARATOR = "/";

/** Deterministic canonical key for one canonical target. */
export function canonicalTargetKey(target: AliasCanonicalTarget): string {
  return `${target.provider}\u0000${target.model}`;
}

/**
 * The deterministic generated default alias for one canonical Catalog
 * target: exactly `provider/model`. A model id that itself contains `/`
 * is preserved verbatim — the alias string is opaque and never parsed to
 * reconstruct canonical identity (Spec §11.5).
 */
export function generatedDefaultAlias(target: AliasCatalogTarget): string {
  return `${target.provider}/${target.model}`;
}

/**
 * Compute the catalog-independent configured alias mappings: every alias
 * key that owns a parseable, non-duplicate canonical target, whether or
 * not that target is currently in the active Catalog. Generated defaults
 * for current Catalog targets are included (they are part of the
 * configured mappings for the data plane); a generated default for a
 * target claimed by a user override is suppressed.
 *
 * The effective registry (control plane) keeps catalog-membership
 * validation and reports out-of-catalog targets as `unknown` errors; the
 * data plane needs the mapping to survive a catalog swap so it can render
 * `model_unavailable` for a configured alias whose target left the active
 * Catalog. Rejected proposals never enter the file, so a mapping this
 * function serves always came from the transparent user file or the
 * generated defaults — never from a guessed repair.
 */
export function computeConfiguredAliasMappings(input: {
  readonly userAliases: Readonly<Record<string, unknown>>;
  readonly catalogTargets: readonly AliasCatalogTarget[];
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
    const keyError = aliasKeyError(alias);
    if (keyError !== undefined) continue;
    const parsed = parseAliasTarget(ref);
    if ("error" in parsed) continue;
    // A custom alias colliding with another target's generated default is
    // not a configured mapping (the proposal is rejected upstream).
    let collision = false;
    for (const other of input.catalogTargets) {
      if (canonicalTargetKey(other) === canonicalTargetKey(parsed.target)) {
        continue;
      }
      if (generatedDefaultAlias(other) === alias) {
        collision = true;
        break;
      }
    }
    if (collision) continue;
    claim(alias, ref);
  }
  for (const target of input.catalogTargets) {
    const alias = generatedDefaultAlias(target);
    // The user owns the alias key even when their mapping is broken: the
    // generated default must never silently replace it. A target already
    // claimed by a user override suppresses its generated default.
    if (claimedTargets.has(canonicalTargetKey(target))) continue;
    if (userAliasKeys.has(alias)) continue;
    claim(alias, { provider: target.provider, model: target.model });
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
      model.length === 0
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

export function aliasKeyError(alias: string): Omit<AliasValidationErrorProjection, "alias"> | undefined {
  if (alias.length === 0) {
    return { code: "invalid", message: "An alias must not be empty." };
  }
  if (alias.trim() !== alias) {
    return {
      code: "invalid",
      message: `Alias "${alias}" is not valid: it must not start or end with whitespace.`,
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
 * (authority layer) over the Catalog-derived generated defaults (lower
 * layer). User aliases are evaluated first and claim their canonical
 * targets; a user alias that fails validation still owns its alias key,
 * so no generated default can silently replace a broken user mapping.
 * Generated defaults then fill every unclaimed Catalog target and are
 * validated against the same catalog facts; a generated default that
 * collides or is unknown is reported, never guessed.
 */
export function computeEffectiveAliasRegistry(input: {
  readonly userAliases: Readonly<Record<string, unknown>>;
  readonly catalogTargets: readonly AliasCatalogTarget[];
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
    // A custom alias must not claim another target's generated default
    // (Spec §11.6): a custom alias equal to the generated default of a
    // DIFFERENT catalog target is rejected as a collision. A custom alias
    // that happens to equal its own target's generated default is a
    // legitimate (explicit) override.
    for (const other of input.catalogTargets) {
      if (canonicalTargetKey(other) === canonicalTargetKey(outcome.target)) {
        continue;
      }
      if (generatedDefaultAlias(other) === alias) {
        errors.push({
          alias,
          code: "duplicate",
          message: `Alias "${alias}" collides with the generated default alias of another model and cannot be reused.`,
        });
        break;
      }
    }
    if (errors.some((entry) => entry.alias === alias)) continue;
    aliases.push({ alias, target: outcome.target, layer: "user" });
    claimedTargets.add(canonicalTargetKey(outcome.target));
  }
  for (const target of input.catalogTargets) {
    const alias = generatedDefaultAlias(target);
    // A user alias that claims this target (or owns this alias key, even
    // when broken) suppresses the generated default: the normal override
    // path is not a duplicate error.
    if (claimedTargets.has(canonicalTargetKey(target))) continue;
    if (userAliasKeys.has(alias)) continue;
    const outcome = evaluateEntry(
      alias,
      { provider: target.provider, model: target.model },
      claimedTargets,
      input.knownTargets,
    );
    if (outcome.kind === "error") {
      errors.push(outcome.error);
      continue;
    }
    aliases.push({
      alias,
      target: outcome.target,
      layer: "default",
    });
    claimedTargets.add(canonicalTargetKey(outcome.target));
  }
  return Object.freeze({
    aliases: Object.freeze(aliases),
    errors: Object.freeze(errors),
  });
}
