import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import type { AgentIntegrationId, AgentInjectionScope, TokenDesktopApi } from "../../shared/desktop-api.js";

type IntegrationResult = Awaited<ReturnType<TokenDesktopApi["control"]["executeAgentIntegrations"]>>;
type IntegrationState = IntegrationResult["state"];

export function AgentIntegrationSettings({ api, modelRevision }: { readonly api: TokenDesktopApi; readonly modelRevision?: number | undefined }) {
  const [state, setState] = useState<IntegrationState>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [warnings, setWarnings] = useState<readonly string[]>([]);

  useEffect(() => {
    let active = true;
    void api.control.executeAgentIntegrations({ command: "query" }).then(
      (result) => { if (active) setState(result.state); },
      () => { if (active) setNotice("Agent integrations are temporarily unavailable."); },
    );
    return () => { active = false; };
  }, [api, modelRevision]);

  const accept = (result: IntegrationResult): void => {
    setState(result.state);
    const effects = result.results.flatMap((entry) => entry.effect === undefined ? [] : [entry.effect]);
    setWarnings([...new Set(effects.flatMap((effect) => effect.warnings))]);
    const messages = effects.flatMap((effect) => effect.message === undefined ? [] : [effect.message]);
    setNotice(messages.length > 0
      ? messages.join(" ")
      : result.outcome === "partial"
        ? "Some Agent integrations could not be synchronized. Successful Agents were kept."
        : result.outcome === "failed"
          ? "Agent integration update failed. Existing Agent files were preserved."
          : undefined);
  };

  const toggle = async (agentId: AgentIntegrationId): Promise<void> => {
    const agent = state?.agents.find((entry) => entry.agentId === agentId);
    if (busy || agent === undefined) return;
    setBusy(true);
    try {
      accept(await api.control.executeAgentIntegrations({ command: "set_enabled", agentId, enabled: !agent.enabled }));
    } catch {
      setNotice(`${agentId === "codex" ? "Codex" : "Pi"} integration update failed. Existing Agent files were preserved.`);
    } finally { setBusy(false); }
  };

  const setScope = async (agentId: AgentIntegrationId, scope: AgentInjectionScope): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      accept(await api.control.executeAgentIntegrations({ command: "set_scope", agentId, scope }));
    } catch {
      setNotice("The Agent injection scope could not be saved.");
    } finally { setBusy(false); }
  };

  const sync = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      accept(await api.control.executeAgentIntegrations({ command: "sync" }));
    } catch {
      setNotice("Agent synchronization failed. Existing Agent files were preserved.");
    } finally { setBusy(false); }
  };

  const anyEnabled = state?.agents.some((agent) => agent.enabled) ?? false;
  const needsSync = state?.agents.some((agent) => agent.enabled && agent.needsSync) ?? false;

  return <section className="page-stack" aria-label="Agent integrations">
    {(["codex", "pi"] as const).map((agentId) => {
      const agent = state?.agents.find((entry) => entry.agentId === agentId);
      const label = agentId === "codex" ? "Codex" : "Pi";
      return <div className="page-card settings-section" key={agentId}>
        <header className="settings-section-header">
          <div className="settings-copy"><p className="eyebrow">AGENT INTEGRATION</p><h3>{label}</h3></div>
          <span className={`settings-status ${agent?.enabled ? "on" : "off"}`}>{agent === undefined ? "Unavailable" : agent.enabled ? "On" : "Off"}</span>
        </header>
        <div className="settings-action-row">
          <div className="settings-action-copy"><strong>Inject Token models</strong></div>
          <button type="button" className={`switch-control${agent?.enabled ? " on" : ""}`}
            aria-label={`${agent?.enabled ? "Disable" : "Enable"} ${label} integration`}
            aria-pressed={agent?.enabled ?? false} aria-busy={busy} disabled={busy || agent === undefined}
            onClick={() => void toggle(agentId)}><span aria-hidden="true" /></button>
        </div>
        <label className="field-row">
          <span>Models to inject</span>
          <select aria-label={`${label} injection scope`} value={agent?.scope ?? "favorite"}
            disabled={busy || agent === undefined}
            onChange={(event) => void setScope(agentId, event.currentTarget.value as AgentInjectionScope)}>
            <option value="favorite">Favorite models</option>
            <option value="full">All models</option>
          </select>
        </label>
        {agent?.needsSync ? <p className="setting-state">Changes need to be synchronized.</p> : null}
      </div>;
    })}
    <div className="settings-form-actions">
      <button type="button" className={`secondary agent-sync${needsSync ? " dirty" : ""}`}
        aria-label="Sync Agent integrations" disabled={busy || !anyEnabled} onClick={() => void sync()}>
        <RefreshCw size={16} aria-hidden="true" /> Sync Agent integrations
      </button>
    </div>
    {notice === undefined ? null : <p className="agent-notice" role="status">{notice}</p>}
    {warnings.length === 0 ? null : <ul className="agent-warnings" aria-label="Agent integration warnings">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
  </section>;
}
