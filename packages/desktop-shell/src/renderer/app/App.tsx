import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ChartNoAxesColumnIncreasing,
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
  Wifi,
} from "lucide-react";

import type {
  DesktopBackendState,
  LuckyTokenDesktopApi,
  RuntimeCommand,
  StatusSnapshot,
} from "../../shared/desktop-api.js";
import { OverviewPage } from "../overview/OverviewPage.js";
import { ProvidersPage } from "../providers/ProvidersPage.js";
import { SettingsPage } from "../settings/SettingsPage.js";
import { productPages as pages, type ProductPage } from "./navigation.js";
import { useActiveRequests } from "./useActiveRequests.js";
import codexMark from "../assets/codex.png";

export interface AppProps {
  readonly api: LuckyTokenDesktopApi;
}

function runtimeLabel(status: StatusSnapshot | undefined): string {
  if (status === undefined) return "Unavailable";
  switch (status.modelDataPlane) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Attention";
  }
}

function runtimeAction(status: StatusSnapshot | undefined): RuntimeCommand | undefined {
  if (status === undefined) return undefined;
  if (status.modelDataPlane === "starting" || status.modelDataPlane === "stopping") {
    return undefined;
  }
  return status.modelDataPlane === "running" ? "stop" : "start";
}

export function App({ api }: AppProps) {
  const [page, setPage] = useState<ProductPage>("overview");
  const [backendState, setBackendState] = useState<DesktopBackendState>();
  const [runtimePending, setRuntimePending] = useState(false);
  const [publicModels, setPublicModels] = useState<Awaited<
    ReturnType<LuckyTokenDesktopApi["control"]["executePublicModels"]>
  >>();
  const [codex, setCodex] = useState<
    Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeCodexIntegration"]>>["state"]
  >();
  const [editingPort, setEditingPort] = useState(false);
  const [portDraft, setPortDraft] = useState("");
  const [codexPending, setCodexPending] = useState(false);
  const [codexNotice, setCodexNotice] = useState<string>();
  const latestRevision = useRef(-1);

  useEffect(() => {
    let active = true;
    const accept = (next: DesktopBackendState): void => {
      if (!active || next.revision < latestRevision.current) return;
      latestRevision.current = next.revision;
      setBackendState(next);
      if (next.kind !== "ready") return;
      void api.control.executePublicModels({ command: "query" }).then(
        (result) => {
          if (active) setPublicModels(result);
        },
        () => undefined,
      );
      void api.control.executeCodexIntegration({ command: "query" }).then(
        (result) => {
          if (!active) return;
          setCodex(result.state);
          if (result.state.message !== undefined) setCodexNotice(result.state.message);
        },
        () => undefined,
      );
    };
    const unsubscribe = api.control.onBackendState(accept);
    void api.control.getBackendState().then(accept, () => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const status = backendState?.kind === "ready" ? backendState.status : undefined;
  const backendAvailable = backendState?.kind === "ready";
  const activeRequests = useActiveRequests(api, backendAvailable);

  const executeRuntime = async (): Promise<void> => {
    const command = runtimeAction(status);
    if (command === undefined || runtimePending) return;
    setRuntimePending(true);
    try {
      await api.control.executeRuntime(command);
    } finally {
      setRuntimePending(false);
    }
  };

  const setPort = async (port: number): Promise<void> => {
    const state = publicModels?.state;
    if (state === undefined || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return;
    }
    const result = await api.control.executePublicModels({
      command: "set_port",
      revision: state.revision,
      port,
    });
    setPublicModels(result);
    const codexResult = await api.control
      .executeCodexIntegration({ command: "query" })
      .catch(() => undefined);
    if (codexResult !== undefined) {
      setCodex(codexResult.state);
      if (codexResult.state.message !== undefined) setCodexNotice(codexResult.state.message);
    }
  };

  const commitPort = (): void => {
    const value = Number(portDraft);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) return;
    setEditingPort(false);
    void setPort(value);
  };

  const toggleCodex = async (): Promise<void> => {
    if (codexPending) return;
    const enabling = !(codex?.desiredEnabled ?? false);
    setCodexPending(true);
    try {
      const result = await api.control.executeCodexIntegration({
        command: "set_enabled",
        enabled: enabling,
      });
      setCodex(result.state);
      setCodexNotice(
        result.state.restartRequired
          ? enabling
            ? "Codex synced. Restart Codex to load the updated model catalog."
            : "Codex configuration restored. Restart Codex to apply the change."
          : result.state.message,
      );
    } catch {
      setCodexNotice(
        enabling
          ? "Codex sync failed. No Codex files were changed."
          : "Codex configuration could not be restored. The integration remains enabled.",
      );
    } finally {
      setCodexPending(false);
    }
  };

  const syncCodex = async (): Promise<void> => {
    if (codexPending || codex?.desiredEnabled !== true) return;
    setCodexPending(true);
    try {
      const result = await api.control.executeCodexIntegration({ command: "sync" });
      setCodex(result.state);
      setCodexNotice(
        result.state.restartRequired
          ? "Codex synced. Restart Codex to load the updated model catalog."
          : result.state.message,
      );
    } catch {
      setCodexNotice("Codex sync failed. No Codex files were changed.");
    } finally {
      setCodexPending(false);
    }
  };

  const action = runtimeAction(status);
  const pageTitle = pages.find((entry) => entry.id === page)?.label ?? page;
  const endpoint = publicModels?.state.endpoint;
  const endpointText = endpoint === undefined
    ? status?.dataPlane?.configuredOrigin?.replace(/^https?:\/\//u, "") ?? "-"
    : `${endpoint.host}:${endpoint.port}`;

  return (
    <div className="product-shell">
      <nav className="color-nav" aria-label="Product navigation">
        {pages.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-label={entry.label}
            aria-current={page === entry.id ? "page" : undefined}
            className={`color-nav-button ${entry.tone}${page === entry.id ? " active" : ""}`}
            onClick={() => setPage(entry.id)}
            title={entry.label}
          >
            <span className="color-nav-line" aria-hidden="true" />
            <span className="sr-only">{entry.label}</span>
          </button>
        ))}
      </nav>

      <header className="product-header">
        <h1>{pageTitle}</h1>
        <div className="runtime-header-status" aria-label="Router status">
          <div className="toolbar-group endpoint-group">
            {editingPort && endpoint !== undefined ? (
              <div className="runtime-endpoint-editor">
                <Wifi size={17} strokeWidth={1.9} aria-hidden="true" />
                <span>{endpoint.host}:</span>
                <input
                  aria-label="LuckyToken port"
                  inputMode="numeric"
                  value={portDraft}
                  onChange={(event) => setPortDraft(event.currentTarget.value)}
                  onBlur={commitPort}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitPort();
                    if (event.key === "Escape") setEditingPort(false);
                  }}
                  autoFocus
                />
              </div>
            ) : (
              <button
                type="button"
                className="runtime-endpoint runtime-endpoint-button"
                aria-label="Edit LuckyToken port"
                title={endpointText}
                disabled={endpoint === undefined}
                onClick={() => {
                  if (endpoint === undefined) return;
                  setPortDraft(String(endpoint.port));
                  setEditingPort(true);
                }}
              >
                <Wifi size={17} strokeWidth={1.9} aria-hidden="true" />
                {endpointText}
              </button>
            )}
          </div>

          <div className="toolbar-group codex-controls" aria-label="Codex integration controls">
            <img className="codex-mark" src={codexMark} alt="" aria-hidden="true" />
            <button
              type="button"
              role="switch"
              className={`codex-toggle${codex?.desiredEnabled ? " active" : ""}`}
              aria-label={codex?.desiredEnabled ? "Disable Codex integration" : "Enable Codex integration"}
              aria-checked={codex?.desiredEnabled ?? false}
              disabled={codexPending || codex === undefined}
              onClick={() => void toggleCodex()}
              title={codex?.desiredEnabled ? "Disable Codex integration" : "Enable Codex integration"}
            >
              <span className="codex-toggle-thumb" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`toolbar-icon-button codex-sync${codex?.needsSync ? " dirty" : ""}`}
              aria-label="Sync Codex"
              disabled={codexPending || codex?.desiredEnabled !== true}
              onClick={() => void syncCodex()}
              title={codex?.needsSync ? "Sync Codex changes" : "Codex is synchronized"}
            >
              <RefreshCw size={18} strokeWidth={1.8} aria-hidden="true" />
              {codex?.needsSync ? <span className="sync-needed" aria-hidden="true" /> : null}
            </button>
          </div>

          <span className="toolbar-group runtime-state" title={`LuckyToken is ${runtimeLabel(status).toLowerCase()}`}>
            <Activity className={status?.modelDataPlane ?? "unavailable"} size={18} strokeWidth={1.9} aria-hidden="true" />
            {runtimeLabel(status)}
          </span>

          <span className="toolbar-group runtime-active" title={`${activeRequests} active requests`} aria-label={`${activeRequests} active requests`}>
            <ChartNoAxesColumnIncreasing size={18} strokeWidth={1.8} aria-hidden="true" />
            <strong className="active-request-count">{activeRequests}</strong>
          </span>

          <button
            className={`toolbar-group runtime-toggle ${action ?? "unavailable"}`}
            type="button"
            disabled={action === undefined || runtimePending}
            onClick={() => void executeRuntime()}
            aria-label={runtimePending
              ? action === "stop" ? "Stopping LuckyToken" : "Starting LuckyToken"
              : action === "stop" ? "Stop LuckyToken" : "Start LuckyToken"}
            title={action === "stop" ? "Stop LuckyToken" : "Start LuckyToken"}
          >
            {runtimePending ? (
              <LoaderCircle className="spinning" size={19} strokeWidth={2} aria-hidden="true" />
            ) : action === "stop" ? (
              <Square size={18} fill="currentColor" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <Play size={19} fill="currentColor" strokeWidth={1.8} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      <main className="product-content">
        {codexNotice === undefined ? null : (
          <div className="codex-notice" role="status" aria-live="polite">
            {codexNotice}
          </div>
        )}
        {codex === undefined || codex.warnings.length === 0 ? null : (
          <ul className="codex-warnings" aria-label="Codex integration warnings">
            {codex.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        {page === "overview" ? (
          <OverviewPage api={api} backendAvailable={backendAvailable} />
        ) : page === "providers" ? (
          <ProvidersPage api={api} />
        ) : (
          <SettingsPage api={api} />
        )}
      </main>
    </div>
  );
}
