import type {
  AliasCommand,
  AliasCommandResult,
  AnalyticsOptionsResult,
  AnalyticsQuery,
  AnalyticsResult,
  AuthCommand,
  AuthCommandResult,
  AuthInteractionEvent,
  AuthInteractionResponse,
  BackupCreateCommand,
  BackupResult,
  CatalogCommand,
  CatalogCommandResult,
  ClientTokenCommand,
  ClientTokenCommandResult,
  CodexIntegrationCommand,
  CodexIntegrationCommandResult,
  CredentialCommand,
  CredentialCommandResult,
  HistoryAcknowledgeResult,
  HistoryDeleteCommand,
  HistoryDeleteResult,
  HistoryExportCommand,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
  ModelsCommand,
  ModelsCommandResult,
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
} from "@luckytoken/application-control-plane/ledger-projection";

export interface DesktopControlPlaneApi {
  getStatus(): Promise<StatusSnapshot>;
  onStatus(listener: (status: StatusSnapshot) => void): () => void;

  executeRuntime(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  executeSettings(command: SettingsCommand): Promise<SettingsCommandResult>;
  executeClientToken(command: ClientTokenCommand): Promise<ClientTokenCommandResult>;
  executeCredential(command: CredentialCommand): Promise<CredentialCommandResult>;
  executeAuth(
    command: AuthCommand,
    listener?: (event: AuthInteractionEvent) => void,
  ): Promise<AuthCommandResult>;
  respondAuth(response: AuthInteractionResponse): Promise<void>;

  executeModels(command: ModelsCommand): Promise<ModelsCommandResult>;
  executeCatalog(command: CatalogCommand): Promise<CatalogCommandResult>;
  executeAliases(command: AliasCommand): Promise<AliasCommandResult>;
  executeCodexIntegration(
    command: CodexIntegrationCommand,
  ): Promise<CodexIntegrationCommandResult>;

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
