import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";
import { ClientAccessSettings } from "./ClientAccessSettings.js";

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
    <>
      <section className="settings-section page-card">
        <div>
          <p className="eyebrow">DESKTOP</p>
          <h3>General</h3>
          <p>
            {unavailable
              ? "Auto-start is unavailable on this desktop."
              : enabled
                ? "Starts at sign-in"
                : "Does not start at sign-in"}
          </p>
        </div>
        <button
          type="button"
          disabled={enabled === undefined || busy || unavailable}
          onClick={() => void toggle()}
        >
          {busy ? "Updating…" : enabled ? "Disable auto-start" : "Enable auto-start"}
        </button>
      </section>
      <ClientAccessSettings api={api} />
    </>
  );
}
