/**
 * Alias registry domain (Provider Activation Spec v1.0 §5.7/§5.8/§11.5) —
 * the pure, deterministic overlay of two layers:
 *
 * - generated defaults (lower layer): every canonical target in the
 *   authoritative Catalog derives a slash-free default model name from its
 *   canonical model id, then namespaces it as `${providerId}/${modelName}`.
 *   Valid user-owned Model names reserve Provider-local external names, so
 *   generated defaults deterministically route around those reservations;
 *   generated defaults are never persisted to `model-aliases.json`.
 * - explicit user overrides (authority layer): the manually editable
 *   `model-aliases.json`; a valid user override claims its canonical
 *   target and suppresses that target's generated default. Removing the
 *   override restores the generated default automatically.
 *
 * Invariants (acceptance criteria):
 *
 * - every Catalog model has exactly one effective alias (the generated
 *   `${providerId}/${defaultModelName}` until a user override replaces it);
 * - every valid user override remains in the canonical target Provider's
 *   namespace: `${providerId}/${modelName}`;
 * - one external alias maps to exactly one canonical (providerId, modelId);
 * - at most one effective alias per canonical target: a proposal that would
 *   produce a duplicate canonical target is rejected with a `duplicate`
 *   error instead of guessing which alias wins;
 * - validation against the authoritative Catalog snapshot distinguishes
 *   `invalid` (malformed alias/target), `ambiguous` (a target that cannot
 *   name one canonical model), `unknown` (well-formed but absent from the
 *   active Catalog) and `duplicate` (canonical target already mapped) —
 *   without ever replacing the active registry. Canonical identity is still
 *   determined only by the explicit target; alias strings are never parsed
 *   to reconstruct routing identity.
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

/** Default external model-name seed for one canonical Provider model id. */
export function normalizeModelName(modelId: string): string {
  return modelId.replaceAll("/", "-");
}

export interface DefaultModelNameAllocation {
  get(target: AliasCatalogTarget): string | undefined;
}

