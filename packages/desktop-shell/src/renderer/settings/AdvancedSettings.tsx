import { useState, type KeyboardEvent } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { AgentIntegrationSettings } from "./AgentIntegrationSettings.js";
import { ProtocolSettings } from "./ProtocolSettings.js";
import { ProviderNativeRewriteSettings } from "./ProviderNativeRewriteSettings.js";
import type { AgentIntegrationControls } from "./useAgentIntegrations.js";

type AdvancedGroup = "protocols" | "agents";

export function AdvancedSettings({ api, agentIntegrations }: { readonly api: TokenDesktopApi; readonly agentIntegrations: AgentIntegrationControls }) {
  const [group, setGroup] = useState<AdvancedGroup>("protocols");
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: AdvancedGroup): void => {
    const next = event.key === "Home" ? "protocols"
      : event.key === "End" ? "agents"
        : event.key === "ArrowRight" || event.key === "ArrowLeft"
          ? current === "protocols" ? "agents" : "protocols" : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setGroup(next);
    document.getElementById(`advanced-tab-${next}`)?.focus();
  };
  return <section className="page-stack">
    <div className="settings-subtabs" role="tablist" aria-label="Advanced settings sections">
      {(["protocols", "agents"] as const).map((entry) => <button key={entry} type="button"
        id={`advanced-tab-${entry}`} role="tab" aria-selected={group === entry}
        aria-controls={`advanced-panel-${entry}`} tabIndex={group === entry ? 0 : -1}
        className={group === entry ? "active" : undefined} onClick={() => setGroup(entry)}
        onKeyDown={(event) => handleTabKey(event, entry)}>
        {entry === "protocols" ? "Protocols" : "Agents"}
      </button>)}
    </div>
    <div id={`advanced-panel-${group}`} role="tabpanel" aria-labelledby={`advanced-tab-${group}`} className="page-stack">
      {group === "protocols" ? <><ProtocolSettings api={api} protocol="responses" /><ProviderNativeRewriteSettings api={api} /><ProtocolSettings api={api} protocol="anthropic" /></>
        : <AgentIntegrationSettings api={api} controls={agentIntegrations} />}
    </div>
  </section>;
}
