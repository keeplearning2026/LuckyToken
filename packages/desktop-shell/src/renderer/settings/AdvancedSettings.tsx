import { useEffect, useState } from "react";
import { Save } from "lucide-react";

import type { TokenDesktopApi, RuntimeEventRecord } from "../../shared/desktop-api.js";

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

async function queryRecentWarnings(api: TokenDesktopApi): Promise<readonly RuntimeEventRecord[] | "unavailable"> {
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

export function AdvancedSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [events, setEvents] = useState<readonly RuntimeEventRecord[]>();
  const [eventsUnavailable, setEventsUnavailable] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string>();
  const [storageNoticeError, setStorageNoticeError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codexRestoreDraft, setCodexRestoreDraft] = useState<Readonly<Record<string, string>>>({});
  const [searchModelDraft, setSearchModelDraft] = useState("gpt-6-luna");
  const [searchModelNotice, setSearchModelNotice] = useState<string>();
  const [searchModelError, setSearchModelError] = useState(false);
  const [searchModelBusy, setSearchModelBusy] = useState(false);
  const [searchModelLoaded, setSearchModelLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({ command: "query", keys: [...codexRestoreFields.map((field) => field.key), "integrations.codex.searchModel"] }).then((settings) => {
      if (!active) return;
      const searchModel = settings.settings["integrations.codex.searchModel"]?.value;
      if (typeof searchModel === "string") {
        setSearchModelDraft(searchModel);
        setSearchModelLoaded(true);
      }
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

  const saveSearchModel = async (): Promise<void> => {
    setSearchModelBusy(true);
    try {
      const result = await api.control.executeSettings({
        command: "set",
        key: "integrations.codex.searchModel",
        value: searchModelDraft.trim(),
      });
      if (result.outcome === "applied") {
        const value = result.settings["integrations.codex.searchModel"]?.value;
        if (typeof value === "string") setSearchModelDraft(value);
        setSearchModelNotice("Search model saved and applied.");
        setSearchModelError(false);
      } else {
        setSearchModelNotice(result.error ?? "Search model could not be saved.");
        setSearchModelError(true);
      }
    } catch {
      setSearchModelNotice("Search model could not be saved.");
      setSearchModelError(true);
    } finally {
      setSearchModelBusy(false);
    }
  };

  return <section className="page-stack">
    <div className="page-card settings-section">
      <header className="settings-section-header">
        <div className="settings-copy">
          <p className="eyebrow">CODEX SEARCH</p>
          <h3>Search request model</h3>
          <p>Token sends <code>/v1/alpha/search</code> directly to Codex and replaces only the request model. The default is <code>gpt-6-luna</code>.</p>
        </div>
      </header>
      <label className="field-row">
        <span>Upstream model</span>
        <input type="text" aria-label="Codex search model" value={searchModelDraft} onChange={(event) => setSearchModelDraft(event.currentTarget.value)} />
      </label>
      {searchModelNotice === undefined ? null : <p className={searchModelError ? "error-text" : "setting-state"} role="status">{searchModelNotice}</p>}
      <div className="settings-form-actions">
        <button type="button" className="settings-icon-button save" aria-label="Save Codex search model" aria-busy={searchModelBusy} title={searchModelBusy ? "Saving search model" : "Save search model"} disabled={searchModelBusy || !searchModelLoaded} onClick={() => void saveSearchModel()}>
          <Save size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
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
        <button
          type="button"
          className="settings-icon-button save"
          aria-label="Save restore values"
          aria-busy={busy}
          title={busy ? "Saving restore values" : "Save restore values"}
          disabled={busy}
          onClick={() => void saveCodexRestoreValues()}
        >
          <Save size={18} aria-hidden="true" />
        </button>
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
