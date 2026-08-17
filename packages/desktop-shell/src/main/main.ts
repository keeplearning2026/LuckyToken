import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";

import {
  createSecureManagementWindowOptions,
  startElectronDesktopLifecycle,
} from "./electron-app-lifecycle.js";
import { createElectronBackendSupervisor } from "./electron-backend-supervisor.js";
import {
  createMainControlPlaneSession,
  type TrayHealth,
} from "./control-plane-session.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayActions: { readonly open: () => void; readonly quit: () => void } | undefined;
let reconnectTask: Promise<void> | undefined;
const backendSupervisor = createElectronBackendSupervisor({
  resourcesPath: process.resourcesPath,
  desktopExecutable: process.execPath,
  packaged: app.isPackaged,
  developmentRoot: process.cwd(),
});
const controlPlaneSession = createMainControlPlaneSession();

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

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
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
  quit: () => app.quit(),
  openWindow: openManagementWindow,
  createTray,
});

// Closing the last management window intentionally leaves Electron Main and
// the tray running. Explicit product Quit is a separate tray action.
app.on("will-quit", () => {
  void Promise.allSettled([
    controlPlaneSession.dispose(),
    backendSupervisor.dispose(),
  ]);
});
