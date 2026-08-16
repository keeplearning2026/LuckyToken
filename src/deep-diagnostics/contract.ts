/**
 * Deep Diagnostics capture contract (Ticket 22) — re-exported from the
 * Control Plane package, which owns the public seam (same pattern as
 * Runtime Diagnostics and the Request Ledger).
 */
export {
  CAPTURE_STATES,
  assertCaptureState,
  type CaptureDraft,
  type CaptureEvent,
  type CaptureEventFact,
  type CaptureFailureDraft,
  type CapturePersistedState,
  type CaptureQuery,
  type CaptureQueryResult,
  type CaptureRecord,
  type CaptureState,
  type CaptureTimingEntry,
  type CaptureWriteFailure,
  type ControlPlaneCapture,
  type DeepCaptureStore,
  type DeepCaptureStoreFactory,
} from "@luckytoken/application-control-plane/control-plane";
