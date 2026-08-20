import type { Model, Models } from "@earendil-works/pi-ai";

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

const REASONING_LEVELS = Object.freeze([
  Object.freeze({ effort: "low", description: "Fast responses with lighter reasoning" }),
  Object.freeze({ effort: "medium", description: "Balanced reasoning for everyday tasks" }),
  Object.freeze({ effort: "high", description: "Greater reasoning depth for complex tasks" }),
  Object.freeze({ effort: "xhigh", description: "Extra-high reasoning depth for difficult tasks" }),
]);

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

function codexEntry(
  slug: string,
  model: Model<string>,
  priority: number,
  baseInstructions: string,
): CodexCatalogEntry {
  const contextWindow = safeContextWindow(model);
  const supportsImage = model.input.includes("image");
  return Object.freeze({
    slug,
    display_name: slug,
    description: `LuckyToken model: ${slug}`,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    base_instructions: baseInstructions,
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    truncation_policy: Object.freeze({ mode: "tokens", limit: 10_000 }),
    supports_parallel_tool_calls: true,
    supports_image_detail_original: supportsImage,
    supports_search_tool: false,
    experimental_supported_tools: Object.freeze([]),
    input_modalities: Object.freeze([...model.input]),
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: Math.floor(contextWindow * 0.9),
    effective_context_window_percent: 95,
    comp_hash: "luckytoken",
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    ...(model.reasoning
      ? {
          default_reasoning_level: "medium",
          supported_reasoning_levels: REASONING_LEVELS,
        }
      : {}),
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
  const routedBaseInstructions =
    options.nativeCatalogEntries
      ?.map((entry) => entry.base_instructions)
      .find(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      ) ?? "You are a helpful coding assistant.";
  const nativeIds = new Set<string>();
  for (const entry of options.nativeCatalogEntries ?? []) {
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
    entries.push(
      codexEntry(
        entry.alias,
        target,
        entries.length + 1,
        routedBaseInstructions,
      ),
    );
  }

  return Object.freeze({
    content: `${JSON.stringify({ models: entries }, null, 2)}\n`,
    modelCount: entries.length,
    warnings: Object.freeze(warnings),
  });
}
