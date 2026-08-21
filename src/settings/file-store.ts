import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SettingsStore } from "./catalog.js";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

/**
 * File-backed registered settings store. Persists only validated settings;
 * the registry owns validation and the authoritative defaults. The file is
 * written atomically via a temporary file and rename.
 */
export function createFileSettingsStore(path: string): SettingsStore {
  let loaded = false;
  let loadPromise: Promise<Record<string, unknown>> | undefined;
  let current: Record<string, unknown> = {};
  const store: SettingsStore = {
    load() {
      if (loaded) return Promise.resolve({ ...current });
      loadPromise ??= (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            loaded = true;
            return { ...current };
          }
          throw new Error(`Failed to read Settings file at ${path}`);
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error(`Settings file at ${path} is not a JSON object`);
        }
        current = parsed as Record<string, unknown>;
        loaded = true;
        return { ...current };
      })().catch((error: unknown) => {
        loadPromise = undefined;
        throw error;
      });
      return loadPromise;
    },
    async save(next: Readonly<Record<string, unknown>>) {
      const serialized = JSON.stringify(next, null, 2);
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(temporaryPath, serialized, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporaryPath, path);
        current = { ...next };
        loaded = true;
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
  return Object.freeze(store);
}
