import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type SettingsResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeSettings"]>>;
type Setting = SettingsResult["settings"][string];

export function NetworkSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [setting, setSetting] = useState<Setting>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void api.control
      .executeSettings({ command: "query", keys: ["server.port"] })
      .then((result) => {
        if (!active) return;
        const next = result.settings["server.port"];
        setSetting(next);
        setDraft(next === undefined ? "" : String(next.value));
      });
    return () => {
      active = false;
    };
  }, [api]);

  const save = async (): Promise<void> => {
    const value = Number(draft);
    if (!Number.isSafeInteger(value)) {
      setNotice("Enter a valid port.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.control.executeSettings({
        command: "set",
        key: "server.port",
        value,
      });
      setSetting(result.settings["server.port"]);
      setNotice(result.error);
    } finally {
      setBusy(false);
    }
  };

  const restartRequired =
    setting?.applyMode === "restart-required" &&
    setting.effective !== undefined &&
    setting.value !== setting.effective;

  return (
    <section className="settings-section page-card">
      <div className="settings-copy">
        <p className="eyebrow">NETWORK</p>
        <h3>Gateway endpoint</h3>
        <p>The Backend validates the registered port setting. This draft stays in the current window until saved.</p>
      </div>
      <label className="field-row">
        <span>Gateway port</span>
        <input
          aria-label="Gateway port"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </label>
      {restartRequired ? (
        <p className="setting-state warning-text">Restart required · effective port {String(setting.effective)}</p>
      ) : setting?.applyMode === "hot-apply" ? (
        <p className="setting-state">Applies immediately</p>
      ) : null}
      {notice === undefined ? null : <p className="error-text">{notice}</p>}
      <button type="button" disabled={busy || setting === undefined} onClick={() => void save()}>
        {busy ? "Saving…" : "Save network"}
      </button>
    </section>
  );
}
