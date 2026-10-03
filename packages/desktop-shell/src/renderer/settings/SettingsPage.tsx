import { useState, type KeyboardEvent } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { AdvancedSettings } from "./AdvancedSettings.js";
import { DataSettings } from "./DataSettings.js";
import { GeneralSettings } from "./GeneralSettings.js";
import { LocalLoginSettings } from "./LocalLoginSettings.js";
import { ProviderUsageSettings } from "./ProviderUsageSettings.js";
import type { AgentIntegrationControls } from "./useAgentIntegrations.js";

type SettingsSection = "general" | "diagnostics" | "advanced";

const sections: ReadonlyArray<Readonly<{
  id: SettingsSection;
  label: string;
}>> = Object.freeze([
  { id: "general", label: "General" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "advanced", label: "Advanced" },
]);

export function SettingsPage({ api, agentIntegrations }: { readonly api: TokenDesktopApi; readonly agentIntegrations: AgentIntegrationControls }) {
  const [section, setSection] = useState<SettingsSection>("general");

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: SettingsSection): void => {
    const index = sections.findIndex((entry) => entry.id === current);
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % sections.length
      : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length
        : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = sections[nextIndex]?.id;
    if (next === undefined) return;
    setSection(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  };

  return (
    <section className="page-stack settings-page">
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {sections.map((entry) => (
          <button
            key={entry.id}
            id={`settings-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={section === entry.id}
            aria-controls={`settings-panel-${entry.id}`}
            tabIndex={section === entry.id ? 0 : -1}
            className={section === entry.id ? "active" : undefined}
            onClick={() => setSection(entry.id)}
            onKeyDown={(event) => handleTabKey(event, entry.id)}
          >
            <strong>{entry.label}</strong>
          </button>
        ))}
      </div>
      <div
        className={`settings-panel${section === "general" ? " settings-general" : ""}`}
        id={`settings-panel-${section}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
      >
        {section === "general" ? (
          <>
            <GeneralSettings api={api} />
            <LocalLoginSettings api={api} />
            <ProviderUsageSettings api={api} />
          </>
        ) : section === "diagnostics" ? (
          <DataSettings api={api} />
        ) : (
          <AdvancedSettings api={api} agentIntegrations={agentIntegrations} />
        )}
      </div>
    </section>
  );
}
