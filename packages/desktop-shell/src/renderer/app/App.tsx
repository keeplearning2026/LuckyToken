import { useEffect, useRef, useState } from "react";

import type {
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
  const [status, setStatus] = useState<StatusSnapshot>();
  const [runtimePending, setRuntimePending] = useState(false);
  const latestSequence = useRef(-1);
  const activeRequests = useActiveRequests(api);

  useEffect(() => {
    let active = true;
    const accept = (next: StatusSnapshot): void => {
      if (!active || next.sequence < latestSequence.current) return;
      latestSequence.current = next.sequence;
      setStatus(next);
    };
    const unsubscribe = api.control.onStatus(accept);
    void api.control.getStatus().then(accept, () => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const executeRuntime = async (): Promise<void> => {
    const command = runtimeAction(status);
    if (command === undefined || runtimePending) return;
    setRuntimePending(true);
    try {
      const result = await api.control.executeRuntime(command);
      if (result.snapshot.sequence >= latestSequence.current) {
        latestSequence.current = result.snapshot.sequence;
        setStatus(result.snapshot);
      }
    } finally {
      setRuntimePending(false);
    }
  };

  const action = runtimeAction(status);
  const pageTitle = pages.find((entry) => entry.id === page)?.label ?? page;

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
          <span className="runtime-endpoint" title={status?.dataPlane?.configuredOrigin}>
            {status?.dataPlane?.configuredOrigin ?? "-"}
          </span>
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
          <OverviewPage api={api} />
        ) : page === "providers" ? (
          <ProvidersPage api={api} />
        ) : (
          <SettingsPage api={api} />
        )}
      </main>
    </div>
  );
}
