export {
  LEDGER_OUTCOMES,
  LEDGER_PHASES,
  assertLedgerOutcome,
  assertLedgerPhase,
  type ControlPlaneRequestLedger,
  type LedgerAttempt,
  type LedgerCredentialAttempt,
  type LedgerCredentialCapture,
  type LedgerCredentialUsage,
  type LedgerAuthFacts,
  type LedgerFailureInput,
  type LedgerFailureSummary,
  type LedgerFacts,
  type LedgerModelSnapshot,
  type LedgerNotice,
  type LedgerOutcome,
  type LedgerPersistenceFailure,
  type LedgerPhase,
  type LedgerProfileAttribution,
  type LedgerTerminalFacts,
  type LedgerTerminalOutcome,
  type RequestLedger,
  type RequestLedgerEntry,
  type RequestLedgerEvent,
  type RequestLedgerQuery,
  type RequestLedgerQueryResult,
  type RequestLedgerRecord,
  type RequestLedgerStore,
  type RequestLedgerStoreFactory,
} from "./contract.js";
export {
  parseRequestLedgerConfiguration,
  bindRequestLedgerConfiguration,
  type RequestLedgerConfiguration,
} from "./configuration.js";
export {
  createRequestLedgerStoreFactory,
  type RequestLedgerStoreOptions,
} from "./store.js";
import { randomUUID } from "node:crypto";

import type { RequestLedger, RequestLedgerEntry } from "./contract.js";

/**
 * No-op observer: keeps handlers that were not wired a ledger safe. It
 * still assigns a safe unique request id so the x-luckytoken-request-id
 * header contract holds everywhere; every transition is a no-op.
 */
export function createNoopRequestLedger(): RequestLedger {
  const noopEntry = (): RequestLedgerEntry =>
    Object.freeze({
      requestId: randomUUID(),
      aliasCaptured: () => undefined,
      authorized: () => undefined,
      modelResolved: () => undefined,
      profileAttributed: () => undefined,
      executing: () => undefined,
      rendering: () => undefined,
      terminal: () => undefined,
      terminalUsage: () => undefined,
      notice: () => undefined,
      attempt: () => undefined,
      credentialCaptured: () => undefined,
      credentialAttempt: () => undefined,
      fail: () => undefined,
      completed: () => undefined,
    });
  return Object.freeze({
    begin: () => noopEntry(),
    query: () => Object.freeze({ records: Object.freeze([]), hasMore: false }),
    credentialUsage: () => Object.freeze([]),
    subscribe: () =>
      Object.freeze({ unsubscribe: () => undefined }),
  });
}
