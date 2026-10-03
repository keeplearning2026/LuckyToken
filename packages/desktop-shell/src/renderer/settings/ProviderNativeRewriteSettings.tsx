import { useEffect, useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { SettingHelp } from "./SettingHelp.js";

const rewrites = [
  {
    key: "protocols.openai-responses.requestRepair.toolCallAdjacency.providerNative",
    label: "Tool-call adjacency reorder",
    action: "tool-call adjacency reorder",
    direction: "Request",
    help: "Moves an intervening developer message after a complete tool-call group. Tool calls, results, and message content are preserved. Turn off to keep the original input order.",
  },
  {
    key: "protocols.openai-responses.responseRepair.sseLifecycle.providerNative",
    label: "SSE lifecycle normalization",
    action: "SSE lifecycle normalization",
    direction: "Response",
    help: "Replays interleaved response items one at a time while preserving each item's events and the original completion order. Turn off to keep the provider's event order and sequence numbers.",
  },
  {
    key: "protocols.openai-responses.responseRepair.functionCallNamespace.providerNative",
    label: "Function-call namespace repair",
    action: "function-call namespace repair",
    direction: "Response",
    help: "When a provider omits a function call namespace, Token inserts the unique namespace declared by the client. Existing namespaces and ambiguous names are preserved.",
  },
] as const;

export function ProviderNativeRewriteSettings({ api }: { readonly api: TokenDesktopApi }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [noticeError, setNoticeError] = useState(false);

  useEffect(() => {
    let active = true;
    void api.control.executeSettings({ command: "query", keys: rewrites.map((rewrite) => rewrite.key) }).then(
      (settings) => {
        if (!active) return;
        setEnabled(Object.fromEntries(rewrites.map(({ key }) => [key, settings.settings[key]?.value !== false])));
        setLoaded(true);
      },
      () => {
        if (!active) return;
        setNotice("Provider Native rewrite settings are temporarily unavailable.");
        setNoticeError(true);
      },
    );
    return () => { active = false; };
  }, [api]);

  const save = async (key: string, next: boolean): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.control.executeSettings({ command: "set", key, value: next });
      if (result.outcome === "applied") {
        setEnabled((previous) => ({ ...previous, [key]: result.settings[key]?.value !== false }));
        setNotice("Rewrite setting applied. New requests use the updated setting.");
        setNoticeError(false);
      } else {
        setNotice(result.error ?? "Rewrite setting could not be saved.");
        setNoticeError(true);
      }
    } catch {
      setNotice("Rewrite setting could not be saved.");
      setNoticeError(true);
    } finally { setBusy(false); }
  };

  return <section className="page-stack">
    <div className="page-card settings-section">
      <header className="settings-section-header">
        <div className="settings-copy"><p className="eyebrow">RESPONSES</p><h3>Provider Native rewrites</h3></div>
      </header>
      {rewrites.map((rewrite) => {
        const isEnabled = enabled[rewrite.key] !== false;
        return <div className="settings-action-row" key={rewrite.key}>
          <div className="settings-action-copy">
            <strong>{rewrite.label} <SettingHelp label={rewrite.label}>{rewrite.help} Applies only to Provider Native Responses.</SettingHelp></strong>
            <p>{rewrite.direction} · Provider Native lane</p>
          </div>
          <button type="button" className={`switch-control${isEnabled ? " on" : ""}`}
            aria-label={`${isEnabled ? "Disable" : "Enable"} ${rewrite.action}`}
            aria-pressed={isEnabled} aria-busy={busy} disabled={busy || !loaded}
            onClick={() => void save(rewrite.key, !isEnabled)}><span aria-hidden="true" /></button>
        </div>;
      })}
      {notice === undefined ? null : <p className={noticeError ? "error-text" : "setting-state"} role="status">{notice}</p>}
    </div>
  </section>;
}
