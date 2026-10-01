import type { CodexModelCandidateGeneration } from "../integrations/codex/codex-model-candidates.js";

type Candidate = CodexModelCandidateGeneration["candidates"][number];

export interface ApplyAutomaticModelOverlayOptions {
  readonly providers: Readonly<Record<string, unknown>>;
  readonly overlay: CodexModelCandidateGeneration | undefined;
  readonly providerId: string;
}

interface ParsedProviderEntry {
  readonly entry: Readonly<Record<string, unknown>>;
  readonly models: readonly unknown[];
  readonly definedIds: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderEntry(value: unknown): ParsedProviderEntry | undefined {
  if (!isRecord(value)) return undefined;
  const rawModels = value.models;
  if (rawModels !== undefined && !Array.isArray(rawModels)) return undefined;
  const models = rawModels ?? [];
  const definedIds = new Set<string>();
  for (const model of models) {
    if (!isRecord(model)) return undefined;
    const id = model.id;
    if (typeof id !== "string" || id.length === 0) return undefined;
    definedIds.add(id);
  }
  const modelOverrides = value.modelOverrides;
  if (modelOverrides !== undefined) {
    if (!isRecord(modelOverrides)) return undefined;
  }
  return { entry: value, models, definedIds };
}

function candidatesToAppend(
  candidates: readonly Candidate[],
  definedIds: ReadonlySet<string>,
): Candidate[] {
  const appended: Candidate[] = [];
  const seenIds = new Set<string>();
  for (const candidate of candidates) {
    if (definedIds.has(candidate.id) || seenIds.has(candidate.id)) continue;
    seenIds.add(candidate.id);
    appended.push(candidate);
  }
  return appended;
}

export function applyAutomaticModelOverlay(
  options: ApplyAutomaticModelOverlayOptions,
): Readonly<Record<string, unknown>> {
  const { providers, overlay, providerId } = options;
  if (overlay === undefined || overlay.candidates.length === 0) return providers;

  const current = providers[providerId];
  if (current === undefined) {
    const appended = candidatesToAppend(overlay.candidates, new Set());
    if (appended.length === 0) return providers;
    return Object.freeze({
      ...providers,
      [providerId]: Object.freeze({ models: Object.freeze(appended) }),
    });
  }

  const parsed = parseProviderEntry(current);
  if (parsed === undefined) return providers;
  const appended = candidatesToAppend(overlay.candidates, parsed.definedIds);
  if (appended.length === 0) return providers;

  return Object.freeze({
    ...providers,
    [providerId]: Object.freeze({
      ...parsed.entry,
      models: Object.freeze([...parsed.models, ...appended]),
    }),
  });
}
