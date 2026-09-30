import { useEffect, useRef, useState } from "react";
import {
  LoaderCircle,
  Moon,
  Play,
  RefreshCw,
  Square,
  Star,
  Sun,
  Wifi,
  X,
} from "lucide-react";

import type {
  DesktopBackendState,
  TokenDesktopApi,
  RuntimeCommand,
  StatusSnapshot,
} from "../../shared/desktop-api.js";
import { OverviewPage } from "../overview/OverviewPage.js";
import { ProvidersPage } from "../providers/ProvidersPage.js";
import { SettingsPage } from "../settings/SettingsPage.js";
import { AgentIntegrationIcon } from "../settings/AgentIntegrationIcon.js";
import { useAgentIntegrations } from "../settings/useAgentIntegrations.js";
import { productPages as pages, type ProductPage } from "./navigation.js";

export interface AppProps {
  readonly api: TokenDesktopApi;
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
  const [favoriteModelsOpen, setFavoriteModelsOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return window.localStorage.getItem("token.desktop.theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [backendState, setBackendState] = useState<DesktopBackendState>();
  const [runtimePending, setRuntimePending] = useState(false);
  const [publicModels, setPublicModels] = useState<Awaited<
    ReturnType<TokenDesktopApi["control"]["executePublicModels"]>
  >>();
  const [editingPort, setEditingPort] = useState(false);
  const [portDraft, setPortDraft] = useState("");
  const latestRevision = useRef(-1);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [theme]);

  const toggleTheme = (): void => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try { window.localStorage.setItem("token.desktop.theme", next); } catch { /* Storage may be unavailable. */ }
  };

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
  const activeRequests = status?.activeRequests;
  const favoriteModelCount = publicModels?.state.providers.reduce(
    (count, provider) => count + provider.models.filter((model) =>
      model.favorite && model.alias?.startsWith(`${provider.providerId}/`)
    ).length,
    0,
  ) ?? 0;
  const agentIntegrations = useAgentIntegrations(api, backendAvailable, publicModels?.state.revision);
  const claudeIntegration = agentIntegrations.state?.agents.find((agent) => agent.agentId === "claude");
  const claudeDesktopIntegration = agentIntegrations.state?.agents.find((agent) => agent.agentId === "claude-desktop");
  const codexIntegration = agentIntegrations.state?.agents.find((agent) => agent.agentId === "codex");
  const piIntegration = agentIntegrations.state?.agents.find((agent) => agent.agentId === "pi");
  const dshIntegration = agentIntegrations.state?.agents.find((agent) => agent.agentId === "dsh");
  const anyAgentEnabled = agentIntegrations.state?.agents.some((agent) => agent.enabled) ?? false;
  const agentSyncNeeded = agentIntegrations.state?.agents.some((agent) => agent.enabled && agent.needsSync) ?? false;

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
  };

  const commitPort = (): void => {
    const value = Number(portDraft);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) return;
    setEditingPort(false);
    void setPort(value);
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
            onClick={() => { setFavoriteModelsOpen(false); setPage(entry.id); }}
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
          <div className="toolbar-group agent-integration-toolbar" role="group" aria-label="Agent integrations">
            {agentIntegrations.isToolbarVisible("claude") ? <button type="button" className={`agent-toolbar-button${claudeIntegration?.enabled ? " on" : ""}`}
              aria-label={`${claudeIntegration?.enabled ? "Disable" : "Enable"} Claude Code integration`}
              aria-pressed={claudeIntegration?.enabled ?? false}
              aria-busy={agentIntegrations.busy}
              title={`Claude Code: ${claudeIntegration === undefined ? "Unavailable" : claudeIntegration.enabled ? "On" : "Off"}`}
              disabled={agentIntegrations.busy || claudeIntegration === undefined}
              onClick={() => void agentIntegrations.toggle("claude")}>
              <AgentIntegrationIcon agentId="claude" />
            </button> : null}
            {agentIntegrations.isToolbarVisible("claude-desktop") ? <button type="button" className={`agent-toolbar-button agent-claude-desktop${claudeDesktopIntegration?.enabled ? " on" : ""}`}
              aria-label={`${claudeDesktopIntegration?.enabled ? "Disable" : "Enable"} Claude Desktop integration`}
              aria-pressed={claudeDesktopIntegration?.enabled ?? false}
              aria-busy={agentIntegrations.busy}
              title={`Claude Desktop: ${claudeDesktopIntegration === undefined ? "Unavailable" : claudeDesktopIntegration.enabled ? "On" : "Off"}`}
              disabled={agentIntegrations.busy || claudeDesktopIntegration === undefined}
              onClick={() => void agentIntegrations.toggle("claude-desktop")}>
              <AgentIntegrationIcon agentId="claude-desktop" />
            </button> : null}
            {agentIntegrations.isToolbarVisible("codex") ? <button type="button" className={`agent-toolbar-button${codexIntegration?.enabled ? " on" : ""}`}
              aria-label={`${codexIntegration?.enabled ? "Disable" : "Enable"} Codex integration`}
              aria-pressed={codexIntegration?.enabled ?? false}
              aria-busy={agentIntegrations.busy}
              title={`Codex: ${codexIntegration === undefined ? "Unavailable" : codexIntegration.enabled ? "On" : "Off"}`}
              disabled={agentIntegrations.busy || codexIntegration === undefined}
              onClick={() => void agentIntegrations.toggle("codex")}>
              <AgentIntegrationIcon agentId="codex" />
            </button> : null}
            {agentIntegrations.isToolbarVisible("pi") ? <button type="button" className={`agent-toolbar-button agent-pi${piIntegration?.enabled ? " on" : ""}`}
              aria-label={`${piIntegration?.enabled ? "Disable" : "Enable"} Pi integration`}
              aria-pressed={piIntegration?.enabled ?? false}
              aria-busy={agentIntegrations.busy}
              title={`Pi: ${piIntegration === undefined ? "Unavailable" : piIntegration.enabled ? "On" : "Off"}`}
              disabled={agentIntegrations.busy || piIntegration === undefined}
              onClick={() => void agentIntegrations.toggle("pi")}>
              <AgentIntegrationIcon agentId="pi" />
            </button> : null}
            {agentIntegrations.isToolbarVisible("dsh") ? <button type="button" className={`agent-toolbar-button agent-dsh${dshIntegration?.enabled ? " on" : ""}`}
              aria-label={`${dshIntegration?.enabled ? "Disable" : "Enable"} DeepSeek Harness integration`}
              aria-pressed={dshIntegration?.enabled ?? false}
              aria-busy={agentIntegrations.busy}
              title={`DeepSeek Harness: ${dshIntegration === undefined ? "Unavailable" : dshIntegration.enabled ? "On" : "Off"}`}
              disabled={agentIntegrations.busy || dshIntegration === undefined}
              onClick={() => void agentIntegrations.toggle("dsh")}>
              <AgentIntegrationIcon agentId="dsh" />
            </button> : null}
            <button type="button" className={`agent-toolbar-button agent-toolbar-sync${agentSyncNeeded ? " dirty" : ""}`}
              aria-label="Sync Agent integrations" aria-busy={agentIntegrations.busy}
              title="Sync Agent integrations" disabled={agentIntegrations.busy || !anyAgentEnabled}
              onClick={() => void agentIntegrations.sync()}>
              <RefreshCw size={16} strokeWidth={1.9} aria-hidden="true" />
            </button>
          </div>
          <div className="toolbar-group favorite-models-toolbar">
            <button
              type="button"
              className={`favorite-models-toolbar-button${favoriteModelCount > 0 ? " has-favorites" : ""}${favoriteModelsOpen ? " active" : ""}`}
              aria-label={`Favorite models${favoriteModelCount === 0 ? "" : ` (${favoriteModelCount})`}`}
              title="Favorite models"
              aria-haspopup="dialog"
              aria-expanded={favoriteModelsOpen}
              onClick={() => setFavoriteModelsOpen((current) => !current)}
            >
              <Star size={18} fill={favoriteModelCount > 0 ? "currentColor" : "none"} aria-hidden="true" />
              {favoriteModelCount === 0 ? null : (
                <span className="provider-favorite-model-count" aria-hidden="true">{favoriteModelCount}</span>
              )}
            </button>
          </div>
          <div className="toolbar-group endpoint-group">
            {editingPort && endpoint !== undefined ? (
              <div className="runtime-endpoint-editor">
                <Wifi size={17} strokeWidth={1.9} aria-hidden="true" />
                <span>{endpoint.host}:</span>
                <input
                  aria-label="Token port"
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
                aria-label="Edit Token port"
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

          <span
            className="toolbar-group runtime-state"
            title={`Token is ${runtimeLabel(status).toLowerCase()}`}
            aria-label={`Token is ${runtimeLabel(status).toLowerCase()}`}
          >
            <span
              className={`runtime-state-dot ${status?.modelDataPlane ?? "unavailable"}`}
              aria-hidden="true"
            />
          </span>

          <span className="toolbar-group runtime-active" title={activeRequests === undefined ? "Active requests unavailable" : `${activeRequests} active requests`} aria-label={activeRequests === undefined ? "Active requests unavailable" : `${activeRequests} active requests`}>
            <strong className="active-request-count">{activeRequests ?? "-"}</strong>
          </span>

          <button
            className={`toolbar-group runtime-toggle ${action ?? "unavailable"}`}
            type="button"
            disabled={action === undefined || runtimePending}
            onClick={() => void executeRuntime()}
            aria-label={runtimePending
              ? action === "stop" ? "Stopping Token" : "Starting Token"
              : action === "stop" ? "Stop Token" : "Start Token"}
            title={action === "stop" ? "Stop Token" : "Start Token"}
          >
            {runtimePending ? (
              <LoaderCircle className="spinning" size={19} strokeWidth={2} aria-hidden="true" />
            ) : action === "stop" ? (
              <Square size={18} fill="currentColor" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <Play size={19} fill="currentColor" strokeWidth={1.8} aria-hidden="true" />
            )}
          </button>
          <button
            className="toolbar-group theme-toggle"
            type="button"
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            title={`${theme === "light" ? "Dark" : "Light"} theme`}
            onClick={toggleTheme}
          >
            {theme === "light" ? <Moon size={17} strokeWidth={1.9} aria-hidden="true" /> : <Sun size={17} strokeWidth={1.9} aria-hidden="true" />}
          </button>
        </div>
      </header>

      <main className="product-content">
        {agentIntegrations.notice === undefined ? null : (
          <div className="agent-notice dismissible-notice" role="status">
            <span>{agentIntegrations.notice}</span>
            <button type="button" className="notice-dismiss" aria-label="Dismiss Agent notification" title="Dismiss" onClick={agentIntegrations.dismissNotice}><X size={16} aria-hidden="true" /></button>
          </div>
        )}
        {agentIntegrations.warnings.length === 0 ? null : (
          <div className="agent-warnings dismissible-notice">
            <ul aria-label="Agent integration warnings">{agentIntegrations.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            <button type="button" className="notice-dismiss" aria-label="Dismiss Agent warnings" title="Dismiss" onClick={agentIntegrations.dismissWarnings}><X size={16} aria-hidden="true" /></button>
          </div>
        )}
        {page === "overview" ? (
          <OverviewPage api={api} backendAvailable={backendAvailable} />
        ) : page === "providers" ? (
          <ProvidersPage api={api} showFavoriteModels={favoriteModelsOpen} onCloseFavoriteModels={() => setFavoriteModelsOpen(false)} onPublicModelsChange={setPublicModels} />
        ) : (
          <SettingsPage api={api} agentIntegrations={agentIntegrations} />
        )}
        {favoriteModelsOpen && page !== "providers" ? (
          <ProvidersPage api={api} view="favorites" onCloseFavoriteModels={() => setFavoriteModelsOpen(false)} onPublicModelsChange={setPublicModels} />
        ) : null}
      </main>
    </div>
  );
}
