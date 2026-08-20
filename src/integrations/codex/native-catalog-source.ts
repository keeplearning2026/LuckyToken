import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const NPM_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu;
const DEBUG_MODEL_ARGS = Object.freeze(["debug", "models", "--bundled"] as const);

export type CodexNativeCatalogEntry = Readonly<Record<string, unknown>> & {
  readonly slug: string;
};

export interface CodexNativeCatalogSnapshot {
  readonly source: "bundled" | "models-cache" | "unavailable";
  readonly entries: readonly CodexNativeCatalogEntry[];
  readonly warnings: readonly string[];
}

export interface CodexNativeCatalogSource {
  load(): Promise<CodexNativeCatalogSnapshot>;
}

export interface CodexDebugModelsInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Readonly<{ windowsVerbatimArguments?: boolean }>;
}

export interface CreateCodexNativeCatalogSourceOptions {
  readonly codexHome: string;
  readonly codexCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly runBundledCatalog?: (command: string) => Promise<string>;
  /** Internal test seam; production discovers explicit/env/Desktop/PATH runtimes. */
  readonly discoverCommands?: () => Promise<readonly string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNativeEntries(raw: string): readonly CodexNativeCatalogEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined;
  return Object.freeze(
    parsed.models.flatMap((entry): CodexNativeCatalogEntry[] => {
      if (!isRecord(entry)) return [];
      const slug = entry.slug;
      if (typeof slug !== "string" || slug.length === 0 || slug.includes("/")) return [];
      return [Object.freeze({ ...entry, slug }) as CodexNativeCatalogEntry];
    }),
  );
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

/** Platform-safe invocation of the machine-readable Codex bundled-catalog command. */
export function codexDebugModelsInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CodexDebugModelsInvocation {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
    return Object.freeze({
      file: command,
      args: Object.freeze([...DEBUG_MODEL_ARGS]),
      options: Object.freeze({}),
    });
  }

  const doubleEscape = NPM_CMD_SHIM.test(command);
  const commandLine = [
    escapeCmdCommand(command),
    ...DEBUG_MODEL_ARGS.map((argument) => escapeCmdArg(argument, doubleEscape)),
  ].join(" ");
  return Object.freeze({
    file: envValue(env, "ComSpec")?.trim() || "cmd.exe",
    args: Object.freeze(["/d", "/s", "/c", `"${commandLine}"`]),
    options: Object.freeze({ windowsVerbatimArguments: true }),
  });
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

async function discoverCodexCommands(
  options: CreateCodexNativeCatalogSourceOptions,
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

async function runBundledCatalog(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const invocation = codexDebugModelsInvocation(command, platform, env);
  const result = await execFileAsync(invocation.file, [...invocation.args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    ...invocation.options,
  });
  return result.stdout;
}

async function readModelsCache(codexHome: string): Promise<readonly CodexNativeCatalogEntry[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(codexHome, "models_cache.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseNativeEntries(raw);
}

/**
 * Read one Codex-owned native model snapshot. The installed Codex bundled
 * catalog is authoritative when available; the user's models cache is a
 * read-only fallback. LuckyToken never reconstructs native identity from Pi.
 */
export function createCodexNativeCatalogSource(
  options: CreateCodexNativeCatalogSourceOptions,
): CodexNativeCatalogSource {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const discover = options.discoverCommands ?? (() => discoverCodexCommands(options));
  const bundled =
    options.runBundledCatalog ??
    ((command: string) => runBundledCatalog(command, platform, env));

  return Object.freeze({
    async load(): Promise<CodexNativeCatalogSnapshot> {
      const commands = await discover().catch(() => Object.freeze([]));
      for (const command of commands) {
        try {
          const entries = parseNativeEntries(await bundled(command));
          if (entries !== undefined) {
            return Object.freeze({
              source: "bundled" as const,
              entries,
              warnings: Object.freeze([]),
            });
          }
        } catch {
          // Try the next discovered runtime. Discovery faults are metadata
          // availability problems and never disable routed LuckyToken models.
        }
      }

      try {
        const entries = await readModelsCache(options.codexHome);
        if (entries !== undefined) {
          return Object.freeze({
            source: "models-cache" as const,
            entries,
            warnings: Object.freeze([
              "Codex bundled model catalog is unavailable; using models_cache.json.",
            ]),
          });
        }
      } catch {
        // A malformed/unreadable cache is the same unavailable metadata state.
      }

      return Object.freeze({
        source: "unavailable" as const,
        entries: Object.freeze([]),
        warnings: Object.freeze(["Codex native model metadata is unavailable."]),
      });
    },
  });
}
