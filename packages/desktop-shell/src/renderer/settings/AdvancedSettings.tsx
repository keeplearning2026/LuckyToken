import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type SettingsResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeSettings"]>>;
type Setting = SettingsResult["settings"][string];
type DiagnosticResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["getDiagnostics"]>>;

const codexRestoreFields = Object.freeze([
  { key: "integrations.codex.preimage.modelProvider", label: "model_provider" },
  { key: "integrations.codex.preimage.openaiBaseUrl", label: "openai_base_url" },
  { key: "integrations.codex.preimage.modelCatalogJson", label: "model_catalog_json" },
]);

export function AdvancedSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [deepCapture, setDeepCapture] = useState<Setting>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult>();
  const [deepCaptureUnavailable, setDeepCaptureUnavailable] = useState(false);
  const [diagnosticsUnavailable, setDiagnosticsUnavailable] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [codexRestoreDraft, setCodexRestoreDraft] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let active = true;
    void api.control
      .executeSettings({
        command: "query",
        keys: [
          "diagnostics.deepCapture.enabled",
          ...codexRestoreFields.map((field) => field.key),
        ],
      })
      .then(
        (settings) => {
          if (!active) return;
          setDeepCapture(settings.settings["diagnostics.deepCapture.enabled"]);
          setCodexRestoreDraft(
            Object.freeze(
              Object.fromEntries(
                codexRestoreFields.map((field) => {
                  const value = settings.settings[field.key]?.value;
                  return [field.key, typeof value === "string" ? value : ""];
                }),
              ),
            ),
          );
          setDeepCaptureUnavailable(false);
        },
        () => {
          if (active) setDeepCaptureUnavailable(true);
        },
      );
    void api.control
      .getDiagnostics({ minimumLevel: "warning", limit: 25 })
      .then(
        (records) => {
          if (!active) return;
          setDiagnostics(records);
          setDiagnosticsUnavailable(false);
        },
        () => {
          if (active) setDiagnosticsUnavailable(true);
        },
      );
    return () => {
      active = false;
    };
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
      setStorageNotice(
        result.outcome === "storage_failure"
          ? result.error ?? "Settings could not be saved"
          : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const saveCodexRestoreValues = async (): Promise<void> => {
    setBusy(true);
    try {
      for (const field of codexRestoreFields) {
        const trimmed = (codexRestoreDraft[field.key] ?? "").trim();
        const result = await api.control.executeSettings({
          command: "set",
          key: field.key,
          value: trimmed.length === 0 ? null : trimmed,
        });
        if (result.outcome === "storage_failure" || result.outcome === "invalid_value") {
          setStorageNotice(result.error ?? "Codex restore values could not be saved.");
          return;
        }
      }
      setStorageNotice(undefined);
    } catch {
      setStorageNotice("Codex restore values could not be saved.");
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
          {deepCaptureUnavailable ? <p className="error-text">Deep diagnostics setting is temporarily unavailable.</p> : null}
          {storageNotice === undefined ? null : <p className="error-text">{storageNotice}</p>}
        </div>
        <button type="button" disabled={deepCapture === undefined || busy} onClick={() => void toggleDeepCapture()}>
          {busy ? "Updating…" : enabled ? "Disable deep diagnostics" : "Enable deep diagnostics"}
        </button>
      </div>

      <div className="page-card settings-section">
        <div className="settings-copy">
          <p className="eyebrow">CODEX</p>
          <h3>Codex restore values</h3>
          <p>
            While enabled, LuckyToken replaces these three root fields in Codex config.toml.
          </p>
          <p>
            Leave a field blank to remove it from Codex config.toml when the integration is turned off.
          </p>
        </div>
        {codexRestoreFields.map((field) => (
          <label className="codex-restore-field" key={field.key}>
            <span>{field.label}</span>
            <input
              type="text"
              aria-label={`${field.label} restore value`}
              value={codexRestoreDraft[field.key] ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setCodexRestoreDraft((current) => ({
                  ...current,
                  [field.key]: value,
                }));
              }}
            />
          </label>
        ))}
        <button type="button" disabled={busy} onClick={() => void saveCodexRestoreValues()}>
          {busy ? "Saving…" : "Save Codex restore values"}
        </button>
      </div>

      <div className="page-card settings-section">
        <div className="settings-copy">
          <p className="eyebrow">WARNINGS</p>
          <h3>Recent diagnostics</h3>
        </div>
        {diagnosticsUnavailable ? <p className="error-text">Recent diagnostics are temporarily unavailable.</p> : diagnostics === undefined ? <p>Loading diagnostics…</p> : diagnostics.records.length === 0 ? <p>No warning-or-worse diagnostics.</p> : (
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
