import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi, RuntimeEventRecord } from "../../shared/desktop-api.js";

const codexRestoreFields = Object.freeze([
  {
    key: "integrations.codex.preimage.modelProvider",
    label: "Model provider",
    code: "model_provider",
    description: "The provider Codex used before Token integration was enabled.",
  },
  {
    key: "integrations.codex.preimage.openaiBaseUrl",
    label: "OpenAI base URL",
    code: "openai_base_url",
    description: "The previous OpenAI-compatible endpoint, if one was configured.",
  },
  {
    key: "integrations.codex.preimage.modelCatalogJson",
    label: "Model catalog file",
    code: "model_catalog_json",
    description: "The previous path to Codex's model catalog JSON file.",
  },
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
  const [storageNoticeError, setStorageNoticeError] = useState(false);
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
    }, () => {
      if (!active) return;
      setStorageNotice("Codex restore values are temporarily unavailable.");
      setStorageNoticeError(true);
    });
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
          setStorageNoticeError(true);
          return;
        }
      }
      setStorageNotice("Codex restore values saved.");
      setStorageNoticeError(false);
    } catch {
      setStorageNotice("Codex restore values could not be saved.");
      setStorageNoticeError(true);
    } finally { setBusy(false); }
  };

  return <section className="page-stack">
    <div className="page-card settings-section">
      <header className="settings-section-header">
        <div className="settings-copy">
          <p className="eyebrow">CODEX</p>
          <h3>Restore values when integration is disabled</h3>
          <p>Token temporarily replaces these Codex settings while the integration is enabled.</p>
        </div>
      </header>
      <p className="settings-callout">Leave a field blank to remove that setting from <code>config.toml</code> when integration is turned off.</p>
      <div className="codex-restore-fields">
        {codexRestoreFields.map((field) => <label className="codex-restore-field" key={field.key}>
          <span className="codex-restore-label"><strong>{field.label}</strong><code>{field.code}</code></span>
          <small>{field.description}</small>
          <input type="text" aria-label={`${field.label} restore value`} value={codexRestoreDraft[field.key] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setCodexRestoreDraft((current) => ({ ...current, [field.key]: value })); }} />
        </label>)}
      </div>
      {storageNotice === undefined ? null : <p className={storageNoticeError ? "error-text" : "setting-state"} role="status">{storageNotice}</p>}
      <div className="settings-form-actions">
        <button type="button" disabled={busy} onClick={() => void saveCodexRestoreValues()}>{busy ? "Saving…" : "Save restore values"}</button>
      </div>
    </div>
    <div className="page-card settings-section">
      <header className="settings-section-header">
        <div className="settings-copy"><p className="eyebrow">DIAGNOSTICS</p><h3>Recent warnings</h3><p>Only warning, error, and critical runtime events are shown here.</p></div>
      </header>
      {eventsUnavailable ? <p className="error-text">Recent runtime warnings are temporarily unavailable.</p> : events === undefined ? <p>Loading runtime warnings…</p> : events.length === 0 ? <p className="settings-empty-state">No recent runtime warnings.</p> : <ul className="diagnostic-list">{events.map((record) => <li key={record.id}><span className={`badge ${record.level === "critical" || record.level === "error" ? "warning" : "neutral"}`}>{record.level}</span><span><strong>{record.safeMessage}</strong><code>{record.classification}</code></span></li>)}</ul>}
    </div>
  </section>;
}
