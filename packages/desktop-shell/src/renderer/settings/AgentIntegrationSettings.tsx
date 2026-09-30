import { RefreshCw } from "lucide-react";

import type { AgentInjectionScope } from "../../shared/desktop-api.js";
import { AgentIntegrationIcon } from "./AgentIntegrationIcon.js";
import { AGENT_INTEGRATION_IDS, type AgentIntegrationControls } from "./useAgentIntegrations.js";

export function AgentIntegrationSettings({ controls }: { readonly controls: AgentIntegrationControls }) {
  const { state, busy, toggle, setScope, sync, isToolbarVisible, setToolbarVisible } = controls;

  const anyEnabled = state?.agents.some((agent) => agent.enabled) ?? false;
  const needsSync = state?.agents.some((agent) => agent.enabled && agent.needsSync) ?? false;

  return <section className="page-stack" aria-label="Agent integrations">
    {AGENT_INTEGRATION_IDS.map((agentId) => {
      const agent = state?.agents.find((entry) => entry.agentId === agentId);
      const label = agentId === "claude" ? "Claude Code" : agentId === "claude-desktop" ? "Claude Desktop" : agentId === "codex" ? "Codex" : agentId === "pi" ? "Pi" : "DeepSeek Harness";
      const integrationStatus = agent === undefined ? "Unavailable" : agent.enabled ? "On" : "Off";
      return <div className="page-card settings-section" key={agentId}>
        <header className="settings-section-header">
          <div className="settings-agent-heading">
            <span className={`agent-integration-indicator${agentId === "pi" ? " agent-pi" : ""}${agent?.enabled ? " on" : ""}`}
              role="img" aria-label={`${label} integration: ${integrationStatus}`} title={`${label}: ${integrationStatus}`}>
              <AgentIntegrationIcon agentId={agentId} />
            </span>
            <div className="settings-copy"><p className="eyebrow">AGENT INTEGRATION</p><h3>{label}</h3></div>
          </div>
          <span className={`settings-status ${agent?.enabled ? "on" : "off"}`}>{integrationStatus}</span>
        </header>
        <label className="settings-action-row">
          <span className="settings-action-copy"><strong>Show in toolbar</strong></span>
          <input type="checkbox" aria-label={`Show ${label} in toolbar`}
            checked={isToolbarVisible(agentId)}
            onChange={(event) => setToolbarVisible(agentId, event.currentTarget.checked)} />
        </label>
        <div className="settings-action-row">
          <div className="settings-action-copy"><strong>Inject Token models</strong></div>
          <button type="button" className={`switch-control${agent?.enabled ? " on" : ""}`}
            aria-label={`${agent?.enabled ? "Disable" : "Enable"} ${label} integration`}
            aria-pressed={agent?.enabled ?? false} aria-busy={busy} disabled={busy || agent === undefined}
            onClick={() => void toggle(agentId)}><span aria-hidden="true" /></button>
        </div>
        {agentId === "claude" ? (
          <p className="setting-state">Claude Code model slots are selected from Favorite models below.</p>
        ) : (
          <label className="field-row">
            <span>Models to inject</span>
            <select aria-label={`${label} injection scope`} value={agent?.scope ?? "favorite"}
              disabled={busy || agent === undefined}
              onChange={(event) => void setScope(agentId, event.currentTarget.value as AgentInjectionScope)}>
              <option value="favorite">Favorite models</option>
              <option value="full">All models</option>
            </select>
          </label>
        )}
        {agent?.needsSync ? <p className="setting-state">Changes need to be synchronized.</p> : null}
      </div>;
    })}
    <div className="settings-form-actions">
      <button type="button" className={`secondary agent-sync${needsSync ? " dirty" : ""}`}
        aria-label="Sync Agent integrations" disabled={busy || !anyEnabled} onClick={() => void sync()}>
        <RefreshCw size={16} aria-hidden="true" /> Sync
      </button>
    </div>
  </section>;
}
