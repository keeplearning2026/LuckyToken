import { useEffect, useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";

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
            <p>
              A bounded repair Token may apply to a Provider Native response
              before the client sees it. A repair does nothing when the response
              is already correct, so leaving it on is safe; it exists so the
              exception can be withdrawn once the upstream stops degrading.
            </p>
          </div>
        </header>
        <div className="settings-copy">
          <h4>Function-call namespace repair</h4>
          <p>
            Some providers omit the namespace of a function call that the client
            declared inside a namespace. Codex then resolves the bare name under
            the default namespace and answers &apos;unsupported call&apos;.
            Token inserts the namespace the request itself declared. It never
            rewrites a namespace the provider already sent, never renames a
            tool, and never touches a name that is ambiguous, declared under
            several namespaces, also declared as a top-level tool, or not
            declared at all.
          </p>
        </div>
        <div className="settings-action-row">
          <div className="settings-action-copy">
            <strong>Provider Native lane</strong>
            <p>
              Preserved provider responses, before the client sees them. Other
              lanes are intentionally not covered.
            </p>
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
