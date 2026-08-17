/**
 * Narrow neutral handler-facing seam (Ticket 22): the only Deep Diagnostics
 * surface Client Protocol handlers may import.
 *
 * It exposes the capture authority contract and the safe no-op
 * implementation. Persistence, configuration, retention, Control Plane
 * DTOs, and the SQLite/WAL authority stay out of this seam: a protocol
 * handler must never depend on the broad `deep-diagnostics/index.ts`
 * authority merely to observe the acceptance-time capture decision.
 */
export { createNoopDeepCaptureAuthority, createNoopCaptureEntry } from "./authority.js";
export type {
  DeepCaptureAuthority,
  DeepCaptureBeginInput,
  DeepCaptureEntry,
} from "./authority.js";
