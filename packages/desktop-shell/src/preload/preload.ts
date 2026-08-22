import { contextBridge, ipcRenderer } from "electron";

import type {
  DesktopControlPlaneApi,
  DesktopPlatformApi,
  LuckyTokenDesktopApi,
} from "../shared/desktop-api.js";
import { desktopIpcChannels } from "../shared/ipc-channels.js";

type InvokeResults = {
  [desktopIpcChannels.backendStateGet]: ReturnType<DesktopControlPlaneApi["getBackendState"]>;
  [desktopIpcChannels.runtime]: ReturnType<DesktopControlPlaneApi["executeRuntime"]>;
  [desktopIpcChannels.settings]: ReturnType<DesktopControlPlaneApi["executeSettings"]>;
  [desktopIpcChannels.credential]: ReturnType<DesktopControlPlaneApi["executeCredential"]>;
  [desktopIpcChannels.auth]: ReturnType<DesktopControlPlaneApi["executeAuth"]>;
  [desktopIpcChannels.authRespond]: ReturnType<DesktopControlPlaneApi["respondAuth"]>;
  [desktopIpcChannels.models]: ReturnType<DesktopControlPlaneApi["executeModels"]>;
  [desktopIpcChannels.catalog]: ReturnType<DesktopControlPlaneApi["executeCatalog"]>;
  [desktopIpcChannels.publicModels]: ReturnType<DesktopControlPlaneApi["executePublicModels"]>;
  [desktopIpcChannels.agentIntegrations]: ReturnType<DesktopControlPlaneApi["executeAgentIntegrations"]>;
  [desktopIpcChannels.ledgerGet]: ReturnType<DesktopControlPlaneApi["getRequestLedger"]>;
  [desktopIpcChannels.ledgerSubscribe]: Promise<void>;
  [desktopIpcChannels.ledgerUnsubscribe]: Promise<void>;
  [desktopIpcChannels.analytics]: ReturnType<DesktopControlPlaneApi["getAnalytics"]>;
  [desktopIpcChannels.historyQuery]: ReturnType<DesktopControlPlaneApi["queryHistory"]>;
  [desktopIpcChannels.historyExport]: ReturnType<DesktopControlPlaneApi["executeHistoryExport"]>;
  [desktopIpcChannels.historyExportConfirm]: ReturnType<DesktopControlPlaneApi["confirmHistoryExport"]>;
  [desktopIpcChannels.historyDelete]: ReturnType<DesktopControlPlaneApi["executeHistoryDelete"]>;
  [desktopIpcChannels.historyDeleteConfirm]: ReturnType<DesktopControlPlaneApi["confirmHistoryDelete"]>;
  [desktopIpcChannels.persistenceAcknowledge]: ReturnType<DesktopControlPlaneApi["acknowledgePersistence"]>;
  [desktopIpcChannels.backup]: ReturnType<DesktopControlPlaneApi["executeBackup"]>;
  [desktopIpcChannels.backupConfirm]: ReturnType<DesktopControlPlaneApi["confirmBackup"]>;
  [desktopIpcChannels.diagnostics]: ReturnType<DesktopControlPlaneApi["getDiagnostics"]>;
  [desktopIpcChannels.autoStartGet]: ReturnType<DesktopPlatformApi["getAutoStart"]>;
  [desktopIpcChannels.autoStartSet]: ReturnType<DesktopPlatformApi["setAutoStart"]>;
  [desktopIpcChannels.pickDirectory]: ReturnType<DesktopPlatformApi["pickDirectory"]>;
  [desktopIpcChannels.pickSaveFile]: ReturnType<DesktopPlatformApi["pickSaveFile"]>;
  [desktopIpcChannels.openExternal]: ReturnType<DesktopPlatformApi["openExternal"]>;
  [desktopIpcChannels.clipboardWrite]: ReturnType<DesktopPlatformApi["writeClipboardText"]>;
  [desktopIpcChannels.desktopVersion]: ReturnType<DesktopPlatformApi["getDesktopVersion"]>;
};

