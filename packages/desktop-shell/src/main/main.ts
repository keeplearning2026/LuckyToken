import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createSecureManagementWindowOptions,
  desktopInstanceUserDataPath,
  quitLuckyTokenProduct,
  startElectronDesktopLifecycle,
} from "./electron-app-lifecycle.js";
import { createElectronBackendConnection } from "./electron-backend-connection.js";
import { createDesktopOwnerLeaseClient } from "./desktop-owner-lease.js";
import {
  createMainControlPlaneSession,
  type TrayHealth,
} from "./control-plane-session.js";
import { registerDesktopIpcHandlers } from "./desktop-ipc.js";
import {
  cleanupRepositoryBuildLoginItems,
  effectiveDesktopAutoStart,
  reconcileInstalledLoginItem,
  setInstalledDesktopAutoStart,
  type DesktopLoginItemPlatform,
} from "./login-item.js";
import { desktopIpcChannels } from "../shared/ipc-channels.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayActions: { readonly open: () => void; readonly quit: () => void } | undefined;
let productQuitTask: Promise<boolean> | undefined;
const controlPlaneSession = createMainControlPlaneSession();
const desktopOwnerLease = createDesktopOwnerLeaseClient({
  leaseId: randomUUID(),
  renewIntervalMs: 5_000,
  execute: (command) => controlPlaneSession.client().executeApplicationCommand(command),
  onFailure: () => updateTray("attention"),
});
const backendConnection = createElectronBackendConnection({
  resourcesPath: process.resourcesPath,
  desktopExecutable: process.execPath,
  packaged: app.isPackaged,
  developmentRoot: process.cwd(),
  session: controlPlaneSession,
  desktopOwnerLease,
  onRecoveryFailure: () => updateTray("attention"),
});

/**
 * Stable identity of the exact desktop shell build. Packaged builds hash the
 * privileged Main/preload bundles plus the renderer entrypoint, so rebuilding
 * UI code under the same package version is still a different shell. Dev
 * launches intentionally use a per-process identity so a fresh dev run takes
 * over from a stale dev shell.
 */
function desktopBuildId(): string {
  const hash = createHash("sha256")
    .update(app.getVersion())
    .update(process.platform === "win32" ? process.execPath.toLowerCase() : process.execPath);
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined) {
    return hash
      .update("development")
      .update(String(process.pid))
      .update(MAIN_WINDOW_VITE_DEV_SERVER_URL)
      .digest("hex");
  }
  hash.update(readFileSync(__filename));
  hash.update(readFileSync(join(__dirname, "preload.js")));
  hash.update(
    readFileSync(
      join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    ),
  );
  return hash.digest("hex");
}

const currentDesktopBuildId = desktopBuildId();
const isolatedUserDataPath = desktopInstanceUserDataPath({
  executablePath: process.execPath,
  appDataPath: app.getPath("appData"),
  buildId: currentDesktopBuildId,
});
if (isolatedUserDataPath !== undefined) {
  mkdirSync(isolatedUserDataPath, { recursive: true });
  app.setPath("userData", isolatedUserDataPath);
  app.setPath("sessionData", isolatedUserDataPath);
}
const repositoryBuild = isolatedUserDataPath !== undefined;
const loginItemMutationEnabled =
  process.env.LUCKYTOKEN_DESKTOP_E2E_NO_LOGIN_ITEM_MUTATION !== "1";
const loginItemPlatform: DesktopLoginItemPlatform = {
  get(options) {
    const settings = app.getLoginItemSettings(
      options?.path === undefined
        ? undefined
        : { path: options.path, args: [...(options.args ?? [])] },
    );
    return {
      openAtLogin: settings.openAtLogin,
      ...(settings.executableWillLaunchAtLogin === undefined
        ? {}
        : { executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin }),
      ...(settings.launchItems === undefined
        ? {}
        : {
            launchItems: settings.launchItems.map((item) => ({
              name: item.name,
              path: item.path,
              args: Object.freeze([...item.args]),
              scope: item.scope,
              enabled: item.enabled,
            })),
          }),
    };
  },
  set(settings) {
    app.setLoginItemSettings({
      openAtLogin: settings.openAtLogin,
      ...(settings.path === undefined ? {} : { path: settings.path }),
      ...(settings.args === undefined ? {} : { args: [...settings.args] }),
      ...(settings.enabled === undefined ? {} : { enabled: settings.enabled }),
      ...(settings.name === undefined ? {} : { name: settings.name }),
    });
  },
};
const desktopIpcBridge = registerDesktopIpcHandlers({
  registrar: {
    handle: (channel, handler) => {
      ipcMain.handle(channel, (event, ...args) =>
        handler(
          {
            senderId: event.sender.id,
            send: (targetChannel, payload) => event.sender.send(targetChannel, payload),
          },
          ...args,
        ),
      );
    },
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  },
  session: controlPlaneSession,
  platform: {
    getAutoStart: async () => {
      if (process.platform !== "win32") {
        return app.getLoginItemSettings().openAtLogin;
      }
      if (!loginItemMutationEnabled || repositoryBuild) return false;
      return effectiveDesktopAutoStart(loginItemPlatform, process.execPath);
    },
    setAutoStart: async (enabled) => {
      if (process.platform !== "win32") {
        app.setLoginItemSettings({ openAtLogin: enabled });
        return app.getLoginItemSettings().openAtLogin;
      }
      if (!loginItemMutationEnabled) return false;
      if (repositoryBuild) {
        cleanupRepositoryBuildLoginItems(loginItemPlatform);
        return false;
      }
      return setInstalledDesktopAutoStart(
        loginItemPlatform,
        process.execPath,
        enabled,
      );
    },
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    pickSaveFile: async (options) => {
      const result = await dialog.showSaveDialog({
        title: options.title,
        ...(options.defaultPath === undefined
          ? {}
          : { defaultPath: options.defaultPath }),
      });
      return result.canceled ? undefined : result.filePath;
    },
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    writeClipboardText: async (value) => {
      clipboard.writeText(value);
    },
    getDesktopVersion: async () => app.getVersion(),
  },
  isTrustedSender: (senderId) => mainWindow?.webContents.id === senderId,
});

