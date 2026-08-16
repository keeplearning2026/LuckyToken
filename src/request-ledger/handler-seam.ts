/**
 * Narrow neutral handler-facing seam (Ticket 18): the only Request Ledger
 * surface Client Protocol handlers may import.
 *
 * It exposes the ledger observer contract the handlers drive — the
 * observer (`RequestLedger`) and its handler-local entry
 * (`RequestLedgerEntry`) — plus the safe no-op implementation. Persistence,
 * configuration, Control Plane DTOs, and the SQLite/WAL authority stay out
 * of this seam: a protocol handler must never depend on the broad
 * `request-ledger/index.ts` authority merely to observe lifecycle facts.
 */
export { createNoopRequestLedger } from "./index.js";
export type {
  NormalizedTerminalUsage,
  RequestLedger,
  RequestLedgerEntry,
} from "./contract.js";
