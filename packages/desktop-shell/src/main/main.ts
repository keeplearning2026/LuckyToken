import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import { join } from "node:path";

import {
  createSecureManagementWindowOptions,
  quitLuckyTokenProduct,
  startElectronDesktopLifecycle,
} from "./electron-app-lifecycle.js";
import { createElectronBackendSupervisor } from "./electron-backend-supervisor.js";
import {
  createMainControlPlaneSession,
  type TrayHealth,
} from "./control-plane-session.js";
import { registerDesktopIpcHandlers } from "./desktop-ipc.js";
import { desktopIpcChannels } from "../shared/ipc-channels.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayActions: { readonly open: () => void; readonly quit: () => void } | undefined;
let reconnectTask: Promise<void> | undefined;
let productQuitTask: Promise<boolean> | undefined;
const backendSupervisor = createElectronBackendSupervisor({
  resourcesPath: process.resourcesPath,
  desktopExecutable: process.execPath,
  packaged: app.isPackaged,
  developmentRoot: process.cwd(),
});
const controlPlaneSession = createMainControlPlaneSession();
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
    getAutoStart: async () => app.getLoginItemSettings().openAtLogin,
    setAutoStart: async (enabled) => {
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
      return app.getLoginItemSettings().openAtLogin;
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
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  whenReady: async () => {
    await app.whenReady();
    const attachment = await backendSupervisor.ensureRunning();
    await controlPlaneSession.connect(attachment.endpoint);
    controlPlaneSession.subscribeState((state) => {
      updateTray(controlPlaneSession.trayHealth());
      if (state.kind === "ready" && mainWindow !== undefined && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(desktopIpcChannels.statusEvent, state.status);
      }
      if (state.kind !== "unavailable" || reconnectTask !== undefined) return;
      reconnectTask = (async () => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            await controlPlaneSession.reconnect(attachment.endpoint);
            return;
          } catch {
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
          }
        }
      })().finally(() => {
        reconnectTask = undefined;
      });
    });
  },
  onSecondInstance: (listener) => app.on("second-instance", listener),
  onWindowAllClosed: (listener) => app.on("window-all-closed", listener),
  quit: requestProductQuit,
  openWindow: openManagementWindow,
  createTray,
});

// Closing the last management window intentionally leaves Electron Main and
// the tray running. Explicit product Quit is a separate tray action.
app.on("will-quit", () => {
  void Promise.allSettled([
    desktopIpcBridge.dispose(),
    controlPlaneSession.dispose(),
    backendSupervisor.dispose(),
  ]);
});
