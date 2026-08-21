import { useEffect, useRef, useState } from "react";

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

export interface AppProps {
  readonly api: LuckyTokenDesktopApi;
}

function runtimeLabel(status: StatusSnapshot | undefined): string {
  if (status === undefined) return "Router unavailable";
  return `Router ${status.modelDataPlane}`;
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
          if (active) setCodex(result.state);
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
  const readyRevision = backendState?.kind === "ready" ? backendState.revision : undefined;
  const activeRequests = useActiveRequests(api, readyRevision);

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
    if (codexResult !== undefined) setCodex(codexResult.state);
  };

  const commitPort = (): void => {
    const value = Number(portDraft);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) return;
    setEditingPort(false);
    void setPort(value);
  };

  const toggleCodex = async (): Promise<void> => {
    if (codexPending) return;
    setCodexPending(true);
    try {
      const result = await api.control.executeCodexIntegration({
        command: "set_enabled",
        enabled: !(codex?.desiredEnabled ?? false),
      });
      setCodex(result.state);
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
          >
            <span className="color-nav-line" aria-hidden="true" />
            <span className="sr-only">{entry.label}</span>
          </button>
        ))}
      </nav>

      <header className="product-header">
        <h1>{pageTitle}</h1>
        <div className="runtime-header-status" aria-label="Router status">
          <div className="runtime-endpoint-stack">
            {editingPort && endpoint !== undefined ? (
              <div className="runtime-endpoint-editor">
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
                {endpointText}
              </button>
            )}
            <div className="codex-icon-row" aria-label="Codex integration controls">
              <button
                type="button"
                className={`icon-button codex-toggle${codex?.desiredEnabled ? " active" : ""}`}
                aria-label={codex?.desiredEnabled ? "Disable Codex integration" : "Enable Codex integration"}
                aria-pressed={codex?.desiredEnabled ?? false}
                disabled={codexPending || codex === undefined}
                onClick={() => void toggleCodex()}
                title={codex?.desiredEnabled ? "Disable Codex integration" : "Enable Codex integration"}
              >
                <span aria-hidden="true">◇</span>
              </button>
              <button
                type="button"
                className={`icon-button codex-sync${codex?.needsSync ? " dirty" : ""}`}
                aria-label="Sync Codex"
                disabled={codexPending || codex?.desiredEnabled !== true}
                onClick={() => void syncCodex()}
                title="Sync Codex"
              >
                <span aria-hidden="true">↻</span>
              </button>
            </div>
          </div>
          <span className="runtime-state">
            <span className={`runtime-status-dot ${status?.modelDataPlane ?? "unavailable"}`} aria-hidden="true" />
            {runtimeLabel(status)}
          </span>
          <span className="runtime-active">
            Active requests <strong className="active-request-count">{activeRequests}</strong>
          </span>
          <button
            className="runtime-toggle"
            type="button"
            disabled={action === undefined || runtimePending}
            onClick={() => void executeRuntime()}
          >
            {runtimePending
              ? action === "stop" ? "Stopping…" : "Starting…"
              : action === "stop" ? "Stop" : "Start"}
          </button>
        </div>
      </header>

      <main className="product-content">
        {page === "overview" ? (
          <OverviewPage api={api} readyRevision={readyRevision} />
        ) : page === "providers" ? (
          <ProvidersPage api={api} />
        ) : (
          <SettingsPage api={api} />
        )}
      </main>
    </div>
  );
}
