import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

export function GeneralSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void api.platform.getAutoStart().then(
      (value) => {
        if (!active) return;
        setEnabled(value);
        setUnavailable(false);
      },
      () => {
        if (active) setUnavailable(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const toggle = async (): Promise<void> => {
    if (enabled === undefined || unavailable) return;
    setBusy(true);
    try {
      setEnabled(await api.platform.setAutoStart(!enabled));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section page-card">
      <header className="settings-section-header">
        <div className="settings-copy">
          <p className="eyebrow">DESKTOP</p>
          <h3>Start Token automatically</h3>
          <p>Launch Token in the background when you sign in to Windows.</p>
        </div>
        <span
          className={`settings-status ${unavailable ? "unavailable" : enabled ? "on" : "off"}`}
          aria-live="polite"
        >
          {unavailable ? "Unavailable" : enabled === undefined ? "Loading" : enabled ? "On" : "Off"}
        </span>
      </header>
      <div className="settings-action-row">
        <div className="settings-action-copy">
          <strong>Open at sign-in</strong>
          <p>
            {unavailable
              ? "Windows startup settings could not be read."
              : enabled
                ? "Token starts minimized and keeps the gateway available."
                : "Token starts only when you open it."}
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          aria-pressed={enabled ?? false}
          disabled={enabled === undefined || busy || unavailable}
          onClick={() => void toggle()}
        >
          {busy ? "Updating…" : enabled ? "Disable auto-start" : "Enable auto-start"}
        </button>
      </div>
    </section>
  );
}