function rendererUrl(): { readonly kind: "url"; readonly value: string } | { readonly kind: "file"; readonly value: string } {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined) {
    return { kind: "url", value: MAIN_WINDOW_VITE_DEV_SERVER_URL };
  }
  return {
    kind: "file",
    value: join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
  };
}

function openManagementWindow(): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    ...createSecureManagementWindowOptions(join(__dirname, "preload.js")),
  });
  mainWindow = window;
  const senderId = window.webContents.id;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
    void desktopIpcBridge.releaseSender(senderId);
  });

  const target = rendererUrl();
  if (target.kind === "url") {
    void window.loadURL(target.value);
  } else {
    void window.loadFile(target.value);
  }
}

function trayStatusLabel(health: TrayHealth): string {
  switch (health) {
    case "ready":
      return "LuckyToken — Ready";
    case "starting":
      return "LuckyToken — Starting";
    case "attention":
      return "LuckyToken — Attention needed";
    case "stopped":
      return "LuckyToken — Gateway stopped";
  }
}

function updateTray(health: TrayHealth): void {
  if (tray === undefined || trayActions === undefined) return;
  const label = trayStatusLabel(health);
  tray.setToolTip(label);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: "separator" },
      { label: "Open LuckyToken", click: trayActions.open },
      { label: "Quit LuckyToken", click: trayActions.quit },
    ]),
  );
}

function requestProductQuit(): void {
  if (productQuitTask !== undefined) return;
  productQuitTask = quitLuckyTokenProduct({
    backendOwnerKind: () => {
      const state = controlPlaneSession.state();
      return state.kind === "ready" ? state.status.ownership?.owner.kind : undefined;
    },
    ownsDesktopBackend: () => desktopOwnerLease.isBound(),
    requestBackendQuit: () =>
      controlPlaneSession.client().executeApplicationCommand({
        command: "quit",
        acknowledged: true,
      }),
    quitDesktop: () => app.quit(),
    onFailure: () => updateTray("attention"),
  }).finally(() => {
    productQuitTask = undefined;
  });
}

function reconcileDesktopLoginItem(): void {
  if (process.platform !== "win32" || !loginItemMutationEnabled) return;
  try {
    if (repositoryBuild) {
      cleanupRepositoryBuildLoginItems(loginItemPlatform);
    } else {
      reconcileInstalledLoginItem(loginItemPlatform, process.execPath);
    }
  } catch {
    // Login-item maintenance is OS integration only; inability to reconcile
    // it must never make the Backend or management UI unavailable.
  }
}

function createTray(actions: { readonly open: () => void; readonly quit: () => void }): void {
  if (tray !== undefined) return;
  trayActions = actions;
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
  tray = new Tray(icon);
  tray.on("double-click", actions.open);
  updateTray(controlPlaneSession.trayHealth());
}

void startElectronDesktopLifecycle({
  buildId: currentDesktopBuildId,
  requestSingleInstanceLock: (activation) =>
    app.requestSingleInstanceLock(activation),
  releaseSingleInstanceLock: () => app.releaseSingleInstanceLock(),
  waitForPrimaryHandoff: () =>
    new Promise<void>((resolve) => setTimeout(resolve, 200)),
  whenReady: async () => {
    await app.whenReady();
    reconcileDesktopLoginItem();
    await backendConnection.start();
    controlPlaneSession.subscribeState((state) => {
      updateTray(controlPlaneSession.trayHealth());
      if (state.kind === "ready" && mainWindow !== undefined && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(desktopIpcChannels.statusEvent, state.status);
      }
    });
  },
  onSecondInstance: (listener) =>
    app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) =>
      listener(additionalData),
    ),
  onWindowAllClosed: (listener) => app.on("window-all-closed", listener),
  exitDesktop: () => app.quit(),
  quitProduct: requestProductQuit,
  openWindow: openManagementWindow,
  createTray,
});

// Closing the last management window intentionally leaves Electron Main and
// the tray running. Explicit product Quit is a separate tray action.
app.on("will-quit", () => {
  void Promise.allSettled([
    desktopIpcBridge.dispose(),
    backendConnection.dispose(),
  ]);
});
