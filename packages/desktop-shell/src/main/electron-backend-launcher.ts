import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  BackendLauncher,
  ProcessExit,
  SpawnedBackend,
} from "./backend-launcher.js";

export interface ElectronBackendLauncherOptions {
  readonly resourcesPath: string;
  readonly desktopExecutable: string;
  readonly packaged: boolean;
  readonly developmentRoot?: string;
  readonly homeDirectory?: string;
}

export interface BundledBackendLaunch {
  readonly executable: string;
  readonly cliScript: string;
  readonly buildIdPath: string;
  readonly configPath: string;
  readonly descriptorPath: string;
}

export function resolveBundledBackendLaunch(
  options: ElectronBackendLauncherOptions,
): BundledBackendLaunch {
  const home = options.homeDirectory ?? homedir();
  const backendRoot = options.packaged
    ? join(options.resourcesPath, "backend")
    : join(options.developmentRoot ?? process.cwd(), "backend");
  const userRoot = join(home, ".Token");
  return Object.freeze({
    executable: join(
      backendRoot,
      "node",
      process.platform === "win32" ? "node.exe" : "node",
    ),
    cliScript: join(backendRoot, "dist", "cli.js"),
    buildIdPath: join(backendRoot, "build-id.txt"),
    configPath: join(userRoot, "config.json"),
    descriptorPath: join(userRoot, "control-plane.json"),
  });
}

export async function readBundledBackendBuildId(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Token bundled Backend build identity is invalid");
  }
  return value;
}

function spawnBundledBackend(
  launch: BundledBackendLaunch,
  desktopExecutable: string,
  buildId: string,
): SpawnedBackend {
  const child = spawn(
    launch.executable,
    [
      launch.cliScript,
      "serve",
      "--config",
      launch.configPath,
      "--owner",
      "desktop",
      "--desktop-exe",
      desktopExecutable,
      "--create-first-run-config",
    ],
    {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TOKEN_BACKEND_BUILD_ID: buildId,
      },
    },
  );
  if (child.pid === undefined) {
    // Node reports spawn failures such as ENOENT asynchronously through the
    // ChildProcess error event. There is no process to kill in this branch;
    // on Windows kill() itself throws EINVAL. Consume the pending error so the
    // launcher can fail through its own stable startup contract instead.
    child.once("error", () => undefined);
    throw new Error("Token Backend process did not start");
  }

  let released = false;
  let resolveExited!: (exit: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExited = resolve;
  });
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    resolveExited(Object.freeze({ code, signal }));
  };
  child.once("exit", onExit);
  child.unref();

  return Object.freeze({
    pid: child.pid,
    exited,
    release(): void {
      if (released) return;
      released = true;
      child.removeListener("exit", onExit);
      child.unref();
    },
  });
}

export function createElectronBackendLauncher(
  options: ElectronBackendLauncherOptions,
): BackendLauncher {
  const launch = resolveBundledBackendLaunch(options);
  let buildIdPromise: Promise<string> | undefined;
  const buildId = (): Promise<string> =>
    (buildIdPromise ??= readBundledBackendBuildId(launch.buildIdPath));
  return Object.freeze({
    async launch(): Promise<SpawnedBackend> {
      return spawnBundledBackend(
        launch,
        options.desktopExecutable,
        await buildId(),
      );
    },
  });
}
