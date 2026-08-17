import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  parseControlPlaneDescriptor,
  type ControlPlaneEndpoint,
} from "@luckytoken/application-control-plane/control-plane";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createBackendSupervisor,
  type BackendChild,
  type BackendSupervisor,
} from "./backend-supervisor.js";

export interface ElectronBackendSupervisorOptions {
  readonly resourcesPath: string;
  readonly desktopExecutable: string;
  readonly packaged: boolean;
  readonly developmentRoot?: string;
  readonly homeDirectory?: string;
}

export interface BundledBackendLaunch {
  readonly executable: string;
  readonly cliScript: string;
  readonly configPath: string;
  readonly descriptorPath: string;
}

export function resolveBundledBackendLaunch(
  options: ElectronBackendSupervisorOptions,
): BundledBackendLaunch {
  const home = options.homeDirectory ?? homedir();
  const backendRoot = options.packaged
    ? join(options.resourcesPath, "backend")
    : join(options.developmentRoot ?? process.cwd(), "backend");
  const userRoot = join(home, ".luckytoken");
  return Object.freeze({
    executable: join(backendRoot, "node", process.platform === "win32" ? "node.exe" : "node"),
    cliScript: join(backendRoot, "dist", "cli.js"),
    configPath: join(userRoot, "config.json"),
    descriptorPath: join(userRoot, "control-plane.json"),
  });
}

async function readEndpoint(path: string): Promise<ControlPlaneEndpoint | undefined> {
  try {
    return parseControlPlaneDescriptor(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

async function probeAndAttach(
  endpoint: ControlPlaneEndpoint,
): Promise<ControlPlaneEndpoint | undefined> {
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  }).catch(() => undefined);
  if (client === undefined) return undefined;
  try {
    const hello = await client.hello(controlPlaneVersion);
    if (hello.type !== "compatible") return undefined;
    await client.executeApplicationCommand({ command: "attach" });
    return endpoint;
  } catch {
    return undefined;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function discoverReadyBackend(
  descriptorPath: string,
): Promise<ControlPlaneEndpoint | undefined> {
  const endpoint = await readEndpoint(descriptorPath);
  return endpoint === undefined ? undefined : probeAndAttach(endpoint);
}

function spawnBundledBackend(
  launch: BundledBackendLaunch,
  desktopExecutable: string,
): BackendChild {
  const child = spawn(
    launch.executable,
    [
      launch.cliScript,
      "serve",
      "--config",
      launch.configPath,
      "--descriptor",
      launch.descriptorPath,
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
    },
  );
  if (child.pid === undefined) {
    child.kill();
    throw new Error("LuckyToken Backend process did not start");
  }
  child.unref();
  return Object.freeze({
    pid: child.pid,
    release(): void {
      child.removeAllListeners();
      child.unref();
    },
  });
}

export function createElectronBackendSupervisor(
  options: ElectronBackendSupervisorOptions,
): BackendSupervisor {
  const launch = resolveBundledBackendLaunch(options);
  return createBackendSupervisor({
    discoverReadyBackend: () => discoverReadyBackend(launch.descriptorPath),
    spawnBackend: async () => spawnBundledBackend(launch, options.desktopExecutable),
    waitForReadyBackend: async () => {
      let last: ControlPlaneEndpoint | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        last = await discoverReadyBackend(launch.descriptorPath);
        if (last !== undefined) return last;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("LuckyToken Backend did not become ready");
    },
  });
}
