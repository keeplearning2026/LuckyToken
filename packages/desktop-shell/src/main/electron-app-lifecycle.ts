import { join } from "node:path";

export interface SecureManagementWindowOptions {
  readonly show: false;
  readonly webPreferences: Readonly<{
    preload: string;
    nodeIntegration: false;
    contextIsolation: true;
    sandbox: true;
    webSecurity: true;
  }>;
}

export function createSecureManagementWindowOptions(
  preload: string,
): SecureManagementWindowOptions {
  return Object.freeze({
    show: false,
    webPreferences: Object.freeze({
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    }),
  });
}

export interface TrayActions {
  readonly open: () => void;
  readonly quit: () => void;
}

export interface ProductQuitDependencies {
  readonly backendOwnerKind: () => "cli" | "desktop" | undefined;
  readonly requestBackendQuit: () => Promise<{
    readonly outcome: string;
  }>;
  readonly quitDesktop: () => void;
  readonly onFailure?: () => void;
}

/**
 * Explicit product Quit is ownership-aware Backend shutdown followed by
 * Electron exit. Closing the management window is a different operation.
 */
export async function quitLuckyTokenProduct(
  dependencies: ProductQuitDependencies,
): Promise<boolean> {
  const ownerKind = dependencies.backendOwnerKind();
  if (ownerKind === "cli") {
    // An attached headless/CLI Backend has an independent legitimate owner.
    // Tray Quit closes only this Electron shell and never steals ownership.
    dependencies.quitDesktop();
    return true;
  }
  if (ownerKind !== "desktop") {
    dependencies.onFailure?.();
    return false;
  }
  try {
    const result = await dependencies.requestBackendQuit();
    if (result.outcome !== "drained" && result.outcome !== "timed_out") {
      dependencies.onFailure?.();
      return false;
    }
    dependencies.quitDesktop();
    return true;
  } catch {
    dependencies.onFailure?.();
    return false;
  }
}

export interface DesktopInstanceIsolationOptions {
  readonly executablePath: string;
  readonly appDataPath: string;
  readonly buildId: string;
}

/**
 * Repository-packaged `.electron-out` builds are disposable test artifacts,
 * not installed product revisions. They must never contend with an older
 * installed/test build for Electron's profile/single-instance domain. LuckyToken
 * product state remains in `~/.luckytoken`; this path isolates only Chromium /
 * Electron shell state and the instance lock.
 */
export function desktopInstanceUserDataPath(
  options: DesktopInstanceIsolationOptions,
): string | undefined {
  const executable = options.executablePath.replaceAll("\\", "/").toLowerCase();
  if (!executable.includes("/.electron-out/")) return undefined;
  return join(
    options.appDataPath,
    "@luckytoken",
    "desktop-shell-builds",
    options.buildId.slice(0, 32),
  );
}

export interface DesktopInstanceActivation {
  readonly contract: "luckytoken-desktop-instance-v1";
  readonly buildId: string;
  readonly attempt: "initial" | "handoff_retry";
}

function decodeDesktopInstanceActivation(
  value: unknown,
): DesktopInstanceActivation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.contract !== "luckytoken-desktop-instance-v1" ||
    typeof record.buildId !== "string" ||
    record.buildId.length === 0 ||
    (record.attempt !== "initial" && record.attempt !== "handoff_retry")
  ) {
    return undefined;
  }
  return Object.freeze({
    contract: "luckytoken-desktop-instance-v1",
    buildId: record.buildId,
    attempt: record.attempt,
  });
}

export interface ElectronDesktopLifecycleDependencies {
  readonly buildId: string;
  readonly requestSingleInstanceLock: (
    activation: DesktopInstanceActivation,
  ) => boolean;
  readonly releaseSingleInstanceLock: () => void;
  readonly waitForPrimaryHandoff: () => Promise<void>;
  readonly whenReady: () => Promise<void>;
  readonly onSecondInstance: (listener: (activation: unknown) => void) => void;
  readonly onWindowAllClosed: (listener: () => void) => void;
  /** Local Electron-only exit. Never attempts to stop the Backend. */
  readonly exitDesktop: () => void;
  /** Explicit user product quit: drains/stops Backend, then exits Electron. */
  readonly quitProduct: () => void;
  readonly openWindow: () => void;
  readonly createTray: (actions: TrayActions) => void;
}

export async function startElectronDesktopLifecycle(
  dependencies: ElectronDesktopLifecycleDependencies,
): Promise<"primary" | "secondary"> {
  const activation = (
    attempt: DesktopInstanceActivation["attempt"],
  ): DesktopInstanceActivation =>
    Object.freeze({
      contract: "luckytoken-desktop-instance-v1" as const,
      buildId: dependencies.buildId,
      attempt,
    });

  if (!dependencies.requestSingleInstanceLock(activation("initial"))) {
    // A different fixed build may release the lock in response to the
    // first activation so this exact process can take over without killing
    // the Backend. Same-build activation keeps the lock; the retry then
    // fails and this process exits locally.
    await dependencies.waitForPrimaryHandoff();
    if (!dependencies.requestSingleInstanceLock(activation("handoff_retry"))) {
      dependencies.exitDesktop();
      return "secondary";
    }
  }

  let handingOff = false;
  dependencies.onSecondInstance((value) => {
    const incoming = decodeDesktopInstanceActivation(value);
    if (
      incoming !== undefined &&
      incoming.buildId !== dependencies.buildId
    ) {
      if (handingOff) return;
      handingOff = true;
      dependencies.releaseSingleInstanceLock();
      // Shell handoff is intentionally local-only: Backend ownership stays
      // intact and the incoming shell will attach to the same Control Plane.
      dependencies.exitDesktop();
      return;
    }
    // The retry probe from the same build is not a second user activation.
    if (incoming?.attempt === "handoff_retry") return;
    dependencies.openWindow();
  });
  dependencies.onWindowAllClosed(() => undefined);
  await dependencies.whenReady();
  dependencies.createTray({
    open: dependencies.openWindow,
    quit: dependencies.quitProduct,
  });
  return "primary";
}
