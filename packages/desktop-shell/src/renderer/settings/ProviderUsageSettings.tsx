import { useEffect, useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { SettingHelp } from "./SettingHelp.js";

const SETTING_KEY = "providerUsage.refreshIntervalMinutes";

export function ProviderUsageSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [interval, setIntervalMinutes] = useState<number>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({ command: "query", keys: [SETTING_KEY] }).then(
      (result) => {
        if (!active) return;
        const value = result.settings[SETTING_KEY]?.value;
        if (typeof value !== "number") {
          setNotice("Usage refresh setting is unavailable.");
          return;
        }
        setIntervalMinutes(value);
        setDraft(String(value));
      },
      () => {
        if (active) setNotice("Usage refresh setting is unavailable.");
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const save = async (): Promise<void> => {
    const value = Number(draft);
    if (!Number.isSafeInteger(value) || value < 1 || value > 1440) {
      setNotice("Enter a whole number of minutes from 1 to 1440.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.control.executeSettings({
        command: "set",
        key: SETTING_KEY,
        value,
      });
      if (result.outcome !== "applied") {
        setNotice(result.error ?? "Usage refresh interval could not be saved.");
        return;
      }
      const applied = result.settings[SETTING_KEY]?.value;
      if (typeof applied === "number") {
        setIntervalMinutes(applied);
        setDraft(String(applied));
      }
      setNotice("Usage refresh interval updated.");
    } catch {
      setNotice("Usage refresh interval could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section page-card">
      <header className="settings-section-header">
        <div className="settings-copy">
          <p className="eyebrow">PROVIDER USAGE</p>
          <h3>Automatic usage refresh <SettingHelp label="Automatic usage refresh">Refresh supported Provider usage in the background, even when the Providers page is closed. Default: every 15 minutes. Changes apply immediately.</SettingHelp></h3>
        </div>
      </header>
      <div className="usage-interval-row">
        <label className="field-row">
          <span>Refresh every (minutes)</span>
          <input
            aria-label="Usage refresh interval in minutes"
            type="number"
            min={1}
            max={1440}
            step={1}
            placeholder="15"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
        <button className="usage-interval-save" type="button" aria-label="Save usage interval" disabled={busy || interval === undefined} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {notice === undefined ? null : <p className="setting-state" role="status">{notice}</p>}
    </section>
  );
}
