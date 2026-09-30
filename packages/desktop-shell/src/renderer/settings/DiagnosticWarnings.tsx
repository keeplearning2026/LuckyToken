import { useEffect, useState } from "react";

import type { RuntimeEventRecord, TokenDesktopApi } from "../../shared/desktop-api.js";

async function queryRecentWarnings(api: TokenDesktopApi): Promise<readonly RuntimeEventRecord[] | "unavailable"> {
  const records: RuntimeEventRecord[] = [];
  let afterId: number | undefined;
  for (;;) {
    const response = await api.control.queryRuntimeEvents({ limit: 1_000, ...(afterId === undefined ? {} : { afterId }) });
    if (response.outcome === "unavailable") return "unavailable";
    records.push(...response.result.records);
    const newest = response.result.records.at(-1)?.id;
    if (!response.result.hasMore || newest === undefined || newest === afterId) break;
    afterId = newest;
  }
  return records.filter((record) => record.level !== "info").sort((left, right) => right.id - left.id).slice(0, 25);
}

export function DiagnosticWarnings({ api }: { readonly api: TokenDesktopApi }) {
  const [events, setEvents] = useState<readonly RuntimeEventRecord[]>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void queryRecentWarnings(api).then((response) => {
      if (!active) return;
      if (response === "unavailable") { setUnavailable(true); return; }
      setEvents(response);
      setUnavailable(false);
    }, () => { if (active) setUnavailable(true); });
    return () => { active = false; };
  }, [api]);

  return <div className="page-card settings-section">
    <header className="settings-section-header">
      <div className="settings-copy"><p className="eyebrow">DIAGNOSTICS</p><h3>Recent warnings</h3></div>
    </header>
    {unavailable ? <p className="error-text">Recent runtime warnings are temporarily unavailable.</p>
      : events === undefined ? <p>Loading runtime warnings…</p>
        : events.length === 0 ? <p className="settings-empty-state">No recent runtime warnings.</p>
          : <ul className="diagnostic-list">{events.map((record) => <li key={record.id}><span className={`badge ${record.level === "critical" || record.level === "error" ? "warning" : "neutral"}`}>{record.level}</span><span><strong>{record.safeMessage}</strong><code>{record.classification}</code></span></li>)}</ul>}
  </div>;
}
