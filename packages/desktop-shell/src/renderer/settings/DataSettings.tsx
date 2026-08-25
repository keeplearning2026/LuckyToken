import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type DeleteResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeHistoryDelete"]>>;
type BackupResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeBackup"]>>;

export function DataSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [counts, setCounts] = useState<{ readonly requestJourneys: number; readonly runtimeEvents: number }>();
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [deleteGate, setDeleteGate] = useState<DeleteResult>();
  const [backupGate, setBackupGate] = useState<BackupResult>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

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
    void refresh();
  }, [api]);

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
          <button type="button" className="danger-button" disabled={busy || total === undefined || total === 0} onClick={() => void deleteAll()}>
            Delete history
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
            <p>Export configuration and complete diagnostic data to a file you choose.</p>
          </div>
        </header>
        <div className="settings-action-row">
          <div className="settings-action-copy">
            <strong>Sensitive diagnostic backup</strong>
            <p>The file may contain sensitive request details and always requires confirmation.</p>
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
