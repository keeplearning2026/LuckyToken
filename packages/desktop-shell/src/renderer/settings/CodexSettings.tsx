import { useEffect, useState } from "react";
import { Save } from "lucide-react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { SettingHelp } from "./SettingHelp.js";

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

export function CodexSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [storageNotice, setStorageNotice] = useState<string>();
  const [storageNoticeError, setStorageNoticeError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codexRestoreDraft, setCodexRestoreDraft] = useState<Readonly<Record<string, string>>>({});
  const [standaloneSearchRestore, setStandaloneSearchRestore] = useState<"remove" | "true" | "false">("remove");
  const [searchModelDraft, setSearchModelDraft] = useState("gpt-6-luna");
  const [searchModelNotice, setSearchModelNotice] = useState<string>();
  const [searchModelError, setSearchModelError] = useState(false);
  const [searchModelBusy, setSearchModelBusy] = useState(false);
  const [searchModelLoaded, setSearchModelLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({ command: "query", keys: [...codexRestoreFields.map((field) => field.key), "integrations.codex.preimage.standaloneWebSearch", "integrations.codex.searchModel"] }).then((settings) => {
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
      const standaloneValue = settings.settings["integrations.codex.preimage.standaloneWebSearch"]?.value;
      setStandaloneSearchRestore(standaloneValue === true ? "true" : standaloneValue === false ? "false" : "remove");
    }, () => {
      if (!active) return;
      setStorageNotice("Codex restore values are temporarily unavailable.");
      setStorageNoticeError(true);
    });
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
      const standaloneResult = await api.control.executeSettings({
        command: "set",
        key: "integrations.codex.preimage.standaloneWebSearch",
        value: standaloneSearchRestore === "remove" ? null : standaloneSearchRestore === "true",
      });
      if (standaloneResult.outcome === "storage_failure" || standaloneResult.outcome === "invalid_value") {
        setStorageNotice(standaloneResult.error ?? "Codex restore values could not be saved.");
        setStorageNoticeError(true);
        return;
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
          <h3>Search request model <SettingHelp label="Search request model">Token sends /v1/alpha/search directly to Codex and replaces only the request model. Default: gpt-6-luna.</SettingHelp></h3>
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
          <h3>Restore values <SettingHelp label="Codex restore values">Token temporarily replaces these Codex settings. When the integration is disabled, these values are restored. Leave a field blank to remove that setting from config.toml.</SettingHelp></h3>
        </div>
      </header>
      <div className="codex-restore-fields">
        {codexRestoreFields.map((field) => <label className="codex-restore-field" key={field.key}>
          <span className="codex-restore-label"><strong>{field.label}</strong><SettingHelp label={field.label}>{field.description} Codex key: {field.code}.</SettingHelp></span>
          <input type="text" aria-label={`${field.label} restore value`} value={codexRestoreDraft[field.key] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setCodexRestoreDraft((current) => ({ ...current, [field.key]: value })); }} />
        </label>)}
        <label className="codex-restore-field">
          <span className="codex-restore-label"><strong>Standalone web search</strong><SettingHelp label="Standalone web search">Value to restore when Token integration is disabled. Codex key: [features].standalone_web_search.</SettingHelp></span>
          <select aria-label="Standalone web search restore value" value={standaloneSearchRestore} onChange={(event) => setStandaloneSearchRestore(event.currentTarget.value as "remove" | "true" | "false")}>
            <option value="remove">Remove setting</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        </label>
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
  </section>;
}
