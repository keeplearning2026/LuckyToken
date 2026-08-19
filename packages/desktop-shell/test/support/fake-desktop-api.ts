import type {
  DesktopControlPlaneApi,
  DesktopPlatformApi,
  LuckyTokenDesktopApi,
} from "../../src/shared/desktop-api.js";

const unavailable = async (): Promise<never> => {
  throw new Error("Fake LuckyToken Desktop API operation is not configured");
};

export function createFakeDesktopApi(options: {
  readonly control?: Partial<DesktopControlPlaneApi>;
  readonly platform?: Partial<DesktopPlatformApi>;
} = {}): LuckyTokenDesktopApi {
  const control: DesktopControlPlaneApi = {
    getStatus: unavailable,
    onStatus: () => () => undefined,
    executeRuntime: unavailable,
    executeSettings: unavailable,
    executeClientToken: unavailable,
    executeCredential: unavailable,
    executeAuth: unavailable,
    respondAuth: unavailable,
    executeModels: unavailable,
    executeCatalog: unavailable,
    executeAliases: unavailable,
    executeCodexIntegration: unavailable,
    getRequestLedger: unavailable,
    onRequestLedger: () => () => undefined,
    getAnalytics: unavailable,
    queryHistory: unavailable,
    executeHistoryExport: unavailable,
    confirmHistoryExport: unavailable,
    executeHistoryDelete: unavailable,
    confirmHistoryDelete: unavailable,
    acknowledgePersistence: unavailable,
    executeBackup: unavailable,
    confirmBackup: unavailable,
    getDiagnostics: unavailable,
    ...options.control,
  };
  const platform: DesktopPlatformApi = {
    getAutoStart: unavailable,
    setAutoStart: unavailable,
    pickDirectory: unavailable,
    pickSaveFile: unavailable,
    openExternal: unavailable,
    writeClipboardText: unavailable,
    getDesktopVersion: unavailable,
    ...options.platform,
  };
  return Object.freeze({
    contractVersion: 1,
    control: Object.freeze(control),
    platform: Object.freeze(platform),
  });
}
