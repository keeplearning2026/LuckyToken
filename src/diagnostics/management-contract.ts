import type {
  AnalyticsQuery,
  AnalyticsQueryResult,
  HistoryRange,
  UnifiedDiagnosticsManagement,
} from "@token/application-control-plane/control-plane";

import type { RequestJourneyObservationAuthority } from "./contract.js";

export type DiagnosticsHistoryRange = HistoryRange;

export interface DiagnosticsHistoryCounts {
  readonly requestJourneys: number;
  readonly runtimeEvents: number;
}

export interface DiagnosticsHistoryDeleteResult {
  readonly deleted: Readonly<DiagnosticsHistoryCounts>;
}

/** One Backend-lifetime authority with separate observation and management views. */
export interface DiagnosticsAuthority
  extends RequestJourneyObservationAuthority,
    UnifiedDiagnosticsManagement {
  diagnosticsAvailable(): boolean;
  close(): Promise<void>;
}

/** Application-only operations over the same DiagnosticsAuthority object. */
export interface DiagnosticsManagementAuthority extends DiagnosticsAuthority {
  getAnalytics(query: AnalyticsQuery): Promise<AnalyticsQueryResult>;
  createBackupSnapshot(signal: AbortSignal): Promise<Uint8Array>;
  countHistory(
    range: DiagnosticsHistoryRange,
  ): Promise<DiagnosticsHistoryCounts>;
  deleteHistory(
    range: DiagnosticsHistoryRange,
  ): Promise<DiagnosticsHistoryDeleteResult>;
}
