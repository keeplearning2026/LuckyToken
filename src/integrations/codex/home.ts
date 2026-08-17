import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolve the Codex-owned home. LuckyToken only observes this location. */
export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string {
  const configured = env.CODEX_HOME?.trim();
  return configured && configured.length > 0
    ? resolve(configured)
    : join(home(), ".codex");
}
