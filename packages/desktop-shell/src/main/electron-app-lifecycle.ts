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

export interface ElectronDesktopLifecycleDependencies {
  readonly requestSingleInstanceLock: () => boolean;
  readonly whenReady: () => Promise<void>;
  readonly onSecondInstance: (listener: () => void) => void;
  readonly onWindowAllClosed: (listener: () => void) => void;
  readonly quit: () => void;
  readonly openWindow: () => void;
  readonly createTray: (actions: TrayActions) => void;
}

export async function startElectronDesktopLifecycle(
  dependencies: ElectronDesktopLifecycleDependencies,
): Promise<"primary" | "secondary"> {
  if (!dependencies.requestSingleInstanceLock()) {
    dependencies.quit();
    return "secondary";
  }

  dependencies.onSecondInstance(dependencies.openWindow);
  dependencies.onWindowAllClosed(() => undefined);
  await dependencies.whenReady();
  dependencies.createTray({
    open: dependencies.openWindow,
    quit: dependencies.quit,
  });
  return "primary";
}
