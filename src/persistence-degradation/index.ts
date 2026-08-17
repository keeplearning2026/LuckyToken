/**
 * Persistence degradation module (Ticket 23) — the audit-unavailable state
 * machine, the bounded in-memory Critical fallback, and the store-side
 * fault observers/fallbacks.
 */
export {
  createPersistenceDegradationAuthority,
  type PersistenceAuthorityStateEntry,
  type PersistenceDegradationAuthority,
  type PersistenceDegradationAuthorityOptions,
  type PersistenceFailureFact,
  type PersistenceState,
} from "./authority.js";
export type { PersistenceAuthorityId, PersistenceProjection } from "./authority.js";
export {
  createUnavailableDeepCaptureStore,
  createUnavailableDiagnosticsStore,
  createUnavailableRequestLedgerStore,
  observeDiagnosticsStore,
} from "./store-watch.js";
