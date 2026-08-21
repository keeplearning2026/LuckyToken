import {
  parseControlPlaneDescriptor,
  type ControlPlaneEndpoint,
} from "@luckytoken/application-control-plane/control-plane";
import { readFile } from "node:fs/promises";

import {
  createDesktopBackendConnection,
  type DesktopBackendConnection,
} from "./desktop-backend-connection.js";
import {
  createElectronBackendLauncher,
  readBundledBackendBuildId,
  resolveBundledBackendLaunch,
  type ElectronBackendLauncherOptions,
} from "./electron-backend-launcher.js";
import type { ControlPlaneSession } from "./control-plane-session.js";
import type { DesktopOwnerLeaseClient } from "./desktop-owner-lease.js";

export interface ElectronBackendConnectionOptions
  extends ElectronBackendLauncherOptions {
  readonly session: ControlPlaneSession;
  readonly desktopOwnerLease: DesktopOwnerLeaseClient;
  readonly onRecoveryFailure?: (error: unknown) => void;
}

async function readEndpoint(
  path: string,
): Promise<ControlPlaneEndpoint | undefined> {
  try {
    return parseControlPlaneDescriptor(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function createElectronBackendConnection(
  options: ElectronBackendConnectionOptions,
): DesktopBackendConnection {
  const launch = resolveBundledBackendLaunch(options);
  const launcher = createElectronBackendLauncher(options);
  let buildIdPromise: Promise<string> | undefined;
  return createDesktopBackendConnection({
    discovery: {
      read: () => readEndpoint(launch.descriptorPath),
    },
    launcher,
    session: options.session,
    desktopOwnerLease: options.desktopOwnerLease,
    expectedBuildId: () =>
      (buildIdPromise ??= readBundledBackendBuildId(launch.buildIdPath)),
    ...(options.onRecoveryFailure === undefined
      ? {}
      : { onRecoveryFailure: options.onRecoveryFailure }),
  });
}
