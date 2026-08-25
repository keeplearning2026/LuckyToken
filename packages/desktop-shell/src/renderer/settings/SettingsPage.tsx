import { useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { AdvancedSettings } from "./AdvancedSettings.js";
import { DataSettings } from "./DataSettings.js";
import { GeneralSettings } from "./GeneralSettings.js";

type SettingsSection = "general" | "data" | "advanced";

const sections: ReadonlyArray<Readonly<{
  id: SettingsSection;
  label: string;
  description: string;
}>> = Object.freeze([
  { id: "general", label: "General", description: "Startup behavior" },
  { id: "data", label: "Data & privacy", description: "History and backups" },
  { id: "advanced", label: "Advanced", description: "Codex and diagnostics" },
]);

export function SettingsPage({ api }: { readonly api: TokenDesktopApi }) {
  const [section, setSection] = useState<SettingsSection>("general");

  return (
    <section className="page-stack settings-page">
      <p className="settings-lead">
        Manage startup, stored data, and advanced Codex behavior.
      </p>
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
          >
            <strong>{entry.label}</strong>
            <span>{entry.description}</span>
          </button>
        ))}
      </div>
      <div
        className="settings-panel"
        id={`settings-panel-${section}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
      >
        {section === "general" ? (
          <GeneralSettings api={api} />
        ) : section === "data" ? (
          <DataSettings api={api} />
        ) : (
          <AdvancedSettings api={api} />
        )}
      </div>
    </section>
  );
}
