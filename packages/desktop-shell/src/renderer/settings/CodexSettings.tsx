import { useEffect, useState } from "react";
import { Save } from "lucide-react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { SettingHelp } from "./SettingHelp.js";

export function CodexSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [searchModelDraft, setSearchModelDraft] = useState("gpt-6-luna");
  const [searchModelNotice, setSearchModelNotice] = useState<string>();
  const [searchModelError, setSearchModelError] = useState(false);
  const [searchModelBusy, setSearchModelBusy] = useState(false);
  const [searchModelLoaded, setSearchModelLoaded] = useState(false);
  const [autoLogin, setAutoLogin] = useState(true);
  const [autoLoginLoaded, setAutoLoginLoaded] = useState(false);
  const [autoLoginBusy, setAutoLoginBusy] = useState(false);
  const [autoLoginNotice, setAutoLoginNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({ command: "query", keys: [
      "integrations.codex.searchModel", "integrations.codex.autoLoginOnStartup",
    ] }).then((settings) => {
      if (!active) return;
      const searchModel = settings.settings["integrations.codex.searchModel"]?.value;
      const startup = settings.settings["integrations.codex.autoLoginOnStartup"]?.value;
      if (typeof startup === "boolean") {
        setAutoLogin(startup);
        setAutoLoginLoaded(true);
      }
      if (typeof searchModel === "string") {
        setSearchModelDraft(searchModel);
        setSearchModelLoaded(true);
      }
    }, () => {
      if (!active) return;
      setSearchModelNotice("Codex search model is temporarily unavailable.");
      setSearchModelError(true);
    });
    return () => { active = false; };
  }, [api]);

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

  return <section className="page-stack" aria-label="Codex search settings">
    <label className="field-row">
      <span>启动时自动登录本地 Codex</span>
      <input type="checkbox" aria-label="启动时自动登录本地 Codex"
        checked={autoLogin} disabled={!autoLoginLoaded || autoLoginBusy}
        onChange={(event) => {
          const value = event.currentTarget.checked;
          setAutoLoginBusy(true);
          void api.control.executeSettings({
            command: "set", key: "integrations.codex.autoLoginOnStartup", value,
          }).then((result) => {
            if (result.outcome === "pending" || result.outcome === "applied") {
              setAutoLogin(value);
              setAutoLoginNotice("已保存，下次启动生效。");
            } else setAutoLoginNotice(result.error ?? "设置未能保存。");
          }, () => setAutoLoginNotice("设置未能保存。"))
            .finally(() => setAutoLoginBusy(false));
        }} />
    </label>
    {autoLoginNotice === undefined ? null : <p className="setting-state" role="status">{autoLoginNotice}</p>}
    <h4 className="settings-subsection-title">Search request model <SettingHelp label="Search request model">Token sends /v1/alpha/search directly to Codex and replaces only the request model. Default: gpt-6-luna.</SettingHelp></h4>
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
  </section>;
}
