/**
 * Provider terminal-usage normalization and completeness (Ticket 20) —
 * owned by the Provider-facing integration side.
 *
 * One canonical immutable terminal usage snapshot: input, cacheRead,
 * cacheWrite, output, optional reasoning-as-output-subset, normalizedTotal,
 * cacheHitRate, completeness (complete/partial/unavailable) and a bounded
 * reason/evidence.
 *
 * Completeness is never inferred from numbers: the IR's `Usage` is an
 * all-required-numbers object that every adapter initializes to zeros, so
 * zeros are the IR's encoding of "absent". Only the per-API semantics
 * declaration (Provider integration side) proves whether explicit terminal
 * usage exists on a `done` terminal and whether all four component meanings
 * are validated. The normalizer is a pure function; the declaration table
 * lives in the LuckyToken core `src/providers` layer and is resolved by the
 * Pi terminal boundary.
 */
import type { Usage } from "@earendil-works/pi-ai";

export type UsageCompleteness = "complete" | "partial" | "unavailable";

/**
 * Bounded reason vocabulary. `complete` snapshots carry no reason; every
 * other snapshot carries exactly one.
 */
export type UsageCompletenessReason =
  | "failed" // Pi error terminal (`error`)
  | "aborted" // Pi error terminal (`aborted`)
  | "unsupported_terminal" // Pi `done` terminal rejected as unsupported (deferred)
  | "usage_absent" // `done` terminal with the IR's all-zero absence encoding
  | "component_unreported" // a component is adapter-defaulted or its meaning is unproven
  | "invalid_components" // runtime invariants failed (bounds, partition, reasoning subset)
  | "undeclared_semantics"; // no declaration exists for the api

/** How one canonical component is sourced by the pinned adapter. */
export type UsageComponentSource =
  | "reported" // field required by the API wire contract on the terminal usage event
  | "derived" // adapter-computed from provider-reported fields with a documented formula
  | "defaulted"; // adapter hardcodes a value with no wire source — never Complete

/**
 * Per-API declaration of terminal usage semantics, anchored to the vendored
 * adapter source (`pi-agent/`, immutable for LuckyToken). The declaration
 * never infers presence from values: `usagePresentOnDone` records whether
 * the API wire contract carries a usage event on every `done` terminal.
 */
export interface UsageSemanticsDeclaration {
  readonly api: string;
  /** Evidence anchor: vendored adapter file:line or provider spec section. */
  readonly evidence: string;
  /**
   * Whether the wire input count includes cached/written tokens. `unproven`
   * means the partition cannot be validated from the pinned source, which
   * blocks Completeness.
   */
  readonly inputIncludesCache: boolean | "unproven";
  readonly components: Readonly<{
    readonly input: UsageComponentSource;
    readonly cacheRead: UsageComponentSource;
    readonly cacheWrite: UsageComponentSource;
    readonly output: UsageComponentSource;
  }>;
  /** Whether the adapter exposes a reasoning breakdown (0 allowed, never
   *  fabricated for unreported). */
  readonly reasoning: "reported" | "unreported";
  /** Whether the IR `totalTokens` is a wire echo, the component sum, or
   *  either. A wire echo must agree with the component partition. */
  readonly totalTokens: "wire" | "derived" | "wire-or-derived";
  /** Whether a `done` terminal always carries a provider usage event
   *  (anthropic: yes; commandcode: no — absent finish usage is legal). */
  readonly usagePresentOnDone: "required" | "optional";
  /** Remaining semantic questions documented for this api, if any. */
  readonly openQuestions: readonly string[];
}

/** The Pi terminal class at the moment the terminal message was captured. */
export type TerminalUsageClass = "done" | "aborted" | "failed" | "unsupported";

/**
 * Narrow resolver operation passed from the Provider/composition side into
 * core: maps one Pi api id to its declared usage semantics (or undefined for
 * undeclared apis). Core never imports the Provider integration directory;
 * the composition root wires this operation through the handler seam.
 */
export type UsageSemanticsResolver = (
  api: string,
) => UsageSemanticsDeclaration | undefined;

/**
 * One canonical immutable terminal-usage snapshot. Components always carry
 * what the terminal usage object held (never repaired by guessing);
 * `normalizedTotal` and `cacheHitRate` exist only on validated Complete
 * snapshots. `reasoning` is a subset of `output` when present — it is never
 * added again to any total.
 */
