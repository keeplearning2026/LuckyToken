import { readFile } from "node:fs/promises";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads Codex-owned native model metadata. LuckyToken never writes this cache;
 * Pi's openai-codex catalog remains the authority for which model ids are
 * eligible, while this source contributes only Codex-specific picker/runtime
 * metadata for matching bare slugs.
 */
export async function readCodexNativeCatalogEntries(
  codexHome: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  let raw: string;
  try {
    raw = await readFile(join(codexHome, "models_cache.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return Object.freeze([]);
  return Object.freeze(
    parsed.models.flatMap((entry): Readonly<Record<string, unknown>>[] => {
      if (!isRecord(entry)) return [];
      const slug = entry.slug;
      if (typeof slug !== "string" || slug.length === 0 || slug.includes("/")) {
        return [];
      }
      return [Object.freeze({ ...entry })];
    }),
  );
}
