import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type AliasResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeAliases"]>>;
type ModelsResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeModels"]>>;

export function RoutingSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [aliases, setAliases] = useState<AliasResult["state"]>();
  const [models, setModels] = useState<ModelsResult["state"]>();
  const [aliasDraft, setAliasDraft] = useState("");
  const [modelsDraft, setModelsDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.control.executeAliases({ command: "query" }),
      api.control.executeModels({ command: "query" }),
    ]).then(([aliasResult, modelResult]) => {
      if (!active) return;
      setAliases(aliasResult.state);
      setModels(modelResult.state);
      setAliasDraft(JSON.stringify(aliasResult.state.aliases ?? {}, null, 2));
      setModelsDraft(modelResult.state.raw);
    });
    return () => {
      active = false;
    };
  }, [api]);

  const saveAliases = async (): Promise<void> => {
    if (aliases === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(aliasDraft);
    } catch {
      setNotice("Alias mappings must be valid JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setNotice("Alias mappings must be a JSON object.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.control.executeAliases({
        command: "write",
        revision: aliases.revision,
        aliases: parsed as Readonly<Record<string, unknown>>,
      });
      setAliases(result.state);
      if (result.outcome === "conflict") {
        setNotice("Changed elsewhere. Review the current alias state and retry.");
      } else if (result.outcome === "ok") {
        setNotice("Aliases saved.");
        setAliasDraft(JSON.stringify(result.state.aliases ?? {}, null, 2));
      } else {
        setNotice(result.error?.message ?? "Alias changes were not saved.");
      }
    } finally {
      setBusy(false);
    }
  };

  const saveModels = async (): Promise<void> => {
    if (models === undefined) return;
    setBusy(true);
    try {
      const result = await api.control.executeModels({
        command: "write_raw",
        revision: models.revision,
        content: modelsDraft,
      });
      setModels(result.state);
      if (result.outcome === "conflict") {
        setNotice("Models changed elsewhere. Review the current model configuration and retry.");
      } else if (result.outcome === "ok") {
        setNotice("Models saved.");
        setModelsDraft(result.state.raw);
      } else {
        setNotice(result.error?.message ?? "Model changes were not saved.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page-stack settings-routing">
      {notice === undefined ? null : <p className="product-notice" role="status">{notice}</p>}
      <div className="page-card settings-section">
        <div className="settings-copy">
          <p className="eyebrow">ROUTING</p>
          <h3>Model aliases</h3>
          <p>Aliases are saved with compare-and-swap on the Backend revision. Unsaved edits exist only in this window.</p>
        </div>
        <textarea
          aria-label="Alias mappings"
          rows={9}
          value={aliasDraft}
          onChange={(event) => setAliasDraft(event.currentTarget.value)}
        />
        <button type="button" disabled={busy || aliases === undefined} onClick={() => void saveAliases()}>
          Save aliases
        </button>
      </div>

      <div className="page-card settings-section">
        <div className="settings-copy">
          <p className="eyebrow">ADVANCED ROUTING</p>
          <h3>Raw model configuration</h3>
          <p>The Backend validates the complete proposed models configuration before replacing the active file.</p>
        </div>
        <textarea
          aria-label="Raw model configuration"
          rows={12}
          value={modelsDraft}
          onChange={(event) => setModelsDraft(event.currentTarget.value)}
        />
        <button type="button" disabled={busy || models === undefined} onClick={() => void saveModels()}>
          Save models
        </button>
      </div>
    </section>
  );
}
