import { useEffect, useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { SettingHelp } from "./SettingHelp.js";

const SETTING_KEY = "credentials.autoLocalOAuth.enabled";

export function LocalLoginSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({ command: "query", keys: [SETTING_KEY] }).then(
      (result) => {
        if (!active) return;
        const value = result.settings[SETTING_KEY]?.value;
        if (typeof value === "boolean") setEnabled(value);
        else setNotice("Automatic local login setting is unavailable.");
      },
      () => { if (active) setNotice("Automatic local login setting is unavailable."); },
    );
    return () => { active = false; };
  }, [api]);

  const toggle = async (): Promise<void> => {
    if (enabled === undefined || busy) return;
    setBusy(true);
    try {
      const result = await api.control.executeSettings({
        command: "set", key: SETTING_KEY, value: !enabled,
      });
      const value = result.settings[SETTING_KEY]?.value;
      if (result.outcome !== "applied" || typeof value !== "boolean") {
        setNotice(result.error ?? "Automatic local login setting could not be saved.");
        return;
      }
      setEnabled(value);
      setNotice(value
        ? "Automatic local login enabled. Available local accounts will be connected in the background."
        : "Automatic local login disabled. Existing Profiles are kept.");
    } catch {
      setNotice("Automatic local login setting could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section page-card">
      <header className="settings-section-header">
        <div className="settings-copy">
          <p className="eyebrow">PROVIDER LOGIN</p>
          <h3>Automatic local OAuth login <SettingHelp label="Automatic local OAuth login">Connect existing local OAuth accounts when this setting is enabled and whenever Token starts. Profiles are named after the Provider followed by “local login”. Existing local Profiles are skipped, including disabled ones. Removed local Profiles are added again on the next startup while this setting is on.</SettingHelp></h3>
        </div>
        <span className={`settings-status ${enabled ? "on" : "off"}`} aria-live="polite">
          {enabled === undefined ? notice === undefined ? "Loading" : "Unavailable" : enabled ? "On" : "Off"}
        </span>
      </header>
      <div className="settings-action-row">
        <div className="settings-action-copy">
          <strong>Connect local accounts automatically</strong>
          <p>Uses existing local login files for supported Providers. Turning this off keeps your Profiles.</p>
        </div>
        <button
          type="button"
          className={`switch-control${enabled ? " on" : ""}`}
          aria-label={enabled ? "Disable automatic local OAuth login" : "Enable automatic local OAuth login"}
          aria-pressed={enabled === true}
          aria-busy={busy}
          disabled={busy || enabled === undefined}
          onClick={() => void toggle()}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {notice === undefined ? null : <p className="setting-state" role="status">{notice}</p>}
    </section>
  );
}
