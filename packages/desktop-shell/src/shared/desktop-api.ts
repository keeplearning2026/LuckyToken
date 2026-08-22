import type {
  AnalyticsOptionsResult,
  AnalyticsQuery,
  AnalyticsResult,
  AuthInteractionEvent,
  AuthInteractionResponse,
  BackupCreateCommand,
  BackupResult,
  CatalogCommand,
  CatalogCommandResult,
  AgentIntegrationsCommand,
  AgentIntegrationsCommandResult,
  CredentialProfilesCommand,
  CredentialProfilesCommandResult,
  HistoryAcknowledgeResult,
  HistoryDeleteCommand,
  HistoryDeleteResult,
  HistoryExportCommand,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
  ModelsCommand,
  ModelsCommandResult,
  PublicModelsCommand,
  PublicModelsCommandResult,
  ProviderProfileAuthCommand,
  ProviderProfileAuthCommandResult,
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerQueryResult,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeDiagnosticQuery,
  RuntimeDiagnosticsQueryResult,
  SettingsCommand,
  SettingsCommandResult,
  StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";

export type {
  AgentIntegrationId,
  AgentInjectionScope,
  AnalyticsFilter,
  AnalyticsOptionsResult,
  AnalyticsSummary,
  PrimaryStatus,
  RequestLedgerQuery,
  RequestLedgerRecord,
  RuntimeCommand,
  StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";
export {
  formatPercent,
  formatTimestamp,
  formatTokenCount,
  formatTokensPerSecond,
  projectRequestLedger,
  projectRequestLedgerDetail,
} from "@luckytoken/application-control-plane/ledger-projection";

export type DesktopBackendState =
  | {
      readonly revision: number;
      readonly kind: "connecting" | "reconnecting" | "unavailable";
    }
  | {
      readonly revision: number;
      readonly kind: "ready";
      readonly status: StatusSnapshot;
    };

export interface DesktopControlPlaneApi {
  getBackendState(): Promise<DesktopBackendState>;
  onBackendState(listener: (state: DesktopBackendState) => void): () => void;

  executeRuntime(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  executeSettings(command: SettingsCommand): Promise<SettingsCommandResult>;
  executeCredentialProfiles(
    command: CredentialProfilesCommand,
  ): Promise<CredentialProfilesCommandResult>;
  executeProviderProfileAuth(
    command: ProviderProfileAuthCommand,
    listener?: (event: AuthInteractionEvent) => void,
  ): Promise<ProviderProfileAuthCommandResult>;
  respondAuth(response: AuthInteractionResponse): Promise<void>;

  executeModels(command: ModelsCommand): Promise<ModelsCommandResult>;
  executeCatalog(command: CatalogCommand): Promise<CatalogCommandResult>;
  executePublicModels(command: PublicModelsCommand): Promise<PublicModelsCommandResult>;
  executeAgentIntegrations(
    command: AgentIntegrationsCommand,
  ): Promise<AgentIntegrationsCommandResult>;

  getRequestLedger(query?: RequestLedgerQuery): Promise<RequestLedgerQueryResult>;
  onRequestLedger(listener: (event: RequestLedgerEvent) => void): () => void;
  getAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult | AnalyticsOptionsResult>;

  queryHistory(range?: HistoryRange): Promise<HistoryQueryResult>;
  executeHistoryExport(command: HistoryExportCommand): Promise<HistoryExportResult>;
  confirmHistoryExport(actionId: string): Promise<HistoryExportResult>;
  executeHistoryDelete(command: HistoryDeleteCommand): Promise<HistoryDeleteResult>;
  confirmHistoryDelete(actionId: string): Promise<HistoryDeleteResult>;
  acknowledgePersistence(): Promise<HistoryAcknowledgeResult>;

  executeBackup(command: BackupCreateCommand): Promise<BackupResult>;
  confirmBackup(actionId: string): Promise<BackupResult>;
  getDiagnostics(query?: RuntimeDiagnosticQuery): Promise<RuntimeDiagnosticsQueryResult>;
}

export interface SaveFileOptions {
  readonly title: string;
  readonly defaultPath?: string;
}

export interface DesktopPlatformApi {
  getAutoStart(): Promise<boolean>;
  setAutoStart(enabled: boolean): Promise<boolean>;
  pickDirectory(): Promise<string | undefined>;
  pickSaveFile(options: SaveFileOptions): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  writeClipboardText(value: string): Promise<void>;
  getDesktopVersion(): Promise<string>;
}

export interface LuckyTokenDesktopApi {
  readonly contractVersion: 1;
  readonly control: DesktopControlPlaneApi;
  readonly platform: DesktopPlatformApi;
}
