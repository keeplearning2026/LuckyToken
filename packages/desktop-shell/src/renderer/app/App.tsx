import { useEffect, useRef, useState } from "react";
import {
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
  Wifi,
} from "lucide-react";

import type {
  AgentIntegrationId,
  AgentInjectionScope,
  DesktopBackendState,
  TokenDesktopApi,
  RuntimeCommand,
  StatusSnapshot,
} from "../../shared/desktop-api.js";
import { OverviewPage } from "../overview/OverviewPage.js";
import { ProvidersPage } from "../providers/ProvidersPage.js";
import { SettingsPage } from "../settings/SettingsPage.js";
import { productPages as pages, type ProductPage } from "./navigation.js";
import codexMark from "../assets/codex.png";

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
  const [backendState, setBackendState] = useState<DesktopBackendState>();
  const [runtimePending, setRuntimePending] = useState(false);
  const [publicModels, setPublicModels] = useState<Awaited<
    ReturnType<TokenDesktopApi["control"]["executePublicModels"]>
  >>();
  const [agentIntegrations, setAgentIntegrations] = useState<
    Awaited<ReturnType<TokenDesktopApi["control"]["executeAgentIntegrations"]>>["state"]
  >();
  const [editingPort, setEditingPort] = useState(false);
  const [portDraft, setPortDraft] = useState("");
  const [agentsPending, setAgentsPending] = useState(false);
  const [agentNotice, setAgentNotice] = useState<string>();
  const [agentWarnings, setAgentWarnings] = useState<readonly string[]>([]);
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
      void api.control.executeAgentIntegrations({ command: "query" }).then(
        (result) => {
          if (!active) return;
          setAgentIntegrations(result.state);
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
    const integrationsResult = await api.control
      .executeAgentIntegrations({ command: "query" })
      .catch(() => undefined);
    if (integrationsResult !== undefined) {
      setAgentIntegrations(integrationsResult.state);
    }
  };

  const commitPort = (): void => {
    const value = Number(portDraft);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) return;
    setEditingPort(false);
    void setPort(value);
  };

  const showAgentResult = (
    result: Awaited<
      ReturnType<TokenDesktopApi["control"]["executeAgentIntegrations"]>
    >,
  ): void => {
    setAgentIntegrations(result.state);
    const effects = result.results.flatMap((entry) =>
      entry.effect === undefined ? [] : [entry.effect],
    );
    setAgentWarnings([...new Set(effects.flatMap((effect) => effect.warnings))]);
    const messages = effects.flatMap((effect) =>
      effect.message === undefined ? [] : [effect.message],
    );
    setAgentNotice(
      messages.length > 0
        ? messages.join(" ")
        : result.outcome === "partial"
          ? "Some Agent integrations could not be synchronized. Successful Agents were kept."
          : result.outcome === "failed"
            ? "Agent integration update failed. Existing Agent files were preserved."
            : undefined,
    );
  };

  const toggleAgent = async (agentId: AgentIntegrationId): Promise<void> => {
    if (agentsPending) return;
    const current = agentIntegrations?.agents.find((agent) => agent.agentId === agentId);
    if (current === undefined) return;
    const enabling = !current.enabled;
    setAgentsPending(true);
    try {
      const result = await api.control.executeAgentIntegrations({
        command: "set_enabled",
        agentId,
        enabled: enabling,
      });
      showAgentResult(result);
    } catch {
      setAgentNotice(
        `${agentId === "codex" ? "Codex" : "Pi"} integration update failed. Existing Agent files were preserved.`,
      );
    } finally {
      setAgentsPending(false);
    }
  };

  const setAgentScope = async (
    agentId: AgentIntegrationId,
    scope: AgentInjectionScope,
  ): Promise<void> => {
    if (agentsPending) return;
    setAgentsPending(true);
    try {
      showAgentResult(
        await api.control.executeAgentIntegrations({
          command: "set_scope",
          agentId,
          scope,
        }),
      );
    } catch {
      setAgentNotice("The Agent injection scope could not be saved.");
    } finally {
      setAgentsPending(false);
    }
  };

  const syncAgents = async (): Promise<void> => {
    if (agentsPending) return;
    setAgentsPending(true);
    try {
      showAgentResult(
        await api.control.executeAgentIntegrations({ command: "sync" }),
      );
    } catch {
      setAgentNotice("Agent synchronization failed. Existing Agent files were preserved.");
    } finally {
      setAgentsPending(false);
    }
  };

  const action = runtimeAction(status);
  const pageTitle = pages.find((entry) => entry.id === page)?.label ?? page;
  const endpoint = publicModels?.state.endpoint;
  const endpointText = endpoint === undefined
    ? status?.dataPlane?.configuredOrigin?.replace(/^https?:\/\//u, "") ?? "-"
    : `${endpoint.host}:${endpoint.port}`;
  const codex = agentIntegrations?.agents.find((agent) => agent.agentId === "codex");
  const pi = agentIntegrations?.agents.find((agent) => agent.agentId === "pi");
  const anyAgentEnabled = agentIntegrations?.agents.some((agent) => agent.enabled) ?? false;
  const anyAgentDirty = agentIntegrations?.agents.some(
    (agent) => agent.enabled && agent.needsSync,
  ) ?? false;

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

          <div className="toolbar-group agent-controls" aria-label="Agent integration controls">
            <button
              type="button"
              className={`agent-icon-button${codex?.enabled ? " active" : ""}`}
              aria-label={codex?.enabled ? "Disable Codex integration" : "Enable Codex integration"}
              aria-pressed={codex?.enabled ?? false}
              disabled={agentsPending || codex === undefined}
              onClick={() => void toggleAgent("codex")}
              title={codex?.enabled ? "Disable Codex integration" : "Enable Codex integration"}
            >
              <img className="codex-mark" src={codexMark} alt="" aria-hidden="true" />
            </button>
            <select
              className="agent-scope-select"
              aria-label="Codex injection scope"
              value={codex?.scope ?? "favorite"}
              disabled={agentsPending || codex === undefined}
              onChange={(event) =>
                void setAgentScope(
                  "codex",
                  event.currentTarget.value as AgentInjectionScope,
                )}
            >
              <option value="favorite">Favorite</option>
              <option value="full">Full</option>
            </select>
            <button
              type="button"
              className={`agent-icon-button pi-mark${pi?.enabled ? " active" : ""}`}
              aria-label={pi?.enabled ? "Disable Pi integration" : "Enable Pi integration"}
              aria-pressed={pi?.enabled ?? false}
              disabled={agentsPending || pi === undefined}
              onClick={() => void toggleAgent("pi")}
              title={pi?.enabled ? "Disable Pi integration" : "Enable Pi integration"}
            >
              <span aria-hidden="true">π</span>
            </button>
            <select
              className="agent-scope-select"
              aria-label="Pi injection scope"
              value={pi?.scope ?? "favorite"}
              disabled={agentsPending || pi === undefined}
              onChange={(event) =>
                void setAgentScope(
                  "pi",
                  event.currentTarget.value as AgentInjectionScope,
                )}
            >
              <option value="favorite">Favorite</option>
              <option value="full">Full</option>
            </select>
            <button
              type="button"
              className={`toolbar-icon-button agent-sync${anyAgentDirty ? " dirty" : ""}`}
              aria-label="Sync Agent integrations"
              disabled={agentsPending || !anyAgentEnabled}
              onClick={() => void syncAgents()}
              title={anyAgentDirty ? "Sync Agent changes" : "Enabled Agents are synchronized"}
            >
              <RefreshCw size={18} strokeWidth={1.8} aria-hidden="true" />
              {anyAgentDirty ? <span className="sync-needed" aria-hidden="true" /> : null}
            </button>
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
        </div>
      </header>

      <main className="product-content">
        {agentNotice === undefined ? null : (
          <div className="agent-notice" role="status" aria-live="polite">
            {agentNotice}
          </div>
        )}
        {agentWarnings.length === 0 ? null : (
          <ul className="agent-warnings" aria-label="Agent integration warnings">
            {agentWarnings.map((warning) => (
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