type InvokeChannel = keyof InvokeResults;

function invoke<K extends InvokeChannel>(
  channel: K,
  ...args: readonly unknown[]
): InvokeResults[K] {
  return ipcRenderer.invoke(channel, ...args) as InvokeResults[K];
}

const onEvent = <T>(
  channel: string,
  listener: (value: T) => void,
): (() => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

let ledgerListenerCount = 0;

const control: DesktopControlPlaneApi = {
  getBackendState: () => invoke(desktopIpcChannels.backendStateGet),
  onBackendState: (listener) =>
    onEvent(desktopIpcChannels.backendStateEvent, listener),
  executeRuntime: (command) => invoke(desktopIpcChannels.runtime, command),
  executeSettings: (command) => invoke(desktopIpcChannels.settings, command),
  executeCredential: (command) => invoke(desktopIpcChannels.credential, command),
  async executeAuth(command, listener) {
    const stop = listener === undefined ? undefined : onEvent(desktopIpcChannels.authEvent, listener);
    try {
      return await invoke(desktopIpcChannels.auth, command);
    } finally {
      stop?.();
    }
  },
  respondAuth: (response) => invoke(desktopIpcChannels.authRespond, response),
  executeModels: (command) => invoke(desktopIpcChannels.models, command),
  executeCatalog: (command) => invoke(desktopIpcChannels.catalog, command),
  executePublicModels: (command) => invoke(desktopIpcChannels.publicModels, command),
  executeAgentIntegrations: (command) =>
    invoke(desktopIpcChannels.agentIntegrations, command),
  getRequestLedger: (query) => invoke(desktopIpcChannels.ledgerGet, query),
  onRequestLedger(listener) {
    const stop = onEvent(desktopIpcChannels.ledgerEvent, listener);
    ledgerListenerCount += 1;
    if (ledgerListenerCount === 1) void invoke(desktopIpcChannels.ledgerSubscribe);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      stop();
      ledgerListenerCount -= 1;
      if (ledgerListenerCount === 0) void invoke(desktopIpcChannels.ledgerUnsubscribe);
    };
  },
  getAnalytics: (query) => invoke(desktopIpcChannels.analytics, query),
  queryHistory: (range) => invoke(desktopIpcChannels.historyQuery, range),
  executeHistoryExport: (command) => invoke(desktopIpcChannels.historyExport, command),
  confirmHistoryExport: (actionId) => invoke(desktopIpcChannels.historyExportConfirm, actionId),
  executeHistoryDelete: (command) => invoke(desktopIpcChannels.historyDelete, command),
  confirmHistoryDelete: (actionId) => invoke(desktopIpcChannels.historyDeleteConfirm, actionId),
  acknowledgePersistence: () => invoke(desktopIpcChannels.persistenceAcknowledge),
  executeBackup: (command) => invoke(desktopIpcChannels.backup, command),
  confirmBackup: (actionId) => invoke(desktopIpcChannels.backupConfirm, actionId),
  getDiagnostics: (query) => invoke(desktopIpcChannels.diagnostics, query),
};

const platform: DesktopPlatformApi = {
  getAutoStart: () => invoke(desktopIpcChannels.autoStartGet),
  setAutoStart: (enabled) => invoke(desktopIpcChannels.autoStartSet, enabled),
  pickDirectory: () => invoke(desktopIpcChannels.pickDirectory),
  pickSaveFile: (options) => invoke(desktopIpcChannels.pickSaveFile, options),
  openExternal: (url) => invoke(desktopIpcChannels.openExternal, url),
  writeClipboardText: (value) => invoke(desktopIpcChannels.clipboardWrite, value),
  getDesktopVersion: () => invoke(desktopIpcChannels.desktopVersion),
};

Object.freeze(control);
Object.freeze(platform);
const api: LuckyTokenDesktopApi = Object.freeze({
  contractVersion: 1,
  control,
  platform,
});

contextBridge.exposeInMainWorld("luckytoken", api);
