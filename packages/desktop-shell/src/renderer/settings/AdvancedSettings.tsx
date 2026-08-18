import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type SettingsResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeSettings"]>>;
type Setting = SettingsResult["settings"][string];
type DiagnosticResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["getDiagnostics"]>>;

export function AdvancedSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [deepCapture, setDeepCapture] = useState<Setting>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult>();
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const [settings, records] = await Promise.all([
      api.control.executeSettings({
        command: "query",
        keys: ["diagnostics.deepCapture.enabled"],
      }),
      api.control.getDiagnostics({ minimumLevel: "warning", limit: 25 }),
    ]);
    setDeepCapture(settings.settings["diagnostics.deepCapture.enabled"]);
    setDiagnostics(records);
  };

  useEffect(() => {
    void load();
  }, [api]);

  const toggleDeepCapture = async (): Promise<void> => {
    if (deepCapture === undefined || typeof deepCapture.value !== "boolean") return;
    setBusy(true);
    try {
      const result = await api.control.executeSettings({
        command: "set",
        key: "diagnostics.deepCapture.enabled",
        value: !deepCapture.value,
      });
      setDeepCapture(result.settings["diagnostics.deepCapture.enabled"]);
    } finally {
      setBusy(false);
    }
  };

  const enabled = deepCapture?.value === true;

  return (
    <section className="page-stack">
      <div className="page-card settings-section">
        <div className="settings-copy">
          <p className="eyebrow">DIAGNOSTICS</p>
          <h3>Deep diagnostics</h3>
          <p>Capture is off by default. The Backend owns redaction, retention, and persistence.</p>
          {deepCapture?.applyMode === "hot-apply" ? <p className="setting-state">Applies immediately</p> : null}
        </div>
        <button type="button" disabled={deepCapture === undefined || busy} onClick={() => void toggleDeepCapture()}>
          {busy ? "Updating…" : enabled ? "Disable deep diagnostics" : "Enable deep diagnostics"}
        </button>
      </div>

      <div className="page-card settings-section">
        <div className="settings-copy">
          <p className="eyebrow">WARNINGS</p>
          <h3>Recent diagnostics</h3>
        </div>
        {diagnostics === undefined ? <p>Loading diagnostics…</p> : diagnostics.records.length === 0 ? <p>No warning-or-worse diagnostics.</p> : (
          <ul className="diagnostic-list">
            {diagnostics.records.map((record) => (
              <li key={record.id}>
                <span className={`badge ${record.level === "critical" || record.level === "error" ? "warning" : "neutral"}`}>{record.level}</span>
                <span>{record.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
