import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CLAUDE_DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-746f6b656e00";

export interface ClaudeDesktopPaths {
  readonly standardConfig: string;
  readonly threePartyConfig: string;
  readonly libraryDirectory: string;
  readonly metadata: string;
  readonly tokenProfile: string;
}

export interface ClaudeDesktopPathEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly localAppData?: string;
  readonly xdgConfigHome?: string;
}

export function resolveClaudeDesktopPaths(environment: ClaudeDesktopPathEnvironment = {}): ClaudeDesktopPaths {
  const platform = environment.platform ?? process.platform;
  const home = environment.home ?? homedir();
  let parent: string;
  switch (platform) {
    case "win32":
      parent = environment.localAppData || process.env.LOCALAPPDATA || join(home, "AppData", "Local");
      break;
    case "darwin":
      parent = join(home, "Library", "Application Support");
      break;
    case "linux": {
      const xdg = environment.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
      parent = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
      break;
    }
    default:
      throw new Error(`Claude Desktop integration is unsupported on ${platform}.`);
  }
  const standard = join(parent, "Claude");
  const threeParty = join(parent, "Claude-3p");
  const libraryDirectory = join(threeParty, "configLibrary");
  return Object.freeze({
    standardConfig: join(standard, "claude_desktop_config.json"),
    threePartyConfig: join(threeParty, "claude_desktop_config.json"),
    libraryDirectory,
    metadata: join(libraryDirectory, "_meta.json"),
    tokenProfile: join(libraryDirectory, `${CLAUDE_DESKTOP_PROFILE_ID}.json`),
  });
}
