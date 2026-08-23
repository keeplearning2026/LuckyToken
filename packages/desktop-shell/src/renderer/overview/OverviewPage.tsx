import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";

import {
  formatPercent,
  formatTimestamp,
  formatTokenCount,
  formatTokensPerSecond,
  type AnalyticsFilter,
  type AnalyticsOptionsResult,
  type AnalyticsSummary,
  type LuckyTokenDesktopApi,
  type RequestJourneyRecord,
  type RequestJourneySummary,
} from "../../shared/desktop-api.js";
import {
  loadRequestColumnWidths,
  getRequestColumnStorage,
  REQUEST_COLUMN_DEFINITIONS,
  totalRequestColumnWidth,
} from "./request-column-widths.js";

const REQUEST_PAGE_SIZE = 1_000;

async function queryAllRequestJourneys(api: LuckyTokenDesktopApi): Promise<readonly RequestJourneySummary[] | "unavailable"> {
  const records: RequestJourneySummary[] = [];
  let afterId: number | undefined;
  for (;;) {
    const response = await api.control.queryRequestJourneys({
      limit: REQUEST_PAGE_SIZE,
      ...(afterId === undefined ? {} : { afterId }),
    });
    if (response.outcome === "unavailable") return "unavailable";
    records.push(...response.result.records);
    const newest = response.result.records.at(-1)?.id;
    if (!response.result.hasMore || newest === undefined || newest === afterId) break;
    afterId = newest;
  }
  return records;
}

interface OverviewFilters {
  readonly from: number;
  readonly to: number;
  readonly protocol: string;
}

function defaultFilters(): OverviewFilters {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.getTime(), to: end.getTime(), protocol: "" };
}

function inputDateTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseInputDateTime(value: string): number | undefined {
  const epochMs = new Date(value).getTime();
  return value.length > 0 && Number.isFinite(epochMs) ? epochMs : undefined;
}

function mergeSummaries(
  current: readonly RequestJourneySummary[],
  incoming: readonly RequestJourneySummary[],
): RequestJourneySummary[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => right.id - left.id);
}

function displayOutcome(outcome: RequestJourneySummary["outcome"]): string {
  return `${outcome.slice(0, 1).toUpperCase()}${outcome.slice(1)}`;
}

function statusTone(outcome: RequestJourneySummary["outcome"]): string {
  if (outcome === "success") return "good";
  if (outcome === "running") return "running";
  if (outcome === "aborted" || outcome === "interrupted") return "warning";
  return "error";
}

function detailProjection(record: RequestJourneyRecord) {
  const observations = record.timeline.map((entry) => entry.observation);
  const identity = observations.findLast((entry) => entry.kind === "request_identity_established");
  const model = observations.findLast((entry) => entry.kind === "model_resolved");
  const profile = observations.findLast((entry) => entry.kind === "profile_attributed");
  const usage = observations.findLast((entry) => entry.kind === "terminal_usage_observed");
  const failure = record.incident?.failures.find(
    (entry) => entry.failureId === record.incident?.primaryFailureId,
  );
  return { identity, model, profile, usage, failure };
}

