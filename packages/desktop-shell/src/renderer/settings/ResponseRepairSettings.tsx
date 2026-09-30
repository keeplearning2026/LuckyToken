import { useEffect, useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { SettingHelp } from "./SettingHelp.js";

/** The only response repair Token currently ships. */
const namespaceRepairKey =
  "protocols.openai-responses.responseRepair.functionCallNamespace.providerNative";

export function ResponseRepairSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [noticeError, setNoticeError] = useState(false);

  useEffect(() => {
    let active = true;
    void api.control
      .executeSettings({ command: "query", keys: [namespaceRepairKey] })
      .then(
        (settings) => {
          if (!active) return;
          setEnabled(settings.settings[namespaceRepairKey]?.value !== false);
          setLoaded(true);
        },
        () => {
          if (!active) return;
          setNotice("Response repair settings are temporarily unavailable.");
          setNoticeError(true);
        },
      );
    return () => {
      active = false;
    };
  }, [api]);

  const save = async (next: boolean): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.control.executeSettings({
        command: "set",
        key: namespaceRepairKey,
        value: next,
      });
      if (result.outcome === "applied") {
        setEnabled(result.settings[namespaceRepairKey]?.value !== false);
        setNotice(next ? "Repair enabled." : "Repair disabled.");
        setNoticeError(false);
      } else {
        setNotice(result.error ?? "Response repair setting could not be saved.");
        setNoticeError(true);
      }
    } catch {
      setNotice("Response repair setting could not be saved.");
      setNoticeError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page-stack">
      <div className="page-card settings-section">
        <header className="settings-section-header">
          <div className="settings-copy">
            <p className="eyebrow">RESPONSES</p>
            <h3>Response repair</h3>
          </div>
        </header>
        <div className="settings-action-row">
          <div className="settings-action-copy">
            <strong>Function-call namespace repair <SettingHelp label="Function-call namespace repair">
              For Provider Native Responses only. When a provider omits a function call namespace, Token inserts the unique namespace declared by the client. Existing namespaces, ambiguous names, and other lanes are left unchanged.
            </SettingHelp></strong>
            <p>Provider Native lane</p>
          </div>
          <button
            type="button"
            className={`switch-control${enabled ? " on" : ""}`}
            aria-label={
              enabled
                ? "Disable function-call namespace repair"
                : "Enable function-call namespace repair"
            }
            aria-pressed={enabled}
            aria-busy={busy}
            disabled={busy || !loaded}
            onClick={() => void save(!enabled)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        {notice === undefined ? null : (
          <p className={noticeError ? "error-text" : "setting-state"} role="status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
