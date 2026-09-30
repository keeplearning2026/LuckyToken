import { useEffect, useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { SettingHelp } from "./SettingHelp.js";

const protocols = {
  responses: { key: "protocols.openai-responses.enabled", label: "Responses", path: "/v1/responses" },
  anthropic: { key: "protocols.anthropic-messages.enabled", label: "Anthropic Messages", path: "/v1/messages" },
} as const;

export function ProtocolSettings({ api, protocol }: { readonly api: TokenDesktopApi; readonly protocol: keyof typeof protocols }) {
  const { key, label, path } = protocols[protocol];
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({ command: "query", keys: [key] }).then(
      (result) => { if (active) setEnabled(result.settings[key]?.value !== false); },
      () => { if (active) setNotice("Protocol setting is temporarily unavailable."); },
    );
    return () => { active = false; };
  }, [api, key]);

  const toggle = async (): Promise<void> => {
    if (enabled === undefined) return;
    setBusy(true);
    try {
      const result = await api.control.executeSettings({ command: "set", key, value: !enabled });
      if (result.outcome !== "applied") {
        setNotice(result.error ?? "Protocol setting could not be saved.");
        return;
      }
      setEnabled(result.settings[key]?.value !== false);
      setNotice("Protocol setting applied.");
    } catch {
      setNotice("Protocol setting could not be saved.");
    } finally { setBusy(false); }
  };

  return <div className="page-card settings-section">
    <header className="settings-section-header">
      <div className="settings-copy"><p className="eyebrow">CLIENT PROTOCOL</p><h3>{label}</h3></div>
      <span className={`settings-status ${enabled ? "on" : "off"}`}>{enabled === undefined ? "Unavailable" : enabled ? "On" : "Off"}</span>
    </header>
    <div className="settings-action-row">
      <div className="settings-action-copy"><strong>Enable protocol <SettingHelp label={`${label} protocol`}>Disabling this protocol makes {path} unavailable. Requests to that route return 404.</SettingHelp></strong><p>{path}</p></div>
      <button type="button" className={`switch-control${enabled ? " on" : ""}`}
        aria-label={`${enabled ? "Disable" : "Enable"} ${label} protocol`}
        aria-pressed={enabled === true} aria-busy={busy} disabled={busy || enabled === undefined}
        onClick={() => void toggle()}><span aria-hidden="true" /></button>
    </div>
    {notice === undefined ? null : <p className="setting-state" role="status">{notice}</p>}
  </div>;
}
