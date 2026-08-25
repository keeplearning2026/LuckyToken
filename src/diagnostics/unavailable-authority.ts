import type {
  AnalyticsQueryResult,
  RequestArtifactReadResult,
  RequestJourneyQueryResult,
  RequestJourneyRecord,
  RuntimeEventQueryResult,
} from "@token/application-control-plane/control-plane";

import { DiagnosticsUnavailableError } from "./authority.js";
import type {
  RequestJourneyBeginInput,
  RequestJourneyObserver,
} from "./contract.js";
import type { DiagnosticsManagementAuthority } from "./management-contract.js";

const unavailable = (): Promise<never> =>
  Promise.reject(new DiagnosticsUnavailableError());

/**
 * Process-local fail-open fallback. It observes nothing and exposes only
 * typed-unavailable management failures, so diagnostics construction can
 * never block the Backend or feed a decision back into serving work.
 */
export function createUnavailableDiagnosticsAuthority(): DiagnosticsManagementAuthority {
  return Object.freeze({
    begin(input: RequestJourneyBeginInput): RequestJourneyObserver {
      return Object.freeze({
        requestId: input.requestId,
        observe: () => undefined,
        close: () => undefined,
      });
    },
    observeRuntime: () => undefined,
    diagnosticsAvailable: () => false,
    queryRequestJourneys(): Promise<RequestJourneyQueryResult> {
      return unavailable();
    },
    getRequestJourney(): Promise<RequestJourneyRecord> {
      return unavailable();
    },
    getRequestArtifact(): Promise<RequestArtifactReadResult> {
      return unavailable();
    },
    queryRuntimeEvents(): Promise<RuntimeEventQueryResult> {
      return unavailable();
    },
    getAnalytics(): Promise<AnalyticsQueryResult> {
      return unavailable();
    },
    createBackupSnapshot(): Promise<Uint8Array> {
      return unavailable();
    },
    countHistory() {
      return unavailable();
    },
    deleteHistory() {
      return unavailable();
    },
    subscribeRequestJourneys: () =>
      Object.freeze({ unsubscribe: () => undefined }),
    subscribeRuntimeEvents: () =>
      Object.freeze({ unsubscribe: () => undefined }),
    close: () => Promise.resolve(),
  });
}