export interface DefaultModelNameAllocationOptions {
  readonly reservedModelNames?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Allocate the final default external model name for every canonical Catalog
 * target. Allocation is Provider-scoped and independent of Catalog input order.
 * Names are fitted to the 128-character alias bound after the Provider prefix;
 * valid user names may reserve slots. A model whose canonical id already equals
 * an available normalized name owns that natural name; other collisions receive
 * the first available `-N` suffix without taking a natural or user-owned name.
 */
export function deriveDefaultModelNames(
  catalogTargets: readonly AliasCatalogTarget[],
  options: DefaultModelNameAllocationOptions = {},
): DefaultModelNameAllocation {
  const byProvider = new Map<string, AliasCatalogTarget[]>();
  for (const target of catalogTargets) {
    const group = byProvider.get(target.provider) ?? [];
    group.push(target);
    byProvider.set(target.provider, group);
  }

  const names = new Map<string, string>();
  for (const [provider, providerTargets] of byProvider) {
    const maxModelNameLength = MAX_ALIAS_LENGTH - provider.length - 1;
    const fit = (value: string): string =>
      value.length <= maxModelNameLength
        ? value
        : value.slice(0, maxModelNameLength);
    const numbered = (base: string, suffix: number): string => {
      const marker = `-${suffix}`;
      return `${base.slice(0, Math.max(0, maxModelNameLength - marker.length))}${marker}`;
    };
    const groups = new Map<string, AliasCatalogTarget[]>();
    for (const target of providerTargets) {
      const base = fit(normalizeModelName(target.model));
      const group = groups.get(base) ?? [];
      group.push(target);
      groups.set(base, group);
    }

    const reservedByUser = new Set(options.reservedModelNames?.get(provider) ?? []);
    const reservedNaturalNames = new Set([...groups.keys(), ...reservedByUser]);
    const usedNames = new Set<string>(reservedByUser);
    const owners = new Map<string, AliasCatalogTarget>();
    for (const base of [...groups.keys()].sort()) {
      if (reservedByUser.has(base)) continue;
      const candidates = [...(groups.get(base) ?? [])].sort((a, b) =>
        a.model < b.model ? -1 : a.model > b.model ? 1 : 0,
      );
      const owner = candidates.find((target) => target.model === base) ?? candidates[0];
      if (owner === undefined) continue;
      owners.set(base, owner);
      usedNames.add(base);
      names.set(canonicalTargetKey(owner), base);
    }

    for (const base of [...groups.keys()].sort()) {
      const owner = owners.get(base);
      const candidates = [...(groups.get(base) ?? [])].sort((a, b) =>
        a.model < b.model ? -1 : a.model > b.model ? 1 : 0,
      );
      for (const target of candidates) {
        if (target === owner) continue;
        let suffix = 2;
        let modelName = numbered(base, suffix);
        while (reservedNaturalNames.has(modelName) || usedNames.has(modelName)) {
          suffix += 1;
          modelName = numbered(base, suffix);
        }
        usedNames.add(modelName);
        names.set(canonicalTargetKey(target), modelName);
      }
    }
  }
  return Object.freeze({
    get: (target: AliasCatalogTarget) => names.get(canonicalTargetKey(target)),
  });
}

/** Final generated aliases derived from the allocated default model names. */
export function deriveDefaultAliases(
  catalogTargets: readonly AliasCatalogTarget[],
  options: DefaultModelNameAllocationOptions = {},
): ReadonlyMap<string, string> {
  const modelNames = deriveDefaultModelNames(catalogTargets, options);
  const aliases = new Map<string, string>();
  for (const target of catalogTargets) {
    const modelName = modelNames.get(target);
    if (modelName === undefined) continue;
    aliases.set(canonicalTargetKey(target), `${target.provider}/${modelName}`);
  }
  return aliases;
}

function reservedModelNamesFromUserAliases(
  userAliases: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const reserved = new Map<string, Set<string>>();
  for (const [alias, ref] of Object.entries(userAliases)) {
    if (aliasKeyError(alias) !== undefined) continue;
    const parsed = parseAliasTarget(ref);
    if ("error" in parsed) continue;
    if (aliasNamespaceError(alias, parsed.target) !== undefined) continue;
    const prefix = `${parsed.target.provider}/`;
    const names = reserved.get(parsed.target.provider) ?? new Set<string>();
    names.add(alias.slice(prefix.length));
    reserved.set(parsed.target.provider, names);
  }
  return reserved;
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
  const defaultAliases = deriveDefaultAliases(input.catalogTargets, {
    reservedModelNames: reservedModelNamesFromUserAliases(input.userAliases),
  });
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
    if (aliasNamespaceError(alias, parsed.target) !== undefined) continue;
    // A custom alias colliding with another target's generated default is
    // not a configured mapping (the proposal is rejected upstream).
    let collision = false;
    for (const other of input.catalogTargets) {
      if (canonicalTargetKey(other) === canonicalTargetKey(parsed.target)) {
        continue;
      }
      if (defaultAliases.get(canonicalTargetKey(other)) === alias) {
        collision = true;
        break;
      }
    }
    if (collision) continue;
    claim(alias, ref);
  }
  for (const target of input.catalogTargets) {
    const alias = defaultAliases.get(canonicalTargetKey(target));
    if (alias === undefined) continue;
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

function aliasNamespaceError(
  alias: string,
  target: AliasCanonicalTarget,
): Omit<AliasValidationErrorProjection, "alias"> | undefined {
  const prefix = `${target.provider}/`;
  const modelName = alias.startsWith(prefix) ? alias.slice(prefix.length) : "";
  if (modelName.length === 0 || modelName.includes("/")) {
    return {
      code: "invalid",
      message: `Alias "${alias}" is not valid for Provider "${target.provider}": it must be "${target.provider}/<model-name>" and model-name must not contain '/'.`,
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
  const namespaceError = aliasNamespaceError(alias, parsed.target);
  if (namespaceError !== undefined) {
    return { kind: "error", error: { alias, ...namespaceError } };
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
  const defaultAliases = deriveDefaultAliases(input.catalogTargets, {
    reservedModelNames: reservedModelNamesFromUserAliases(input.userAliases),
  });
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
      if (defaultAliases.get(canonicalTargetKey(other)) === alias) {
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
    const alias = defaultAliases.get(canonicalTargetKey(target));
    if (alias === undefined) continue;
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
