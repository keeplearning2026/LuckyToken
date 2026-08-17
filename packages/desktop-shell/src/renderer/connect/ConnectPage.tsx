import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";
import type { ProductPage } from "../app/navigation.js";

type Status = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["getStatus"]>>;
type CodexState = Awaited<
  ReturnType<LuckyTokenDesktopApi["control"]["executeCodexIntegration"]>
>["state"];

function isCodexReady(state: CodexState): boolean {
  return (
    state.desiredEnabled &&
    state.observedState === "managed" &&
    state.endpoint !== undefined &&
    (state.modelCount ?? 0) > 0
  );
}

export function ConnectPage({
  api,
  navigate,
}: {
  readonly api: LuckyTokenDesktopApi;
  readonly navigate: (page: ProductPage) => void;
}) {
  const [status, setStatus] = useState<Status>();
  const [codex, setCodex] = useState<CodexState>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const verify = async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const [nextStatus, integration] = await Promise.all([
        api.control.getStatus(),
        api.control.executeCodexIntegration({ command: "query" }),
      ]);
      setStatus(nextStatus);
      setCodex(integration.state);
    } catch {
      setNotice("LuckyToken could not verify the client integration. Try again.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void verify();
  }, [api]);

  const configureCodex = async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const enabled = await api.control.executeCodexIntegration({
        command: "set_enabled",
        enabled: true,
      });
      setCodex(enabled.state);
      if (
        enabled.state.desiredEnabled &&
        enabled.state.observedState === "managed"
      ) {
        const synchronized = await api.control.executeCodexIntegration({
          command: "sync_catalog",
        });
        setCodex(synchronized.state);
      }
    } catch {
      setNotice("LuckyToken could not configure Codex. Fix the reported issue and retry.");
    } finally {
      setBusy(false);
    }
  };

  if (status === undefined || codex === undefined) {
    return (
      <section className="page-card">
        <p>{notice ?? "Checking client integrations…"}</p>
        {notice === undefined ? null : (
          <button type="button" onClick={() => void verify()}>Verify again</button>
        )}
      </section>
    );
  }

  if (status.provider === "unconfigured") {
    return (
      <section className="page-card connect-prerequisite">
        <p className="eyebrow">PREREQUISITE</p>
        <h2>Connect a provider first</h2>
        <p>LuckyToken needs one usable AI provider before it can configure a coding client.</p>
        <button type="button" onClick={() => navigate("providers")}>Open Providers</button>
      </section>
    );
  }

  const ready = isCodexReady(codex);
  const blocked = codex.observedState === "conflict" || codex.observedState === "drifted";
  const unavailable = codex.observedState === "unavailable";

  return (
    <section className="page-stack">
      <div className="page-card section-heading">
        <div>
          <p className="eyebrow">CLIENT INTEGRATIONS</p>
          <h2>Connect</h2>
          <p>Configure supported coding clients without managing tokens and routing files by hand.</p>
        </div>
        <button type="button" className="secondary" disabled={busy} onClick={() => void verify()}>
          {busy ? "Verifying…" : "Verify again"}
        </button>
      </div>

      {notice === undefined ? null : <p className="product-notice" role="status">{notice}</p>}

      <article className="page-card integration-card">
        <div className="provider-title">
          <div>
            <h3>Codex</h3>
            <p>OpenAI Responses through LuckyToken</p>
          </div>
          <span className={`badge ${ready ? "good" : blocked || unavailable ? "warning" : "neutral"}`}>
            {ready ? "Ready" : blocked ? "Needs review" : unavailable ? "Unavailable" : "Not configured"}
          </span>
        </div>

        {ready ? (
          <>
            <h4>Codex is ready</h4>
            <p>{codex.modelCount} model{codex.modelCount === 1 ? "" : "s"} available through LuckyToken.</p>
            {codex.restartRequired ? <p className="product-notice">Restart Codex to apply the updated integration.</p> : null}
          </>
        ) : (
          <>
            <p>{codex.message ?? "LuckyToken can configure Codex automatically."}</p>
            <button type="button" disabled={busy} onClick={() => void configureCodex()}>
              {busy ? "Configuring…" : "Configure Codex"}
            </button>
          </>
        )}

        {codex.warnings.length === 0 ? null : (
          <ul className="warning-list">
            {codex.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        )}
      </article>

      <article className="page-card integration-card muted-card">
        <div className="provider-title">
          <div>
            <h3>Claude Code</h3>
            <p>Anthropic Messages through LuckyToken</p>
          </div>
          <span className="badge neutral">Supported</span>
        </div>
        <p>LuckyToken already exposes the Anthropic-compatible Data Plane. Guided client configuration will use the same typed integration seam.</p>
      </article>
    </section>
  );
}
