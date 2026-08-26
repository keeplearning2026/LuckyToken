import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";

type DeleteResult = Awaited<ReturnType<TokenDesktopApi["control"]["executeHistoryDelete"]>>;
type BackupResult = Awaited<ReturnType<TokenDesktopApi["control"]["executeBackup"]>>;

const FULL_JOURNEY_SETTING = "diagnostics.fullJourneyCapture.enabled";
const FAILED_JOURNEY_SETTING = "diagnostics.failedJourneyCapture.enabled";

export function DataSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [counts, setCounts] = useState<{ readonly requestJourneys: number; readonly runtimeEvents: number }>();
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [deleteGate, setDeleteGate] = useState<DeleteResult>();
  const [backupGate, setBackupGate] = useState<BackupResult>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [captureEnabled, setCaptureEnabled] = useState<boolean>();
  const [failedCaptureEnabled, setFailedCaptureEnabled] = useState<boolean>();
  const [captureDirectory, setCaptureDirectory] = useState<string>();
  const [captureAvailable, setCaptureAvailable] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const result = await api.control.queryHistory("all").catch(() => undefined);
    if (result === undefined) {
      setCounts(undefined);
      setHistoryUnavailable(true);
      return;
    }
    if ("outcome" in result) {
      setCounts(undefined);
      setHistoryUnavailable(true);
      return;
    }
    setCounts(result.counts);
    setHistoryUnavailable(false);
  };

  useEffect(() => {
    let active = true;
    void refresh();
    void api.control
      .executeSettings({
        command: "query",
        keys: [FULL_JOURNEY_SETTING, FAILED_JOURNEY_SETTING],
      })
      .then(
        (result) => {
          if (!active) return;
          const value = result.settings[FULL_JOURNEY_SETTING]?.value;
          setCaptureEnabled(typeof value === "boolean" ? value : undefined);
          const failedValue = result.settings[FAILED_JOURNEY_SETTING]?.value;
          setFailedCaptureEnabled(
            typeof failedValue === "boolean" ? failedValue : undefined,
          );
        },
        () => {
          if (active) {
            setCaptureEnabled(undefined);
            setFailedCaptureEnabled(undefined);
          }
        },
      );
    void api.control.getBackendState().then(
      (state) => {
        if (!active || state.kind !== "ready") return;
        setCaptureDirectory(state.status.diagnostics?.fullJourneyDirectory);
        setCaptureAvailable(state.status.diagnostics?.available === true);
      },
      () => {
        if (active) setCaptureAvailable(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const toggleJourneyCapture = async (
    key: typeof FULL_JOURNEY_SETTING | typeof FAILED_JOURNEY_SETTING,
    current: boolean | undefined,
  ): Promise<void> => {
    if (current === undefined) return;
    const label = key === FULL_JOURNEY_SETTING
      ? "Full journey capture"
      : "Failed-request capture";
    setCaptureBusy(true);
    try {
      const next = !current;
      const result = await api.control.executeSettings({
        command: "set",
        key,
        value: next,
      });
      if (
        result.outcome === "storage_failure" ||
        result.outcome === "invalid_value"
      ) {
        setNotice(result.error ?? `${label} could not be updated.`);
        return;
      }
      if (key === FULL_JOURNEY_SETTING) setCaptureEnabled(next);
      else setFailedCaptureEnabled(next);
      setNotice(key === FULL_JOURNEY_SETTING
        ? `Full journey capture ${next ? "enabled" : "disabled"}.`
        : `Failed-request capture ${next ? "enabled" : "disabled"}.`);
    } catch {
      setNotice(`${label} could not be updated.`);
    } finally {
      setCaptureBusy(false);
    }
  };

  const deleteAll = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.control.executeHistoryDelete({ range: "all" });
      setDeleteGate(result);
      if (result.outcome === "unavailable") { setNotice("History is temporarily unavailable."); return; }
      if (result.outcome !== "confirmation_required") {
        setNotice("History deletion completed without a pending confirmation.");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteGate === undefined || deleteGate.outcome !== "confirmation_required" || deleteGate.actionId === undefined) return;
    setBusy(true);
    try {
      const result = await api.control.confirmHistoryDelete(deleteGate.actionId);
      setDeleteGate(result);
      if (result.outcome === "unavailable") { setNotice("History is temporarily unavailable."); return; }
      setNotice(
        result.outcome === "completed"
          ? "History deleted."
          : "History deletion did not fully complete.",
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const createFullBackup = async (): Promise<void> => {
    const destinationPath = await api.platform.pickSaveFile({
      title: "Create Token backup",
      defaultPath: "token-backup.json",
    });
    if (destinationPath === undefined) return;
    setBusy(true);
    try {
      const result = await api.control.executeBackup({
        mode: "full_sensitive",
        destinationPath,
        overwrite: false,
      });
      setBackupGate(result);
      if (result.outcome === "unavailable") setNotice("Diagnostics are temporarily unavailable; a complete backup was not created.");
      if (result.outcome === "ok") setNotice("Backup created.");
      if (result.outcome === "failed") setNotice(result.failure?.message ?? "Backup failed.");
    } finally {
      setBusy(false);
    }
  };

  const confirmBackup = async (): Promise<void> => {
    if (backupGate === undefined || backupGate.outcome !== "confirmation_required" || backupGate.actionId === undefined) return;
    setBusy(true);
    try {
      const result = await api.control.confirmBackup(backupGate.actionId);
      setBackupGate(result);
      if (result.outcome === "unavailable") { setNotice("Diagnostics are temporarily unavailable; a complete backup was not created."); return; }
      setNotice(result.outcome === "ok" ? "Backup created." : result.failure?.message ?? "Backup failed.");
    } finally {
      setBusy(false);
    }
  };

  const total = counts === undefined ? undefined : counts.requestJourneys + counts.runtimeEvents;

  return (
    <section className="page-stack">
      {notice === undefined ? null : <p className="product-notice" role="status">{notice}</p>}
      <div className="page-card settings-section">
        <header className="settings-section-header">
          <div className="settings-copy">
            <p className="eyebrow">DIAGNOSTICS</p>
            <h3>Full journey capture</h3>
            <p>
              Save lane-owned request, intermediate, upstream, and response
              evidence for all three data-plane lanes.
            </p>
          </div>
          <span className={`settings-status ${captureEnabled || failedCaptureEnabled ? "on" : "off"}`}>
            {captureEnabled === undefined || failedCaptureEnabled === undefined
              ? "Unavailable"
              : captureEnabled
                ? "All requests"
                : failedCaptureEnabled
                  ? "Failures only"
                  : "Off"}
          </span>
        </header>
        <div className="settings-action-row">
          <div className="settings-action-copy">
            <strong>Capture every request journey</strong>
            <p>
              64 MiB per JSON file, 512 MiB per journey. Capture runs in an
              isolated diagnostics process and fails open.
            </p>
          </div>
          <button
            type="button"
            className={`switch-control${captureEnabled ? " on" : ""}`}
            aria-label={captureEnabled === undefined
              ? "Full journey capture unavailable"
              : captureEnabled
                ? "Disable full journey capture"
                : "Enable full journey capture"}
            aria-pressed={captureEnabled === true}
            aria-busy={captureBusy}
            disabled={captureBusy || captureEnabled === undefined}
            onClick={() => void toggleJourneyCapture(
              FULL_JOURNEY_SETTING,
              captureEnabled,
            )}
            title={captureEnabled
              ? "Disable full journey capture"
              : "Enable full journey capture"}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <div className="settings-action-row">
          <div className="settings-action-copy">
            <strong>Force capture when a request fails</strong>
            <p>
              Enabled by default. Failed, aborted, or interrupted journeys keep
              their complete available scene even when all-request capture is off.
            </p>
          </div>
          <button
            type="button"
            className={`switch-control${failedCaptureEnabled ? " on" : ""}`}
            aria-label={failedCaptureEnabled === undefined
              ? "Failed-request capture unavailable"
              : failedCaptureEnabled
                ? "Disable failed-request capture"
                : "Enable failed-request capture"}
            aria-pressed={failedCaptureEnabled === true}
            aria-busy={captureBusy}
            disabled={captureBusy || failedCaptureEnabled === undefined}
            onClick={() => void toggleJourneyCapture(
              FAILED_JOURNEY_SETTING,
              failedCaptureEnabled,
            )}
            title={failedCaptureEnabled
              ? "Disable failed-request capture"
              : "Enable failed-request capture"}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <div className="settings-action-copy">
          <strong>Capture folder</strong>
          <p>
            {captureDirectory ??
              "The capture folder is unavailable while the Backend is disconnected."}
          </p>
          <small>
            {captureAvailable
              ? "Diagnostics storage is available."
              : "Diagnostics storage is currently unavailable."}
          </small>
        </div>
      </div>
      <div className="page-card settings-section settings-danger-section">
        <header className="settings-section-header">
          <div className="settings-copy">
            <p className="eyebrow">DATA &amp; PRIVACY</p>
            <h3>Stored history</h3>
            <p>Request activity and runtime events used by Overview and diagnostics.</p>
          </div>
          <span className={`settings-status ${historyUnavailable ? "unavailable" : "off"}`}>
            {historyUnavailable || total === undefined
              ? "Unavailable"
              : `${total.toLocaleString()} record${total === 1 ? "" : "s"}`}
          </span>
        </header>
        <div className="settings-action-row">
          <div className="settings-action-copy">
            <strong>Delete all stored history</strong>
            <p>
              {historyUnavailable || total === undefined
                ? "History cannot be inspected or deleted right now."
                : total === 0
                  ? "There is no stored history to delete."
                  : `${total.toLocaleString()} stored history record${total === 1 ? "" : "s"} will be removed after confirmation.`}
            </p>
          </div>
          <button
            type="button"
            className="settings-icon-button danger"
            aria-label="Delete history"
            title="Delete history"
            disabled={busy || total === undefined || total === 0}
            onClick={() => void deleteAll()}
          >
            <Trash2 size={18} aria-hidden="true" />
          </button>
        </div>
        {deleteGate?.outcome === "confirmation_required" ? (
          <div className="confirmation-panel">
            <p>{deleteGate.confirmationMessage}</p>
            <button type="button" className="danger-button" disabled={busy} onClick={() => void confirmDelete()}>
              Confirm delete
            </button>
          </div>
        ) : null}
      </div>

      <div className="page-card settings-section">
        <header className="settings-section-header">
          <div className="settings-copy">
            <p className="eyebrow">BACKUP</p>
            <h3>Create a full backup</h3>
            <p>Export configuration and the diagnostic index to a file you choose.</p>
          </div>
        </header>
        <div className="settings-action-row">
          <div className="settings-action-copy">
            <strong>Sensitive diagnostic backup</strong>
            <p>The file contains the diagnostic index and may contain sensitive request details. Full-journey JSON files remain in the capture folder.</p>
          </div>
          <button type="button" className="secondary" disabled={busy} onClick={() => void createFullBackup()}>
            Choose location…
          </button>
        </div>
        {backupGate?.outcome === "confirmation_required" ? (
          <div className="confirmation-panel">
            <p>{backupGate.confirmationMessage}</p>
            <button type="button" disabled={busy} onClick={() => void confirmBackup()}>
              Confirm backup
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
