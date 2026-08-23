import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi, RuntimeEventRecord } from "../../shared/desktop-api.js";

const codexRestoreFields = Object.freeze([
  { key: "integrations.codex.preimage.modelProvider", label: "model_provider" },
  { key: "integrations.codex.preimage.openaiBaseUrl", label: "openai_base_url" },
  { key: "integrations.codex.preimage.modelCatalogJson", label: "model_catalog_json" },
]);

async function queryRecentWarnings(api: LuckyTokenDesktopApi): Promise<readonly RuntimeEventRecord[] | "unavailable"> {
  const records: RuntimeEventRecord[] = [];
  let afterId: number | undefined;
  for (;;) {
    const response = await api.control.queryRuntimeEvents({ limit: 1_000, ...(afterId === undefined ? {} : { afterId }) });
    if (response.outcome === "unavailable") return "unavailable";
    records.push(...response.result.records);
    const newest = response.result.records.at(-1)?.id;
    if (!response.result.hasMore || newest === undefined || newest === afterId) break;
    afterId = newest;
  }
  return records.filter((record) => record.level !== "info").sort((left, right) => right.id - left.id).slice(0, 25);
}

export function AdvancedSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [events, setEvents] = useState<readonly RuntimeEventRecord[]>();
  const [eventsUnavailable, setEventsUnavailable] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [codexRestoreDraft, setCodexRestoreDraft] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({ command: "query", keys: codexRestoreFields.map((field) => field.key) }).then((settings) => {
      if (!active) return;
      setCodexRestoreDraft(Object.freeze(Object.fromEntries(codexRestoreFields.map((field) => {
        const value = settings.settings[field.key]?.value;
        return [field.key, typeof value === "string" ? value : ""];
      }))));
    }, () => { if (active) setStorageNotice("Codex restore values are temporarily unavailable."); });
    void queryRecentWarnings(api).then((response) => {
      if (!active) return;
      if (response === "unavailable") { setEventsUnavailable(true); return; }
      setEvents(response);
      setEventsUnavailable(false);
    }, () => { if (active) setEventsUnavailable(true); });
    return () => { active = false; };
  }, [api]);

  const saveCodexRestoreValues = async (): Promise<void> => {
    setBusy(true);
    try {
      for (const field of codexRestoreFields) {
        const trimmed = (codexRestoreDraft[field.key] ?? "").trim();
        const result = await api.control.executeSettings({ command: "set", key: field.key, value: trimmed.length === 0 ? null : trimmed });
        if (result.outcome === "storage_failure" || result.outcome === "invalid_value") {
          setStorageNotice(result.error ?? "Codex restore values could not be saved.");
          return;
        }
      }
      setStorageNotice(undefined);
    } catch {
      setStorageNotice("Codex restore values could not be saved.");
    } finally { setBusy(false); }
  };

  return <section className="page-stack">
    <div className="page-card settings-section">
      <div className="settings-copy"><p className="eyebrow">CODEX</p><h3>Codex restore values</h3><p>While enabled, LuckyToken replaces these three root fields in Codex config.toml.</p><p>Leave a field blank to remove it from Codex config.toml when the integration is turned off.</p></div>
      {codexRestoreFields.map((field) => <label className="codex-restore-field" key={field.key}><span>{field.label}</span><input type="text" aria-label={`${field.label} restore value`} value={codexRestoreDraft[field.key] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setCodexRestoreDraft((current) => ({ ...current, [field.key]: value })); }} /></label>)}
      {storageNotice === undefined ? null : <p className="error-text">{storageNotice}</p>}
      <button type="button" disabled={busy} onClick={() => void saveCodexRestoreValues()}>{busy ? "Saving…" : "Save Codex restore values"}</button>
    </div>
    <div className="page-card settings-section">
      <div className="settings-copy"><p className="eyebrow">WARNINGS</p><h3>Recent Runtime Events</h3></div>
      {eventsUnavailable ? <p className="error-text">Recent Runtime Events are temporarily unavailable.</p> : events === undefined ? <p>Loading Runtime Events…</p> : events.length === 0 ? <p>No warning-or-worse Runtime Events.</p> : <ul className="diagnostic-list">{events.map((record) => <li key={record.id}><span className={`badge ${record.level === "critical" || record.level === "error" ? "warning" : "neutral"}`}>{record.level}</span><span>{record.classification}: {record.safeMessage}</span></li>)}</ul>}
    </div>
  </section>;
}
