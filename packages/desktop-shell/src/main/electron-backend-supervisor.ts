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
  readonly buildIdPath: string;
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
    buildIdPath: join(backendRoot, "build-id.txt"),
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

async function readBackendBuildId(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("LuckyToken bundled Backend build identity is invalid");
  }
  return value;
}

async function retireStaleDesktopBackend(
  client: Awaited<ReturnType<typeof connectControlPlane>>,
): Promise<void> {
  const result = await client.executeApplicationCommand({
    command: "quit",
    acknowledged: true,
  });
  if (result.outcome !== "drained" && result.outcome !== "timed_out") {
    throw new Error("Stale LuckyToken desktop Backend could not be replaced");
  }
  await Promise.race([
    client.disconnected,
    new Promise<void>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("Stale LuckyToken desktop Backend did not exit")),
        5_000,
      ),
    ),
  ]);
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
}

async function probeAndAttach(
  endpoint: ControlPlaneEndpoint,
  expectedBuildId: string,
): Promise<ControlPlaneEndpoint | undefined> {
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  }).catch(() => undefined);
  if (client === undefined) return undefined;
  try {
    const hello = await client.hello(controlPlaneVersion);
    if (hello.type !== "compatible") return undefined;
    if (hello.application.buildId !== expectedBuildId) {
      const status = await client.getStatus();
      if (status.ownership?.owner.kind === "desktop") {
        await retireStaleDesktopBackend(client);
        return undefined;
      }
      // An explicitly headless/CLI-owned application keeps authority even if
      // its build differs. Desktop attaches rather than stealing ownership.
    }
    await client.executeApplicationCommand({ command: "attach" });
    return endpoint;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Stale LuckyToken desktop Backend could not be replaced" ||
        error.message === "Stale LuckyToken desktop Backend did not exit")
    ) {
      throw error;
    }
    return undefined;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function discoverReadyBackend(
  descriptorPath: string,
  expectedBuildId: string,
): Promise<ControlPlaneEndpoint | undefined> {
  const endpoint = await readEndpoint(descriptorPath);
  return endpoint === undefined
    ? undefined
    : probeAndAttach(endpoint, expectedBuildId);
}

function spawnBundledBackend(
  launch: BundledBackendLaunch,
  desktopExecutable: string,
  buildId: string,
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
      env: {
        ...process.env,
        LUCKYTOKEN_BACKEND_BUILD_ID: buildId,
      },
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
  let buildIdPromise: Promise<string> | undefined;
  const buildId = (): Promise<string> =>
    (buildIdPromise ??= readBackendBuildId(launch.buildIdPath));
  return createBackendSupervisor({
    discoverReadyBackend: async () =>
      discoverReadyBackend(launch.descriptorPath, await buildId()),
    spawnBackend: async () =>
      spawnBundledBackend(launch, options.desktopExecutable, await buildId()),
    waitForReadyBackend: async () => {
      const expectedBuildId = await buildId();
      let last: ControlPlaneEndpoint | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        last = await discoverReadyBackend(
          launch.descriptorPath,
          expectedBuildId,
        );
        if (last !== undefined) return last;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("LuckyToken Backend did not become ready");
    },
  });
}
