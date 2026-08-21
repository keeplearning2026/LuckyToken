import {
  getSupportedThinkingLevels,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";

import type { CodexCatalogBuildResult } from "./integration.js";

export interface CodexCatalogAliasEntry {
  readonly alias: string;
  readonly target: {
    readonly providerId: string;
    readonly modelId: string;
  };
}

export interface BuildCodexCatalogOptions {
  readonly nativeCatalogEntries?: readonly Readonly<Record<string, unknown>>[];
  readonly models: Pick<Models, "getModels">;
  readonly aliases: readonly CodexCatalogAliasEntry[];
}

interface CodexCatalogEntry extends Record<string, unknown> {
  readonly slug: string;
}

const ROUTED_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent powered by the selected model.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasoningDescriptions(
  nativeEntries: readonly Readonly<Record<string, unknown>>[],
): ReadonlyMap<string, string> {
  const descriptions = new Map<string, string>();
  for (const entry of nativeEntries) {
    if (!Array.isArray(entry.supported_reasoning_levels)) continue;
    for (const level of entry.supported_reasoning_levels) {
      if (!isRecord(level)) continue;
      const effort = level.effort;
      const description = level.description;
      if (
        typeof effort === "string" &&
        effort.length > 0 &&
        typeof description === "string" &&
        description.length > 0 &&
        !descriptions.has(effort)
      ) {
        descriptions.set(effort, description);
      }
    }
  }
  return descriptions;
}

function supportedReasoningLevels(
  model: Model<string>,
  descriptions: ReadonlyMap<string, string>,
): readonly Readonly<{ effort: string; description: string }>[] {
  if (!model.reasoning) return Object.freeze([]);
  return Object.freeze(
    getSupportedThinkingLevels(model).flatMap((effort) => {
      if (effort === "off") return [];
      const description = descriptions.get(effort);
      return description === undefined
        ? []
        : [Object.freeze({ effort, description })];
    }),
  );
}

function routedBaseInstructions(
  nativeEntries: readonly Readonly<Record<string, unknown>>[],
): string {
  const source = nativeEntries
    .map((entry) => entry.base_instructions)
    .find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
  if (source === undefined) return ROUTED_BASE_INSTRUCTIONS;
  return source.replace(
    /^You are Codex, an agent based on GPT-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*\./u,
    ROUTED_BASE_INSTRUCTIONS,
  );
}

function slashCount(value: string): number {
  let count = 0;
  for (const character of value) if (character === "/") count += 1;
  return count;
}

function safeContextWindow(model: Model<string>): number {
  return Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : 128_000;
}

function codexInputModalities(model: Model<string>): readonly ("text" | "image")[] {
  const supported = model.input.filter(
    (modality): modality is "text" | "image" =>
      modality === "text" || modality === "image",
  );
  return Object.freeze(supported.length === 0 ? ["text"] : [...supported]);
}

function codexEntry(
  slug: string,
  model: Model<string>,
  priority: number,
  baseInstructions: string,
  reasoningLevels: readonly Readonly<{
    effort: string;
    description: string;
  }>[],
): CodexCatalogEntry {
  const contextWindow = safeContextWindow(model);
  return Object.freeze({
    slug,
    display_name: slug,
    description: `LuckyToken model: ${slug}`,
    supported_reasoning_levels: reasoningLevels,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    base_instructions: baseInstructions,
    prefer_websockets: false,
    support_verbosity: false,
    apply_patch_tool_type: "freeform",
    truncation_policy: Object.freeze({ mode: "tokens", limit: 10_000 }),
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    supports_search_tool: false,
    experimental_supported_tools: Object.freeze([]),
    input_modalities: codexInputModalities(model),
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    supports_reasoning_summaries: false,
  });
}

/**
 * Project the current LuckyToken model surface into a Codex-facing catalog.
 * Native Codex models keep bare ids; Pi targets appear only through explicit,
 * currently-callable aliases. Alias syntax remains globally opaque — Codex's
 * one-slash metadata limitation is enforced only at this projection boundary.
 */
export function buildCodexCatalog(
  options: BuildCodexCatalogOptions,
): CodexCatalogBuildResult {
  const entries: CodexCatalogEntry[] = [];
  const warnings: string[] = [];
  const nativeCatalogEntries = options.nativeCatalogEntries ?? [];
  const baseInstructions = routedBaseInstructions(nativeCatalogEntries);
  const descriptions = reasoningDescriptions(nativeCatalogEntries);
  const nativeIds = new Set<string>();
  for (const entry of nativeCatalogEntries) {
    const slug = entry.slug;
    if (
      typeof slug !== "string" ||
      slug.length === 0 ||
      slug.includes("/") ||
      nativeIds.has(slug)
    ) {
      continue;
    }
    nativeIds.add(slug);
    entries.push(Object.freeze({ ...entry, slug }) as CodexCatalogEntry);
  }
  let nextRoutedPriority =
    entries.reduce((maximum, entry) => {
      const priority = entry.priority;
      return typeof priority === "number" && Number.isSafeInteger(priority)
        ? Math.max(maximum, priority)
        : maximum;
    }, 0) + 1;

  const callable = new Map(
    options.models
      .getModels()
      .map((model) => [`${model.provider}\u0000${model.id}`, model] as const),
  );
  const aliases = [...options.aliases].sort((a, b) =>
    a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0,
  );
  for (const entry of aliases) {
    if (nativeIds.has(entry.alias)) {
      warnings.push(
        `Alias "${entry.alias}" is not exposed to Codex because a native Codex model owns that id.`,
      );
      continue;
    }
    if (slashCount(entry.alias) > 1) {
      warnings.push(
        `Alias "${entry.alias}" is not exposed to Codex because Codex model metadata lookup does not support multiple '/' segments.`,
      );
      continue;
    }
    const target = callable.get(
      `${entry.target.providerId}\u0000${entry.target.modelId}`,
    );
    if (target === undefined) {
      warnings.push(
        `Alias "${entry.alias}" is not exposed to Codex because its target is not callable.`,
      );
      continue;
    }
    const reasoningLevels = supportedReasoningLevels(target, descriptions);
    if (target.reasoning && reasoningLevels.length === 0) {
      warnings.push(
        `Alias "${entry.alias}" exposes no reasoning controls because its Pi capabilities and the installed Codex vocabulary do not overlap.`,
      );
    }
    entries.push(
      codexEntry(
        entry.alias,
        target,
        nextRoutedPriority,
        baseInstructions,
        reasoningLevels,
      ),
    );
    nextRoutedPriority += 1;
  }

  return Object.freeze({
    content: `${JSON.stringify({ models: entries }, null, 2)}\n`,
    modelCount: entries.length,
    warnings: Object.freeze(warnings),
  });
}