export interface NormalizedTerminalUsage {
  /** Pi api id whose declaration (or absence) produced this snapshot. */
  readonly api: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  /** Reasoning/thinking tokens, subset of `output`; number (incl. 0) or
   *  absent — never invented. */
  readonly reasoning?: number;
  /** input + cacheRead + cacheWrite + output; Complete snapshots only. */
  readonly normalizedTotal?: number;
  /** cacheRead / (input + cacheRead + cacheWrite); Complete snapshots with a
   *  positive denominator only. Absent, zero, or unvalidated denominator
   *  yields no rate (never 0). */
  readonly cacheHitRate?: number;
  readonly completeness: UsageCompleteness;
  /** Required whenever completeness is not `complete`. */
  readonly reason?: UsageCompletenessReason;
  /** Bounded evidence anchor of the applied declaration, when one exists. */
  readonly evidence?: string;
}

const COMPLETENESS_VALUES: readonly UsageCompleteness[] = Object.freeze([
  "complete",
  "partial",
  "unavailable",
]);
const REASON_VALUES: readonly UsageCompletenessReason[] = Object.freeze([
  "failed",
  "aborted",
  "unsupported_terminal",
  "usage_absent",
  "component_unreported",
  "invalid_components",
  "undeclared_semantics",
]);
const MAX_EVIDENCE_LENGTH = 256;
const MAX_API_LENGTH = 128;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function componentSum(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
): number | undefined {
  const sum = input + cacheRead + cacheWrite + output;
  return Number.isSafeInteger(sum) ? sum : undefined;
}

/**
 * Pure terminal-usage normalizer (Ticket 20). Never infers completeness from
 * nonzero values or from the IR's always-present zero object; every decision
 * comes from the terminal class and the per-api declaration.
 */
export function normalizeTerminalUsage(
  api: string,
  usage: Usage,
  terminalClass: TerminalUsageClass,
  declaration: UsageSemanticsDeclaration | undefined,
): NormalizedTerminalUsage {
  // A hostile non-object IR usage (null/undefined/string/array) carries no
  // trustworthy components. Routing it through the same invalid_components
  // path keeps the snapshot honest and undecodable (the Request Ledger
  // refuses it) instead of crashing the execution boundary — fail-open
  // observability, never a reason to discard a valid model response.
  const record: Record<string, unknown> = isRecord(usage) ? usage : {};
  const { input, cacheRead, cacheWrite, output } = record as unknown as Usage;
  const reasoning = record.reasoning as number | undefined;
  const base = {
    api,
    input,
    cacheRead,
    cacheWrite,
    output,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(declaration === undefined ? {} : { evidence: declaration.evidence }),
  };

  const componentsValid =
    isNonNegativeSafeInteger(input) &&
    isNonNegativeSafeInteger(cacheRead) &&
    isNonNegativeSafeInteger(cacheWrite) &&
    isNonNegativeSafeInteger(output) &&
    (reasoning === undefined || isNonNegativeSafeInteger(reasoning));

  if (terminalClass === "aborted") {
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "aborted",
    });
  }
  if (terminalClass === "failed") {
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "failed",
    });
  }
  if (terminalClass === "unsupported") {
    // The provider never committed a final response, so no terminal usage
    // exists; the carried components stay visible but untrustworthy.
    return Object.freeze({
      ...base,
      completeness: "unavailable",
      reason: "unsupported_terminal",
    });
  }

  // `done` terminal from here on.
  if (!componentsValid) {
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "invalid_components",
    });
  }
  if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0) {
    // All-zero is the IR's absence encoding; explicit terminal usage is a
    // hard requirement for Completeness regardless of the declaration.
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "usage_absent",
    });
  }
  if (declaration === undefined) {
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "undeclared_semantics",
    });
  }
  if (
    declaration.inputIncludesCache === "unproven" ||
    declaration.components.input === "defaulted" ||
    declaration.components.cacheRead === "defaulted" ||
    declaration.components.cacheWrite === "defaulted" ||
    declaration.components.output === "defaulted"
  ) {
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "component_unreported",
    });
  }
  if (reasoning !== undefined && reasoning > output) {
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "invalid_components",
    });
  }
  const total = componentSum(input, cacheRead, cacheWrite, output);
  if (total === undefined) {
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "invalid_components",
    });
  }
  if (
    declaration.totalTokens !== "derived" &&
    (!Number.isSafeInteger(record.totalTokens) ||
      record.totalTokens !== total)
  ) {
    // The echoed wire total must agree with the validated component
    // partition; a mismatch means the components do not carry the provider's
    // meaning.
    return Object.freeze({
      ...base,
      completeness: "partial",
      reason: "invalid_components",
    });
  }
  const denominator = input + cacheRead + cacheWrite;
  return Object.freeze({
    ...base,
    normalizedTotal: total,
    ...(denominator > 0 ? { cacheHitRate: cacheRead / denominator } : {}),
    completeness: "complete",
  });
}

