import type {
  AnalyticsManagementResult,
  AnalyticsQuery,
  AuthInteractionEvent,
  AuthInteractionResponse,
  BackupCreateCommand,
  BackupManagementResult,
  CatalogCommand,
  CatalogCommandResult,
  AgentIntegrationsCommand,
  AgentIntegrationsCommandResult,
  CredentialProfilesCommand,
  CredentialProfilesCommandResult,
  HistoryDeleteCommand,
  HistoryDeleteManagementResult,
  HistoryExportCommand,
  HistoryExportManagementResult,
  HistoryQueryManagementResult,
  HistoryRange,
  ModelsCommand,
  ModelsCommandResult,
  PublicModelsCommand,
  PublicModelsCommandResult,
  ProviderProfileAuthCommand,
  ProviderProfileAuthCommandResult,
  RequestArtifactChunkReadResult,
  RequestArtifactGetInput,
  RequestJourneyDetailReadResult,
  RequestJourneyGetInput,
  RequestJourneyQuery,
  RequestJourneyQueryReadResult,
  RequestJourneySubscriber,
  RuntimeEventQuery,
  RuntimeEventQueryReadResult,
  RuntimeEventSubscriber,
  RuntimeCommand,
  RuntimeCommandResult,
  SettingsCommand,
  SettingsCommandResult,
  StatusSnapshot,
} from "@token/application-control-plane/control-plane";

export type {
  AgentIntegrationId,
  AgentInjectionScope,
  AnalyticsFilter,
  AnalyticsOptionsResult,
  AnalyticsSummary,
  RequestArtifactReadResult,
  RequestJourneyQuery,
  RequestJourneyRecord,
  RequestJourneySummary,
  RuntimeEventQuery,
  RuntimeEventRecord,
  RuntimeCommand,
  StatusSnapshot,
} from "@token/application-control-plane/control-plane";
export function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatTokensPerSecond(tokensPerSecond: number): string {
  return tokensPerSecond === 0 ? "0 tokens/s" : `${tokensPerSecond.toFixed(1)} tokens/s`;
}

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

  queryRequestJourneys(query?: RequestJourneyQuery): Promise<RequestJourneyQueryReadResult>;
  getRequestJourney(input: RequestJourneyGetInput): Promise<RequestJourneyDetailReadResult>;
  getRequestArtifact(input: RequestArtifactGetInput): Promise<RequestArtifactChunkReadResult>;
  queryRuntimeEvents(query?: RuntimeEventQuery): Promise<RuntimeEventQueryReadResult>;
  onRequestJourneys(listener: RequestJourneySubscriber): () => void;
  onRuntimeEvents(listener: RuntimeEventSubscriber): () => void;
  getAnalytics(query: AnalyticsQuery): Promise<AnalyticsManagementResult>;

  queryHistory(range?: HistoryRange): Promise<HistoryQueryManagementResult>;
  executeHistoryExport(command: HistoryExportCommand): Promise<HistoryExportManagementResult>;
  confirmHistoryExport(actionId: string): Promise<HistoryExportManagementResult>;
  executeHistoryDelete(command: HistoryDeleteCommand): Promise<HistoryDeleteManagementResult>;
  confirmHistoryDelete(actionId: string): Promise<HistoryDeleteManagementResult>;
  executeBackup(command: BackupCreateCommand): Promise<BackupManagementResult>;
  confirmBackup(actionId: string): Promise<BackupManagementResult>;
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

export interface TokenDesktopApi {
  readonly contractVersion: 1;
  readonly control: DesktopControlPlaneApi;
  readonly platform: DesktopPlatformApi;
}