function SummaryCards({ summary }: { readonly summary: AnalyticsSummary | undefined }) {
  const cards = [
    ["Requests", summary === undefined ? "-" : formatTokenCount(summary.totalRequests)],
    ["Input", summary === undefined ? "-" : formatTokenCount(summary.inputTokens)],
    ["Cache read", summary === undefined ? "-" : formatTokenCount(summary.cacheReadTokens)],
    ["Output", summary === undefined ? "-" : formatTokenCount(summary.outputTokens)],
    ["Token speed", summary?.outputTokensPerSecond === undefined ? "-" : formatTokensPerSecond(summary.outputTokensPerSecond).replace(" tokens/s", " t/s")],
    ["Cache hit", summary?.cacheHitRate === undefined ? "-" : formatPercent(summary.cacheHitRate)],
  ] as const;
  return <section className="overview-stats" aria-label="Overview statistics">
    {cards.map(([label, value]) => <div className="overview-stat-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}
  </section>;
}

export function OverviewPage({ api, backendAvailable }: { readonly api: LuckyTokenDesktopApi; readonly backendAvailable: boolean }) {
  const [filters, setFilters] = useState<OverviewFilters>(defaultFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [summary, setSummary] = useState<AnalyticsSummary>();
  const [options, setOptions] = useState<AnalyticsOptionsResult>();
  const [records, setRecords] = useState<readonly RequestJourneySummary[]>([]);
  const [details, setDetails] = useState<Readonly<Record<string, RequestJourneyRecord | "unavailable">>>({});
  const [expandedRequestId, setExpandedRequestId] = useState<string>();
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [analyticsUnavailable, setAnalyticsUnavailable] = useState(false);
  const [columnWidths] = useState(() => loadRequestColumnWidths(getRequestColumnStorage()));
  const validRange = filters.from < filters.to;
  const analyticsFilters = useMemo<AnalyticsFilter | undefined>(
    () => filters.protocol === "" ? undefined : { protocols: [filters.protocol] },
    [filters.protocol],
  );
  const filteredRecords = useMemo(
    () => records.filter((record) =>
      record.createdAt >= filters.from &&
      record.createdAt < filters.to &&
      (filters.protocol === "" || record.protocol === filters.protocol)),
    [filters.from, filters.protocol, filters.to, records],
  );

  useEffect(() => {
    if (!validRange || !backendAvailable) { setSummary(undefined); return; }
    let active = true;
    void api.control.getAnalytics({ version: 2, command: "summary", from: filters.from, to: filters.to, ...(analyticsFilters === undefined ? {} : { filters: analyticsFilters }) }).then(
      (result) => {
        if (!active) return;
        if ("outcome" in result) { setAnalyticsUnavailable(true); setSummary(undefined); return; }
        setAnalyticsUnavailable(false);
        if (result.command === "summary") setSummary(result.totals);
      },
      () => { if (active) setSummary(undefined); },
    );
    return () => { active = false; };
  }, [analyticsFilters, api, backendAvailable, filters.from, filters.to, validRange]);

  useEffect(() => {
    if (!validRange || !backendAvailable) { setOptions(undefined); return; }
    let active = true;
    void api.control.getAnalytics({ version: 2, command: "options", from: filters.from, to: filters.to }).then(
      (result) => { if (active && !("outcome" in result) && result.command === "options") setOptions(result); },
      () => { if (active) setOptions(undefined); },
    );
    return () => { active = false; };
  }, [api, backendAvailable, filters.from, filters.to, validRange]);

  useEffect(() => {
    if (!backendAvailable) { setRecords([]); setHistoryUnavailable(false); return; }
    let active = true;
    const observed = new Map<number, RequestJourneySummary>();
    setRecords([]);
    setHistoryUnavailable(false);
    const unsubscribe = api.control.onRequestJourneys((record) => {
      if (!active) return;
      observed.set(record.id, record);
      setRecords((current) => mergeSummaries(current, [record]));
    });
    void queryAllRequestJourneys(api).then((response) => {
      if (!active) return;
      if (response === "unavailable") { setHistoryUnavailable(true); return; }
      setRecords(mergeSummaries(response, [...observed.values()]));
    }, () => { if (active) setHistoryUnavailable(true); });
    return () => { active = false; unsubscribe(); };
  }, [api, backendAvailable]);

  const toggleDetails = async (requestId: string): Promise<void> => {
    if (expandedRequestId === requestId) { setExpandedRequestId(undefined); return; }
    setExpandedRequestId(requestId);
    if (details[requestId] !== undefined) return;
    try {
      const response = await api.control.getRequestJourney({ requestId });
      setDetails((current) => ({ ...current, [requestId]: response.outcome === "ok" ? response.result : "unavailable" }));
    } catch {
      setDetails((current) => ({ ...current, [requestId]: "unavailable" }));
    }
  };

  return <div className="overview-page">
    <SummaryCards summary={summary} />
    {analyticsUnavailable ? <p className="error-text">Request analytics are temporarily unavailable.</p> : null}
    <section className="overview-requests" aria-label="Requests">
      <div className="overview-requests-toolbar"><h2>Requests</h2><button type="button" className={`overview-filter-toggle${filtersOpen ? " active" : ""}`} aria-label={filtersOpen ? "Hide overview filters" : "Show overview filters"} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((current) => !current)}><SlidersHorizontal size={17} aria-hidden="true" /></button></div>
      {filtersOpen ? <div className="overview-filters" aria-label="Overview filters">
        <label className="overview-filter-field overview-filter-time"><span>From</span><input type="datetime-local" aria-label="From time" value={inputDateTime(filters.from)} onChange={(event) => { const value = parseInputDateTime(event.currentTarget.value); if (value !== undefined) setFilters((current) => ({ ...current, from: value })); }} /></label>
        <label className="overview-filter-field overview-filter-time"><span>To</span><input type="datetime-local" aria-label="To time" value={inputDateTime(filters.to)} onChange={(event) => { const value = parseInputDateTime(event.currentTarget.value); if (value !== undefined) setFilters((current) => ({ ...current, to: value })); }} /></label>
        <label className="overview-filter-field"><span>Protocol</span><select aria-label="Protocol filter" value={filters.protocol} onChange={(event) => setFilters((current) => ({ ...current, protocol: event.currentTarget.value }))}><option value="">All protocols</option>{(options?.protocols ?? []).map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}</select></label>
      </div> : null}
      <div className="overview-table-scroll"><table className="overview-request-table" style={{ width: totalRequestColumnWidth(columnWidths) }}>
        <colgroup>{REQUEST_COLUMN_DEFINITIONS.map((column) => <col key={column.id} data-request-column={column.id} style={{ width: columnWidths[column.id] }} />)}</colgroup>
        <thead><tr>{REQUEST_COLUMN_DEFINITIONS.map((column) => <th key={column.id} data-request-column-header={column.id}>{column.label}</th>)}</tr></thead>
        <tbody>{historyUnavailable ? <tr><td className="overview-empty" colSpan={12}>Request history is temporarily unavailable.</td></tr> : filteredRecords.length === 0 ? <tr><td className="overview-empty" colSpan={12}>No requests</td></tr> : filteredRecords.map((record) => {
          const expanded = expandedRequestId === record.requestId;
          const detail = details[record.requestId];
          const projection = typeof detail === "object" ? detailProjection(detail) : undefined;
          const duration = record.closedAt === undefined ? "-" : `${Math.max(0, record.closedAt - record.createdAt)} ms`;
          const usage = projection?.usage?.usage;
          const location = projection?.failure?.location ?? record.primaryFailureLocation;
          return <Fragment key={record.id}>
            <tr data-request-id={record.requestId} className={expanded ? "expanded" : undefined}>
              <td><button type="button" className="request-disclosure" aria-label={`${expanded ? "Hide" : "Show"} details for request ${record.requestId}`} aria-expanded={expanded} onClick={() => void toggleDetails(record.requestId)}>{expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}<span>{formatTimestamp(record.createdAt)}</span></button></td>
              <td>{projection?.identity?.clientSessionId ?? projection?.identity?.effectiveSessionId ?? "-"}</td><td><code title={record.requestId}>{record.requestId}</code></td><td>{record.protocol ?? "-"}</td>
              <td>{usage === undefined ? "-" : formatTokenCount(usage.input)}</td><td>{usage === undefined ? "-" : formatTokenCount(usage.cacheRead)}</td><td>-</td><td>{usage === undefined ? "-" : formatTokenCount(usage.output)}</td><td>-</td><td>{duration}</td><td>{projection?.model?.modelId ?? "-"}</td><td><span className={`overview-status ${statusTone(record.outcome)}`}><span aria-hidden="true" />{displayOutcome(record.outcome)}</span></td>
            </tr>
            {expanded ? <tr className="overview-detail-row"><td colSpan={12}><div className="request-diagnosis-panel">
              {detail === undefined ? <p>Loading request details…</p> : detail === "unavailable" ? <p className="error-text">Request details are temporarily unavailable.</p> : <>
                <section><strong>Failure</strong><p>{projection?.failure?.classification ?? "No primary failure recorded."}</p><span>{projection?.failure?.safeMessage ?? displayOutcome(record.outcome)}</span></section>
                <section><strong>Location</strong><p>{location === undefined ? "No precise failure location recorded." : `${location.phase} · ${location.step}${location.attempt === undefined ? "" : ` · attempt ${location.attempt}`}`}</p><span>{location?.lane ?? record.lane ?? "No lane recorded"}</span></section>
                <section><strong>Profile</strong><p>{projection?.profile?.displayName ?? "No profile recorded."}</p><span>{projection?.profile?.profileId ?? projection?.model?.providerId ?? "-"}</span></section>
                <section><strong>Artifacts</strong>{detail.artifacts.length === 0 ? <p>No artifacts recorded.</p> : <ul>{detail.artifacts.map((artifact) => <li key={artifact.artifactId}>{artifact.artifactKind} · {artifact.state} · {artifact.redaction === "applied" ? "redacted" : artifact.redaction}{artifact.truncated ? " · truncated" : ""}{artifact.reason === undefined ? "" : ` · ${artifact.reason}`}</li>)}</ul>}</section>
                <section><strong>Completeness</strong><p>{detail.completeness === "complete" ? "Complete diagnostic record." : "Diagnostic record is degraded."}</p></section>
              </>}
            </div></td></tr> : null}
          </Fragment>;
        })}</tbody>
      </table></div>
    </section>
  </div>;
}