/**
 * Strict decoder for persisted/transported snapshot bytes: exact key set,
 * bounded values, and the snapshot invariants (partition identity, reasoning
 * subset, rate bounds, reason/completeness pairing). Returns undefined for
 * anything that is not a trustworthy snapshot — never projects.
 */
export function decodeNormalizedTerminalUsage(
  value: unknown,
): NormalizedTerminalUsage | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set<keyof NormalizedTerminalUsage>([
    "api",
    "input",
    "cacheRead",
    "cacheWrite",
    "output",
    "reasoning",
    "normalizedTotal",
    "cacheHitRate",
    "completeness",
    "reason",
    "evidence",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key as keyof NormalizedTerminalUsage)) return undefined;
  }
  if (
    typeof value.api !== "string" ||
    value.api.length === 0 ||
    value.api.length > MAX_API_LENGTH ||
    !COMPLETENESS_VALUES.includes(value.completeness as UsageCompleteness)
  ) {
    return undefined;
  }
  const completeness = value.completeness as UsageCompleteness;
  const reason = value.reason;
  if (
    (completeness === "complete" && reason !== undefined) ||
    (completeness !== "complete" &&
      (typeof reason !== "string" ||
        !REASON_VALUES.includes(reason as UsageCompletenessReason)))
  ) {
    return undefined;
  }
  const { input, cacheRead, cacheWrite, output } = value;
  const reasoning = value.reasoning;
  const normalizedTotal = value.normalizedTotal;
  const cacheHitRate = value.cacheHitRate;
  const evidence = value.evidence;
  if (
    !isNonNegativeSafeInteger(input) ||
    !isNonNegativeSafeInteger(cacheRead) ||
    !isNonNegativeSafeInteger(cacheWrite) ||
    !isNonNegativeSafeInteger(output) ||
    (reasoning !== undefined && !isNonNegativeSafeInteger(reasoning)) ||
    (normalizedTotal !== undefined &&
      !isNonNegativeSafeInteger(normalizedTotal)) ||
    (cacheHitRate !== undefined && !isRate(cacheHitRate)) ||
    (evidence !== undefined &&
      (typeof evidence !== "string" ||
        evidence.length === 0 ||
        evidence.length > MAX_EVIDENCE_LENGTH))
  ) {
    return undefined;
  }
  if (reasoning !== undefined && reasoning > output) {
    return undefined;
  }
  if (cacheHitRate !== undefined && completeness !== "complete") {
    return undefined;
  }
  if (normalizedTotal !== undefined && completeness !== "complete") {
    return undefined;
  }
  const total = componentSum(input, cacheRead, cacheWrite, output);
  if (total === undefined) return undefined;
  if (completeness === "complete") {
    if (normalizedTotal !== total) return undefined;
    const denominator = input + cacheRead + cacheWrite;
    if (denominator > 0 && cacheHitRate !== cacheRead / denominator) {
      return undefined;
    }
  }
  const snapshot: NormalizedTerminalUsage = {
    api: value.api as string,
    input,
    cacheRead,
    cacheWrite,
    output,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(normalizedTotal === undefined ? {} : { normalizedTotal }),
    ...(cacheHitRate === undefined ? {} : { cacheHitRate }),
    completeness,
    ...(reason === undefined
      ? {}
      : { reason: reason as UsageCompletenessReason }),
    ...(evidence === undefined ? {} : { evidence }),
  };
  return Object.freeze(snapshot);
}
