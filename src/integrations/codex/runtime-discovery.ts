import { readdir, stat } from "node:fs/promises";
import { win32 } from "node:path";

/**
 * Codex runtime discovery and platform-safe CLI invocation.
 *
 * One discovery strategy is shared by the native catalog source, the catalog
 * validator, and the external-credential refresh boundary so a catalog
 * failure never disables refresh and refresh never depends on the catalog
 * snapshot. Direct Mode is not changed by this module.
 */

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const NPM_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu;
export const DEBUG_MODEL_ARGS = Object.freeze(["debug", "models", "--bundled"] as const);

export interface CodexDebugModelsInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Readonly<{ windowsVerbatimArguments?: boolean }>;
}

export interface CodexRuntimeDiscoveryOptions {
  readonly codexCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Internal test seam; production discovers explicit/env/Desktop/PATH runtimes. */
  readonly discoverCommands?: () => Promise<readonly string[]>;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function escapeCmdArg(argument: string, doubleEscape: boolean): string {
  let escaped = argument
    .replace(/(\\*)"/gu, '$1$1\\"')
    .replace(/(\\*)$/u, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META, "^$1");
  return doubleEscape ? escaped.replace(CMD_META, "^$1") : escaped;
}

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/** Platform-safe invocation of a Codex CLI command. */
export function codexCliInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CodexDebugModelsInvocation {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
    return Object.freeze({
      file: command,
      args: Object.freeze([...args]),
      options: Object.freeze({}),
    });
  }

  const doubleEscape = NPM_CMD_SHIM.test(command);
  const commandLine = [
    escapeCmdCommand(command),
    ...args.map((argument) => escapeCmdArg(argument, doubleEscape)),
  ].join(" ");
  return Object.freeze({
    file: envValue(env, "ComSpec")?.trim() || "cmd.exe",
    args: Object.freeze(["/d", "/s", "/c", `"${commandLine}"`]),
    options: Object.freeze({ windowsVerbatimArguments: true }),
  });
}

/** Platform-safe invocation of the machine-readable Codex bundled-catalog command. */
export function codexDebugModelsInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CodexDebugModelsInvocation {
  return codexCliInvocation(command, DEBUG_MODEL_ARGS, platform, env);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function windowsDesktopCommands(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const localAppData = envValue(env, "LOCALAPPDATA")?.trim();
  if (!localAppData) return Object.freeze([]);
  const bin = win32.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates: Array<{ readonly path: string; readonly mtimeMs: number }> = [];

  const add = async (path: string): Promise<void> => {
    try {
      const info = await stat(path);
      if (info.isFile()) candidates.push({ path, mtimeMs: info.mtimeMs });
    } catch {
      // Missing/unreadable candidates are simply unavailable runtimes.
    }
  };

  await add(win32.join(bin, "codex.exe"));
  try {
    const entries = await readdir(bin, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => add(win32.join(bin, entry.name, "codex.exe"))),
    );
  } catch {
    return Object.freeze(candidates.map((candidate) => candidate.path));
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return Object.freeze(candidates.map((candidate) => candidate.path));
}

async function windowsPathCommands(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const pathValue = envValue(env, "PATH") ?? "";
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  const candidates: string[] = [];
  for (const rawDirectory of pathValue.split(win32.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = win32.join(directory, `codex${extension}`);
      if (await isFile(candidate)) candidates.push(candidate);
    }
  }
  return Object.freeze(candidates);
}

/** Deterministic Codex runtime candidates: explicit → env → Desktop → PATH. */
export async function discoverCodexCommands(
  options: CodexRuntimeDiscoveryOptions,
): Promise<readonly string[]> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  const explicit = options.codexCommand?.trim();
  if (explicit) candidates.push(explicit);
  const configured = envValue(env, "CODEX_CLI_PATH")?.trim();
  if (configured) candidates.push(configured);

  if (platform === "win32") {
    candidates.push(...(await windowsDesktopCommands(env)));
    candidates.push(...(await windowsPathCommands(env)));
  }
  candidates.push("codex");

  const seen = new Set<string>();
  return Object.freeze(
    candidates.filter((candidate) => {
      const key = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}
