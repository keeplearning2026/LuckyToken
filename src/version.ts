import { readFileSync } from "node:fs";

// The root package.json is the single source of truth for the release
// version (kept in sync with every package/Cargo/tauri surface by
// scripts/sync-release-version.mjs). The runtime reads it here instead of
// re-declaring a second literal, so the Control Plane hello payload and the
// history/backup authorities can never drift from the installed artifact.

function loadReleaseVersion(): string {
  const version = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      readonly version?: unknown;
    }
  ).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Invalid LuckyToken release version: ${String(version)}`);
  }
  return version;
}

export const LUCKYTOKEN_RELEASE_VERSION: string = loadReleaseVersion();
