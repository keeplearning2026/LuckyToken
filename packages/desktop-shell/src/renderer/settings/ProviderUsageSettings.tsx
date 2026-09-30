import { useEffect, useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { SettingHelp } from "./SettingHelp.js";

const SETTING_KEY = "providerUsage.refreshIntervalMinutes";
const TIMEOUT_SETTING_KEY = "providerUsage.refreshTimeoutSeconds";

export function ProviderUsageSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [interval, setIntervalMinutes] = useState<number>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [timeoutSeconds, setRefreshTimeoutSeconds] = useState<number>();
  const [timeoutDraft, setTimeoutDraft] = useState("");
  const [timeoutBusy, setTimeoutBusy] = useState(false);
  const [timeoutNotice, setTimeoutNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({
      command: "query",
      keys: [SETTING_KEY, TIMEOUT_SETTING_KEY],
    }).then(
      (result) => {
        if (!active) return;
        const value = result.settings[SETTING_KEY]?.value;
        if (typeof value !== "number") {
          setNotice("Usage refresh setting is unavailable.");
        } else {
          setIntervalMinutes(value);
          setDraft(String(value));
        }
        const timeout = result.settings[TIMEOUT_SETTING_KEY]?.value;
        if (typeof timeout !== "number") {
          setTimeoutNotice("Usage refresh timeout setting is unavailable.");
        } else {
          setRefreshTimeoutSeconds(timeout);
          setTimeoutDraft(String(timeout));
        }
      },
      () => {
        if (!active) return;
        setNotice("Usage refresh setting is unavailable.");
        setTimeoutNotice("Usage refresh timeout setting is unavailable.");
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
    if (timeoutSeconds !== undefined && timeoutSeconds >= value * 60) {
      setNotice(`Refresh timeout must be less than ${value * 60} seconds.`);
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

  const saveTimeout = async (): Promise<void> => {
    const value = Number(timeoutDraft);
    if (!Number.isSafeInteger(value) || value < 5 || value > 600) {
      setTimeoutNotice("Enter a whole number of seconds from 5 to 600.");
      return;
    }
    if (interval !== undefined && value >= interval * 60) {
      setTimeoutNotice(`Timeout must be less than ${interval * 60} seconds.`);
      return;
    }
    setTimeoutBusy(true);
    try {
      const result = await api.control.executeSettings({
        command: "set",
        key: TIMEOUT_SETTING_KEY,
        value,
      });
      if (result.outcome !== "applied") {
        setTimeoutNotice(
          result.error ?? "Usage refresh timeout could not be saved.",
        );
        return;
      }
      const applied = result.settings[TIMEOUT_SETTING_KEY]?.value;
      if (typeof applied === "number") {
        setRefreshTimeoutSeconds(applied);
        setTimeoutDraft(String(applied));
      }
      setTimeoutNotice("Usage refresh timeout updated.");
    } catch {
      setTimeoutNotice("Usage refresh timeout could not be saved.");
    } finally {
      setTimeoutBusy(false);
    }
  };

  return (
    <section className="settings-section page-card">
      <header className="settings-section-header">
        <div className="settings-copy">
          <p className="eyebrow">PROVIDER USAGE</p>
          <h3>Automatic usage refresh <SettingHelp label="Automatic usage refresh">Refresh supported Provider usage in the background, even when the Providers page is closed. The per-refresh timeout must be shorter than the interval. Changes apply immediately.</SettingHelp></h3>
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
      <div className="usage-interval-row">
        <label className="field-row">
          <span>Refresh timeout (seconds)</span>
          <input
            aria-label="Usage refresh timeout in seconds"
            type="number"
            min={5}
            max={600}
            step={1}
            placeholder="45"
            value={timeoutDraft}
            onChange={(event) => setTimeoutDraft(event.currentTarget.value)}
          />
        </label>
        <button className="usage-interval-save" type="button" aria-label="Save usage timeout" disabled={timeoutBusy || timeoutSeconds === undefined} onClick={() => void saveTimeout()}>
          {timeoutBusy ? "Saving…" : "Save"}
        </button>
      </div>
      {timeoutNotice === undefined ? null : <p className="setting-state" role="status">{timeoutNotice}</p>}
    </section>
  );
}
