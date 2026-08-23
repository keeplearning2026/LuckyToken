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
      title: "Create LuckyToken backup",
      defaultPath: "luckytoken-backup.json",
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
        <div className="settings-copy">
          <p className="eyebrow">DATA</p>
          <h3>History</h3>
          <p>{historyUnavailable || total === undefined ? "History is temporarily unavailable." : `${total.toLocaleString()} stored history record${total === 1 ? "" : "s"}`}</p>
        </div>
        <button type="button" className="danger-button" disabled={busy || total === undefined || total === 0} onClick={() => void deleteAll()}>
          Delete all history
        </button>
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
        <div className="settings-copy">
          <p className="eyebrow">BACKUP</p>
          <h3>Product backup</h3>
          <p>Ordinary history is sanitized. A full sensitive backup requires a second explicit confirmation.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void createFullBackup()}>
          Create full backup
        </button>
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
