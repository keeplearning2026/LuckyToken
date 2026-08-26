import { contextBridge, ipcRenderer } from "electron";

import type {
  DesktopControlPlaneApi,
  DesktopPlatformApi,
  TokenDesktopApi,
} from "../shared/desktop-api.js";
import { desktopIpcChannels } from "../shared/ipc-channels.js";

type InvokeResults = {
  [desktopIpcChannels.backendStateGet]: ReturnType<DesktopControlPlaneApi["getBackendState"]>;
  [desktopIpcChannels.runtime]: ReturnType<DesktopControlPlaneApi["executeRuntime"]>;
  [desktopIpcChannels.settings]: ReturnType<DesktopControlPlaneApi["executeSettings"]>;
  [desktopIpcChannels.credentialProfiles]: ReturnType<DesktopControlPlaneApi["executeCredentialProfiles"]>;
  [desktopIpcChannels.providerProfileAuth]: ReturnType<DesktopControlPlaneApi["executeProviderProfileAuth"]>;
  [desktopIpcChannels.authRespond]: ReturnType<DesktopControlPlaneApi["respondAuth"]>;
  [desktopIpcChannels.models]: ReturnType<DesktopControlPlaneApi["executeModels"]>;
  [desktopIpcChannels.catalog]: ReturnType<DesktopControlPlaneApi["executeCatalog"]>;
  [desktopIpcChannels.publicModels]: ReturnType<DesktopControlPlaneApi["executePublicModels"]>;
  [desktopIpcChannels.agentIntegrations]: ReturnType<DesktopControlPlaneApi["executeAgentIntegrations"]>;
  [desktopIpcChannels.requestJourneysQuery]: ReturnType<DesktopControlPlaneApi["queryRequestJourneys"]>;
  [desktopIpcChannels.requestJourneyGet]: ReturnType<DesktopControlPlaneApi["getRequestJourney"]>;
  [desktopIpcChannels.requestArtifactOpen]: ReturnType<DesktopControlPlaneApi["openRequestArtifact"]>;
  [desktopIpcChannels.requestJourneysSubscribe]: Promise<void>;
  [desktopIpcChannels.requestJourneysUnsubscribe]: Promise<void>;
  [desktopIpcChannels.runtimeEventsQuery]: ReturnType<DesktopControlPlaneApi["queryRuntimeEvents"]>;
  [desktopIpcChannels.runtimeEventsSubscribe]: Promise<void>;
  [desktopIpcChannels.runtimeEventsUnsubscribe]: Promise<void>;
  [desktopIpcChannels.analytics]: ReturnType<DesktopControlPlaneApi["getAnalytics"]>;
  [desktopIpcChannels.historyQuery]: ReturnType<DesktopControlPlaneApi["queryHistory"]>;
  [desktopIpcChannels.historyExport]: ReturnType<DesktopControlPlaneApi["executeHistoryExport"]>;
  [desktopIpcChannels.historyExportConfirm]: ReturnType<DesktopControlPlaneApi["confirmHistoryExport"]>;
  [desktopIpcChannels.historyDelete]: ReturnType<DesktopControlPlaneApi["executeHistoryDelete"]>;
  [desktopIpcChannels.historyDeleteConfirm]: ReturnType<DesktopControlPlaneApi["confirmHistoryDelete"]>;
  [desktopIpcChannels.backup]: ReturnType<DesktopControlPlaneApi["executeBackup"]>;
  [desktopIpcChannels.backupConfirm]: ReturnType<DesktopControlPlaneApi["confirmBackup"]>;
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

let requestJourneyListenerCount = 0;
let runtimeEventListenerCount = 0;

const control: DesktopControlPlaneApi = {
  getBackendState: () => invoke(desktopIpcChannels.backendStateGet),
  onBackendState: (listener) =>
    onEvent(desktopIpcChannels.backendStateEvent, listener),
  executeRuntime: (command) => invoke(desktopIpcChannels.runtime, command),
  executeSettings: (command) => invoke(desktopIpcChannels.settings, command),
  executeCredentialProfiles: (command) =>
    invoke(desktopIpcChannels.credentialProfiles, command),
  async executeProviderProfileAuth(command, listener) {
    const stop =
      listener === undefined
        ? undefined
        : onEvent(desktopIpcChannels.providerProfileAuthEvent, listener);
    try {
      return await invoke(desktopIpcChannels.providerProfileAuth, command);
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
  queryRequestJourneys: (query) =>
    invoke(desktopIpcChannels.requestJourneysQuery, query),
  getRequestJourney: (input) =>
    invoke(desktopIpcChannels.requestJourneyGet, input),
  openRequestArtifact: (input) =>
    invoke(desktopIpcChannels.requestArtifactOpen, input),
  queryRuntimeEvents: (query) =>
    invoke(desktopIpcChannels.runtimeEventsQuery, query),
  onRequestJourneys(listener) {
    const stop = onEvent(desktopIpcChannels.requestJourneysEvent, listener);
    requestJourneyListenerCount += 1;
    if (requestJourneyListenerCount === 1) {
      void invoke(desktopIpcChannels.requestJourneysSubscribe);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      stop();
      requestJourneyListenerCount -= 1;
      if (requestJourneyListenerCount === 0) {
        void invoke(desktopIpcChannels.requestJourneysUnsubscribe);
      }
    };
  },
  onRuntimeEvents(listener) {
    const stop = onEvent(desktopIpcChannels.runtimeEventsEvent, listener);
    runtimeEventListenerCount += 1;
    if (runtimeEventListenerCount === 1) {
      void invoke(desktopIpcChannels.runtimeEventsSubscribe);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      stop();
      runtimeEventListenerCount -= 1;
      if (runtimeEventListenerCount === 0) {
        void invoke(desktopIpcChannels.runtimeEventsUnsubscribe);
      }
    };
  },
  getAnalytics: (query) => invoke(desktopIpcChannels.analytics, query),
  queryHistory: (range) => invoke(desktopIpcChannels.historyQuery, range),
  executeHistoryExport: (command) => invoke(desktopIpcChannels.historyExport, command),
  confirmHistoryExport: (actionId) => invoke(desktopIpcChannels.historyExportConfirm, actionId),
  executeHistoryDelete: (command) => invoke(desktopIpcChannels.historyDelete, command),
  confirmHistoryDelete: (actionId) => invoke(desktopIpcChannels.historyDeleteConfirm, actionId),
  executeBackup: (command) => invoke(desktopIpcChannels.backup, command),
  confirmBackup: (actionId) => invoke(desktopIpcChannels.backupConfirm, actionId),
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
const api: TokenDesktopApi = Object.freeze({
  contractVersion: 1,
  control,
  platform,
});

contextBridge.exposeInMainWorld("Token", api);
