import { spawnSync } from "node:child_process";

/** Windows login auto-start: the owner process registers and queries its own
 *  launch command through the per-user Run registry key. The registrar is
 *  the thin native seam; tests inject an in-memory registrar. */

export type AutoStartAction = "status" | "enable" | "disable";

export interface AutoStartRegistrar {
  enable(): Promise<void>;
  disable(): Promise<void>;
  status(): Promise<{ readonly enabled: boolean }>;
}

export class AutoStartUnsupportedError extends Error {
  readonly code = "AUTO_START_UNSUPPORTED";

  constructor() {
    super("Windows login auto-start is unsupported on this platform");
    this.name = "AutoStartUnsupportedError";
  }
}

export interface AutoStartExecution {
  readonly outcome: "ok" | "failed" | "unsupported";
  /** Effective registration status; present only for successful outcomes. */
  readonly enabled?: boolean;
  readonly error?: string;
}

export async function executeAutoStart(
  registrar: AutoStartRegistrar,
  action: AutoStartAction,
): Promise<AutoStartExecution> {
  try {
    if (action === "status") {
      return { outcome: "ok", enabled: (await registrar.status()).enabled };
    }
    if (action === "enable") await registrar.enable();
    else await registrar.disable();
    return { outcome: "ok", enabled: (await registrar.status()).enabled };
  } catch (error) {
    if (error instanceof AutoStartUnsupportedError) {
      return { outcome: "unsupported" };
    }
    return {
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Registry value under HKCU\...\Run that Windows executes at sign-in. */
export const windowsRunKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export function buildWindowsAutoStartCommand(
  executable: string,
  args: readonly string[],
): string {
  // The Run key value is parsed like a cmd.exe command line at sign-in:
  // quote arguments containing spaces and double any embedded quotes.
  const quote = (value: string): string =>
    /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
  return [quote(executable), ...args.map(quote)].join(" ");
}

export interface ServeAutoStartCommandOptions {
  readonly ownerKind: "cli" | "desktop";
  readonly nodeExecutable: string;
  readonly cliScript: string;
  readonly configPath: string;
  /** The desktop executable path, known only when a desktop shell launched
   *  (or will launch) the backend. */
  readonly desktopExe?: string;
}

/** The Windows sign-in command for the serve owner. A desktop-owned backend
 *  registers the desktop executable alone: the desktop shell is the sign-in
 *  entry point and re-spawns its backend when no instance exists. A cli
 *  owner (or a desktop owner without a known exe path) registers the node
 *  CLI serve command directly. */
export function buildServeAutoStartCommand(
  options: ServeAutoStartCommandOptions,
): string {
  if (options.ownerKind === "desktop" && options.desktopExe !== undefined) {
    return buildWindowsAutoStartCommand(options.desktopExe, []);
  }
  return buildWindowsAutoStartCommand(options.nodeExecutable, [
    options.cliScript,
    "serve",
    "--config",
    options.configPath,
    ...(options.ownerKind === "desktop" ? ["--owner", "desktop"] : []),
  ]);
}

export interface WindowsAutoStartRegistrarOptions {
  /** Registry value name, e.g. "Token". */
  readonly name: string;
  /** Full command line registered at sign-in. */
  readonly command: string;
  /** Inject the reg.exe runner for tests; defaults to spawnSync. */
  readonly run?: (
    args: readonly string[],
  ) => { readonly status: number; readonly stderr: string };
}

function defaultRun(args: readonly string[]): {
  readonly status: number;
  readonly stderr: string;
} {
  const result = spawnSync("reg.exe", [...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? "" };
}

export function createWindowsAutoStartRegistrar(
  options: WindowsAutoStartRegistrarOptions,
): AutoStartRegistrar {
  const run = options.run ?? defaultRun;
  return {
    async enable() {
      const result = run([
        "add",
        windowsRunKey,
        "/v",
        options.name,
        "/t",
        "REG_SZ",
        "/d",
        options.command,
        "/f",
      ]);
      if (result.status !== 0) {
        throw new Error(
          `Windows login auto-start could not be enabled${
            result.stderr.trim().length === 0
              ? ""
              : `: ${result.stderr.trim()}`
          }`,
        );
      }
    },
    async disable() {
      const result = run(["delete", windowsRunKey, "/v", options.name, "/f"]);
      // Exit code 1 means the value was not registered: disabling an
      // already-disabled registration is idempotent success.
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(
          `Windows login auto-start could not be disabled${
            result.stderr.trim().length === 0
              ? ""
              : `: ${result.stderr.trim()}`
          }`,
        );
      }
    },
    async status() {
      const result = run(["query", windowsRunKey, "/v", options.name]);
      return { enabled: result.status === 0 };
    },
  };
}

export function createUnsupportedAutoStartRegistrar(): AutoStartRegistrar {
  return {
    async enable() {
      throw new AutoStartUnsupportedError();
    },
    async disable() {
      throw new AutoStartUnsupportedError();
    },
    async status() {
      return { enabled: false };
    },
  };
}
