import { useEffect, useState } from "react";

import type { ControlPlaneState } from "./control-plane-projection.js";
import {
  productPages,
  type DesktopShellSnapshot,
  type ProductPageId,
  type WindowsShellHost,
} from "./shell-lifecycle.js";

export interface AppProps {
  readonly shell: WindowsShellHost;
  readonly retryConnection: () => Promise<ControlPlaneState>;
}

export function App({ shell, retryConnection }: AppProps) {
  const [snapshot, setSnapshot] = useState<DesktopShellSnapshot>(
    shell.snapshot(),
  );
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const unsubscribe = shell.subscribe(setSnapshot);
    void shell.launch().then(setSnapshot);
    return () => {
      unsubscribe();
      void shell.dispose();
    };
  }, [shell]);

  const navigate = (page: ProductPageId) => {
    setSnapshot(shell.navigate(page));
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await retryConnection();
    } finally {
      setRetrying(false);
    }
  };

  const activePage = productPages.find(
    (page) => page.id === snapshot.activePage,
  )!;

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Product navigation">
        <div className="brand">
          <span className="brand-mark">L</span>
          <div>
            <strong>LuckyToken</strong>
            <small>Local protocol gateway</small>
          </div>
        </div>
        <nav>
          {productPages.map((page) => (
            <button
              className={page.id === snapshot.activePage ? "active" : ""}
              key={page.id}
              onClick={() => navigate(page.id)}
              type="button"
            >
              {page.label}
            </button>
          ))}
        </nav>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">LOCAL CONTROL PLANE</p>
            <h1>{activePage.label}</h1>
          </div>
          <ConnectionBadge state={snapshot.connection} />
        </header>
        {snapshot.connection.kind === "error" ? (
          <section className="connection-error" aria-live="polite">
            <div>
              <strong>{snapshot.connection.title}</strong>
              <p>{snapshot.connection.detail}</p>
              <small>{snapshot.connection.action}</small>
            </div>
            <button disabled={retrying} onClick={() => void retry()} type="button">
              {retrying ? "Reconnecting…" : "Retry"}
            </button>
          </section>
        ) : null}
        <section className="empty-page">
          <div className="empty-mark" aria-hidden="true" />
          <h2>{activePage.label}</h2>
          <p>
            {snapshot.activePage === "dashboard"
              ? "No activity yet. LuckyToken is ready when your clients are."
              : "This workspace is ready. Configuration is optional until you need it."}
          </p>
        </section>
      </main>
    </div>
  );
}

function ConnectionBadge({ state }: { readonly state: ControlPlaneState }) {
  if (state.kind === "error") {
    return <span className="badge error">Attention needed</span>;
  }
  return (
    <span className="badge connected">
      {state.modelDataPlane === "running" ? "Connected" : state.modelDataPlane}
    </span>
  );
}
