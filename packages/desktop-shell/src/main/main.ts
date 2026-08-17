import { app, BrowserWindow } from "electron";
import { join } from "node:path";

import {
  createSecureManagementWindowOptions,
  startElectronDesktopLifecycle,
} from "./electron-app-lifecycle.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;

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

void startElectronDesktopLifecycle({
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  whenReady: () => app.whenReady(),
  onSecondInstance: (listener) => app.on("second-instance", listener),
  quit: () => app.quit(),
  openWindow: openManagementWindow,
});

app.on("window-all-closed", () => {
  app.quit();
});
