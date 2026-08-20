import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type ModelsResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeModels"]>>;

/** Raw models.json remains an advanced startup configuration surface. Public
 * Provider/model names and switches are owned by the Providers page through
 * PublicModelAuthority and are never editable as raw JSON here. */
export function RoutingSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [models, setModels] = useState<ModelsResult["state"]>();
  const [modelsDraft, setModelsDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void api.control.executeModels({ command: "query" }).then((result) => {
      if (!active) return;
      setModels(result.state);
      setModelsDraft(result.state.raw);
    });
    return () => {
      active = false;
    };
  }, [api]);

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
        setNotice("Models changed elsewhere. Review the current configuration and retry.");
      } else if (result.outcome === "ok") {
        setNotice("Models saved. Restart LuckyToken to apply this configuration.");
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
          <p className="eyebrow">STARTUP MODELS</p>
          <h3>Raw model configuration</h3>
          <p>models.json is read when the Backend starts. Saving this file never changes the currently running Provider Runtime.</p>
        </div>
        <textarea
          aria-label="Raw model configuration"
          rows={12}
          value={modelsDraft}
          onChange={(event) => setModelsDraft(event.currentTarget.value)}
        />
        <button type="button" disabled={busy || models === undefined} onClick={() => void saveModels()}>
          {busy ? "Saving…" : "Save models"}
        </button>
      </div>
    </section>
  );
}
