import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type DeleteResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeHistoryDelete"]>>;
type BackupResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeBackup"]>>;

export function DataSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [counts, setCounts] = useState({ requestLedger: 0, diagnostics: 0, capture: 0 });
  const [deleteGate, setDeleteGate] = useState<DeleteResult>();
  const [backupGate, setBackupGate] = useState<BackupResult>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const result = await api.control.queryHistory("all");
    setCounts(result.counts);
  };

  useEffect(() => {
    void refresh();
  }, [api]);

  const deleteAll = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.control.executeHistoryDelete({ range: "all" });
      setDeleteGate(result);
      if (result.outcome !== "confirmation_required") {
        setNotice("History deletion completed without a pending confirmation.");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteGate?.actionId === undefined) return;
    setBusy(true);
    try {
      const result = await api.control.confirmHistoryDelete(deleteGate.actionId);
      setDeleteGate(result);
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
      defaultPath: "luckytoken-backup.zip",
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
      if (result.outcome === "ok") setNotice("Backup created.");
      if (result.outcome === "failed") setNotice(result.failure?.message ?? "Backup failed.");
    } finally {
      setBusy(false);
    }
  };

  const confirmBackup = async (): Promise<void> => {
    if (backupGate?.actionId === undefined) return;
    setBusy(true);
    try {
      const result = await api.control.confirmBackup(backupGate.actionId);
      setBackupGate(result);
      setNotice(result.outcome === "ok" ? "Backup created." : result.failure?.message ?? "Backup failed.");
    } finally {
      setBusy(false);
    }
  };

  const total = counts.requestLedger + counts.diagnostics + counts.capture;

  return (
    <section className="page-stack">
      {notice === undefined ? null : <p className="product-notice" role="status">{notice}</p>}
      <div className="page-card settings-section">
        <div className="settings-copy">
          <p className="eyebrow">DATA</p>
          <h3>History</h3>
          <p>{total.toLocaleString()} stored record{total === 1 ? "" : "s"} · {counts.requestLedger} requests · {counts.diagnostics} diagnostics · {counts.capture} captures</p>
        </div>
        <button type="button" className="danger-button" disabled={busy || total === 0} onClick={() => void deleteAll()}>
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
          <p>Ordinary history is sanitized. A full backup that includes sensitive capture data requires a second explicit confirmation.</p>
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
