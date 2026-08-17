import { useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";
import { HomePage, type ProductPage } from "../home/HomePage.js";
import { ProvidersPage } from "../providers/ProvidersPage.js";

export interface AppProps {
  readonly api: LuckyTokenDesktopApi;
}

const pages: ReadonlyArray<Readonly<{ id: ProductPage; label: string }>> = Object.freeze([
  { id: "home", label: "Home" },
  { id: "providers", label: "Providers" },
  { id: "connect", label: "Connect" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
]);

function Placeholder({ page }: { readonly page: Exclude<ProductPage, "home"> }) {
  const title = pages.find((entry) => entry.id === page)?.label ?? page;
  return (
    <section className="feature-placeholder">
      <p className="eyebrow">LUCKYTOKEN</p>
      <h1>{title}</h1>
      <p>This product surface is being connected to the typed Desktop API.</p>
    </section>
  );
}

export function App({ api }: AppProps) {
  const [page, setPage] = useState<ProductPage>("home");
  return (
    <div className="product-shell">
      <aside className="product-sidebar">
        <div className="product-brand">
          <span className="product-mark">L</span>
          <div>
            <strong>LuckyToken</strong>
            <small>Local AI gateway</small>
          </div>
        </div>
        <nav aria-label="Product navigation">
          {pages.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={page === entry.id ? "page" : undefined}
              className={page === entry.id ? "active" : undefined}
              onClick={() => setPage(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="product-main">
        <header className="product-header">
          <div>
            <p className="eyebrow">LOCAL AI GATEWAY</p>
            <h1>{pages.find((entry) => entry.id === page)?.label}</h1>
          </div>
        </header>
        {page === "home" ? (
          <HomePage api={api} navigate={setPage} />
        ) : page === "providers" ? (
          <ProvidersPage api={api} />
        ) : (
          <Placeholder page={page} />
        )}
      </main>
    </div>
  );
}
