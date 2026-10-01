import { createHash } from "node:crypto";

import type { CodexNativeCatalogEntry, CodexNativeCatalogSnapshot } from "./native-catalog-source.js";
import type { ModelsJsonModelDefinition } from "../../providers/models-json.js";

export interface CodexPiModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly tiers?: readonly unknown[];
}

export interface CodexPiModelLike {
  readonly id: string;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly cost?: CodexPiModelCost;
  readonly maxTokens?: number;
  readonly compat?: object;
  readonly provider?: string;
}

export interface CodexModelCandidateEvidence {
  readonly id: string;
  readonly source: "same-generation-sibling" | "conservative-default";
  readonly siblingId?: string;
}

export interface CodexModelCandidateGeneration {
  readonly generation: string;
  readonly candidates: readonly ModelsJsonModelDefinition[];
  readonly warnings: readonly string[];
  readonly evidence: readonly CodexModelCandidateEvidence[];
}

export interface BuildCodexModelCandidatesOptions {
  readonly snapshot: CodexNativeCatalogSnapshot;
  readonly piModels: readonly CodexPiModelLike[];
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelCost = NonNullable<ModelsJsonModelDefinition["cost"]>;
type ModelCompat = NonNullable<ModelsJsonModelDefinition["compat"]>;
type PiModelWithCompat = CodexPiModelLike & { readonly compat: object };

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const CONSERVATIVE_COST: ModelCost = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const CONSERVATIVE_COMPAT: ModelCompat = Object.freeze({
  supportsStrictMode: false,
  supportsDeveloperRole: false,
  supportsLongCacheRetention: false,
  supportsAdditionalTools: false,
  supportsToolSearch: false,
  supportsOpenAIGrammarTools: false,
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function hasDefinedCompat(model: CodexPiModelLike): model is PiModelWithCompat {
  return isRecord(model.compat);
}

/** Same-generation key: id minus its trailing `-<variant>` segment. */
function generationPrefix(id: string): string | undefined {
  const separator = id.lastIndexOf("-");
  if (separator <= 0 || separator === id.length - 1) return id.length > 0 ? id : undefined;
  const prefix = id.slice(0, separator);
  return prefix.length > 0 ? prefix : undefined;
}

function cloneAndDeepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const clone = value.map((item) => cloneAndDeepFreeze(item));
    return Object.freeze(clone) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    clone[key] = cloneAndDeepFreeze(nested);
  }
  return Object.freeze(clone) as unknown as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function collectNativeEfforts(entry: CodexNativeCatalogEntry): ReadonlySet<string> {
  const levels = entry.supported_reasoning_levels;
  if (!Array.isArray(levels)) return new Set();
  const efforts = new Set<string>();
  for (const level of levels) {
    if (!isRecord(level)) continue;
    const effort = level.effort;
    if (typeof effort === "string" && effort.length > 0) efforts.add(effort);
  }
  return efforts;
}

function mapInputModalities(value: unknown): ("text" | "image")[] {
  const input: ("text" | "image")[] = [];
  if (!Array.isArray(value)) return ["text"];
  for (const modality of value) {
    if ((modality === "text" || modality === "image") && !input.includes(modality)) {
      input.push(modality);
    }
  }
  return input.length === 0 ? ["text"] : input;
}

function buildThinkingLevelMap(
  efforts: ReadonlySet<string>,
): Readonly<Record<ThinkingLevel, string | null>> {
  const hasLow = efforts.has("low");
  return Object.freeze({
    // Observed Codex ladders carry no none/off effort; off stays null for that data.
    off: efforts.has("none") ? "none" : null,
    minimal: hasLow ? "low" : null,
    low: hasLow ? "low" : null,
    medium: efforts.has("medium") ? "medium" : null,
    high: efforts.has("high") ? "high" : null,
    xhigh: efforts.has("xhigh") ? "xhigh" : null,
    max: efforts.has("max") ? "max" : null,
  });
}

function resolvePiBase(piModels: readonly CodexPiModelLike[]): {
  readonly api: string;
  readonly baseUrl: string;
} | undefined {
  for (const model of piModels) {
    const api = usableString(model.api);
    const baseUrl = usableString(model.baseUrl);
    if (api !== undefined && baseUrl !== undefined) return { api, baseUrl };
  }
  return undefined;
}

function findSameGenerationSibling(
  id: string,
  piModels: readonly CodexPiModelLike[],
): PiModelWithCompat | undefined {
  const prefix = generationPrefix(id);
  if (prefix === undefined) return undefined;
  for (const model of piModels) {
    if (
      model.id !== id &&
      generationPrefix(model.id) === prefix &&
      hasDefinedCompat(model)
    ) {
      return model;
    }
  }
  return undefined;
}

function copyCost(cost: CodexPiModelCost | undefined): ModelCost {
  if (cost === undefined) return CONSERVATIVE_COST;
  return cloneAndDeepFreeze(cost) as unknown as ModelCost;
}

function copyCompat(compat: object): ModelCompat {
  return cloneAndDeepFreeze(compat) as unknown as ModelCompat;
}

function nativeRowIsListable(entry: CodexNativeCatalogEntry): boolean {
  return entry.visibility === "list" && entry.supported_in_api === true;
}

export function buildCodexModelCandidates(
  options: BuildCodexModelCandidatesOptions,
): CodexModelCandidateGeneration {
  const { snapshot, piModels } = options;
  const warnings: string[] = [...snapshot.warnings];
  const candidates: ModelsJsonModelDefinition[] = [];
  const evidence: CodexModelCandidateEvidence[] = [];
  const piIds = new Set(
    piModels.flatMap((model) => {
      const id = usableString(model.id);
      return id === undefined ? [] : [id];
    }),
  );
  const seenIds = new Set<string>();
  const base = resolvePiBase(piModels);
  const listableRows =
    snapshot.source === "unavailable" ? [] : snapshot.entries.filter(nativeRowIsListable);

  if (base === undefined && listableRows.length > 0) {
    warnings.push(
      "Pi bundled openai-codex base model is unavailable; no native candidates were appended.",
    );
  }

  if (base !== undefined) {
    for (const entry of listableRows) {
      const slug = usableString(entry.slug);
      const displayName = usableString(entry.display_name);
      if (slug === undefined || displayName === undefined || slug.includes("/")) continue;
      if (piIds.has(slug)) continue;
      if (seenIds.has(slug)) {
        warnings.push(
          `Native model catalog contains duplicate slug "${slug}"; keeping the first row.`,
        );
        continue;
      }
      seenIds.add(slug);

      const efforts = collectNativeEfforts(entry);
      const thinkingLevelMap = buildThinkingLevelMap(efforts);
      const reasoning =
        thinkingLevelMap.minimal !== null ||
        thinkingLevelMap.low !== null ||
        thinkingLevelMap.medium !== null ||
        thinkingLevelMap.high !== null ||
        thinkingLevelMap.xhigh !== null ||
        thinkingLevelMap.max !== null;
      const sibling = findSameGenerationSibling(slug, piModels);
      let cost: ModelCost;
      let compat: ModelCompat;
      let maxTokens: number;

      if (sibling === undefined) {
        cost = CONSERVATIVE_COST;
        compat = CONSERVATIVE_COMPAT;
        maxTokens = DEFAULT_MAX_TOKENS;
        warnings.push(
          `No same-generation Pi sibling with compat for native model "${slug}"; using conservative cost/maxTokens/compat.`,
        );
      } else {
        cost = copyCost(sibling.cost);
        compat = copyCompat(sibling.compat);
        maxTokens = sibling.maxTokens ?? DEFAULT_MAX_TOKENS;
      }

      const rawContextWindow = entry.context_window;
      let contextWindow = DEFAULT_CONTEXT_WINDOW;
      if (
        typeof rawContextWindow === "number" &&
        Number.isFinite(rawContextWindow) &&
        rawContextWindow > 0
      ) {
        contextWindow = rawContextWindow;
      } else {
        warnings.push(
          `Native model "${slug}" has invalid context_window; using ${DEFAULT_CONTEXT_WINDOW}.`,
        );
      }

      const definition = deepFreeze({
        id: slug,
        name: displayName,
        api: base.api,
        baseUrl: base.baseUrl,
        reasoning,
        thinkingLevelMap,
        input: mapInputModalities(entry.input_modalities),
        cost,
        contextWindow,
        maxTokens,
        compat,
      } satisfies ModelsJsonModelDefinition);
      candidates.push(definition);
      evidence.push(
        sibling === undefined
          ? Object.freeze({ id: slug, source: "conservative-default" as const })
          : Object.freeze({
              id: slug,
              source: "same-generation-sibling" as const,
              siblingId: sibling.id,
            }),
      );
    }
  }

  const frozenCandidates = Object.freeze(candidates);
  const generation = createHash("sha256")
    .update(stableStringify({ nativeGeneration: snapshot.generation, candidates: frozenCandidates }))
    .digest("hex");

  return Object.freeze({
    generation,
    candidates: frozenCandidates,
    warnings: Object.freeze(warnings),
    evidence: Object.freeze(evidence),
  });
}
