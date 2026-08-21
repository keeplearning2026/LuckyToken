import { useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";
import { AdvancedSettings } from "./AdvancedSettings.js";
import { DataSettings } from "./DataSettings.js";
import { GeneralSettings } from "./GeneralSettings.js";

type SettingsSection = "general" | "data" | "advanced";

const sections: ReadonlyArray<Readonly<{ id: SettingsSection; label: string }>> = Object.freeze([
  { id: "general", label: "General" },
  { id: "data", label: "Data" },
  { id: "advanced", label: "Advanced" },
]);

export function SettingsPage({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [section, setSection] = useState<SettingsSection>("general");

  return (
    <section className="page-stack">
      <div className="page-card section-heading settings-heading">
        <div>
          <p className="eyebrow">PRODUCT CONFIGURATION</p>
          <h2>Settings</h2>
          <p>Change product behavior through the authority that owns each fact.</p>
        </div>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {sections.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={section === entry.id}
            className={section === entry.id ? "active" : undefined}
            onClick={() => setSection(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {section === "general" ? (
        <GeneralSettings api={api} />
      ) : section === "data" ? (
        <DataSettings api={api} />
      ) : (
        <AdvancedSettings api={api} />
      )}
    </section>
  );
}
