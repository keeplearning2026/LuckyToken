import { useCallback, useEffect, useMemo, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type LedgerResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["getRequestLedger"]>>;
type LedgerRecord = LedgerResult["records"][number];
type AnalyticsResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["getAnalytics"]>>;
type OutcomeFilter = "" | "success" | "failed" | "aborted" | "rejected-auth" | "unknown-alias" | "unavailable-alias" | "interrupted";

function title(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function duration(record: LedgerRecord): string {
  if (record.completedAt === undefined) return "In progress";
  return `${Math.max(0, record.completedAt - record.acceptedAt)} ms`;
}

function tokens(record: LedgerRecord): string {
  const total = record.terminalUsage?.normalizedTotal;
  return total === undefined ? "Usage unavailable" : `${total.toLocaleString()} tokens`;
}

function mergeNewest(current: readonly LedgerRecord[], next: readonly LedgerRecord[]): readonly LedgerRecord[] {
  const byId = new Map<number, LedgerRecord>();
  for (const record of [...next, ...current]) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export function ActivityPage({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [tab, setTab] = useState<"requests" | "analytics">("requests");
  const [records, setRecords] = useState<readonly LedgerRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [outcome, setOutcome] = useState<OutcomeFilter>("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<string>();
  const [analytics, setAnalytics] = useState<AnalyticsResult>();

  const query = useMemo(
    () => ({
      limit: 50,
      ...(outcome === "" ? {} : { outcome }),
    }),
    [outcome],
  );

  const loadHead = useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.control.getRequestLedger(query);
      setRecords(result.records);
      setHasMore(result.hasMore);
    } catch {
      setNotice("Request activity is temporarily unavailable. Refresh to resync.");
    } finally {
      setBusy(false);
    }
  }, [api, query]);

  useEffect(() => {
    let active = true;
    const stop = api.control.onRequestLedger((event) => {
      if (!active) return;
      if (outcome !== "" && event.record.outcome !== outcome) return;
      setRecords((current) => mergeNewest(current, [event.record]));
    });
    void loadHead();
    return () => {
      active = false;
      stop();
    };
  }, [api, loadHead, outcome]);

  const loadOlder = async (): Promise<void> => {
    const oldest = records.at(-1);
    if (oldest === undefined) return;
    setBusy(true);
    try {
      const result = await api.control.getRequestLedger({
        ...query,
        afterId: oldest.id,
      });
      setRecords((current) => mergeNewest(current, result.records));
      setHasMore(result.hasMore);
    } finally {
      setBusy(false);
    }
  };

  const loadAnalytics = async (): Promise<void> => {
    setTab("analytics");
    setBusy(true);
    setNotice(undefined);
    const to = Date.now();
    try {
      setAnalytics(
        await api.control.getAnalytics({
          version: 1,
          command: "summary",
          from: Math.max(0, to - 86_400_000),
          to,
        }),
      );
    } catch {
      setNotice("Analytics are temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const summary = analytics?.command === "summary" ? analytics.totals : undefined;

  return (
    <section className="page-stack">
      <div className="page-card section-heading">
        <div>
          <p className="eyebrow">OBSERVABILITY</p>
          <h2>Activity</h2>
          <p>Recent requests and Backend-computed usage analytics in one place.</p>
        </div>
        <div className="button-row compact">
          <button type="button" className={tab === "requests" ? undefined : "secondary"} onClick={() => setTab("requests")}>Requests</button>
          <button type="button" className={tab === "analytics" ? undefined : "secondary"} onClick={() => void loadAnalytics()}>Analytics</button>
        </div>
      </div>

      {notice === undefined ? null : <p className="product-notice" role="status">{notice}</p>}

      {tab === "requests" ? (
        <div className="page-card activity-list">
          <div className="activity-toolbar">
            <label>
              <span>Outcome</span>
              <select
                aria-label="Outcome filter"
                value={outcome}
                onChange={(event) => setOutcome(event.currentTarget.value as OutcomeFilter)}
              >
                <option value="">All outcomes</option>
                <option value="success">Success</option>
                <option value="failed">Failed</option>
                <option value="aborted">Aborted</option>
                <option value="rejected-auth">Rejected auth</option>
                <option value="unknown-alias">Unknown alias</option>
                <option value="unavailable-alias">Unavailable alias</option>
                <option value="interrupted">Interrupted</option>
              </select>
            </label>
            <button type="button" className="secondary" disabled={busy} onClick={() => void loadHead()}>Refresh</button>
          </div>

          {busy && records.length === 0 ? <p>Loading activity…</p> : null}
          {records.length === 0 && !busy ? <p>No requests match this view yet.</p> : null}
          <div className="request-rows">
            {records.map((record) => (
              <article className="request-row" key={record.id} data-request-id={record.requestId}>
                <div className="request-main">
                  <strong>{record.realModelId ?? record.externalAlias ?? "Unresolved model"}</strong>
                  <span>{title(record.providerId)} · {record.protocolId}</span>
                </div>
                <span className={`request-outcome ${record.outcome}`}>{record.outcome}</span>
                <span>{duration(record)}</span>
                <span>{tokens(record)}</span>
                <code>{record.requestId}</code>
              </article>
            ))}
          </div>
          {hasMore ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => void loadOlder()}>Load older</button>
          ) : null}
        </div>
      ) : (
        <div className="page-card analytics-summary">
          {busy && summary === undefined ? <p>Loading analytics…</p> : null}
          {summary === undefined ? null : (
            <>
              <div className="metric-grid">
                <div><strong>{summary.totalRequests.toLocaleString()} requests</strong><span>Last 24 hours</span></div>
                <div><strong>{(summary.successRate * 100).toFixed(1)}% success</strong><span>{summary.success} successful</span></div>
                <div><strong>{summary.normalizedTokenTotal?.toLocaleString() ?? "—"} tokens</strong><span>{summary.participating} complete usage records</span></div>
                <div><strong>{summary.cacheHitRate === undefined ? "—" : `${(summary.cacheHitRate * 100).toFixed(1)}% cache hit`}</strong><span>Backend aggregate</span></div>
              </div>
              <p className="muted-copy">{summary.excluded} request{summary.excluded === 1 ? "" : "s"} excluded from token totals because complete terminal usage was unavailable.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
