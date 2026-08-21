import { useEffect, useMemo, useState } from "react";

import {
  formatPercent,
  formatTimestamp,
  formatTokenCount,
  formatTokensPerSecond,
  projectRequestLedger,
  type AnalyticsFilter,
  type AnalyticsOptionsResult,
  type AnalyticsSummary,
  type LuckyTokenDesktopApi,
  type PrimaryStatus,
  type RequestLedgerQuery,
  type RequestLedgerRecord,
} from "../../shared/desktop-api.js";

const REQUEST_PAGE_SIZE = 50;

interface OverviewFilters {
  readonly from: number;
  readonly to: number;
  readonly protocol: string;
  readonly session: string;
  readonly model: string;
}

function defaultFilters(): OverviewFilters {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    from: start.getTime(),
    to: end.getTime(),
    protocol: "",
    session: "",
    model: "",
  };
}

function inputDateTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseInputDateTime(value: string): number | undefined {
  if (value.length === 0) return undefined;
  const epochMs = new Date(value).getTime();
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

function analyticsFilter(filters: OverviewFilters): AnalyticsFilter | undefined {
  const value: AnalyticsFilter = {
    ...(filters.protocol === "" ? {} : { protocols: [filters.protocol] }),
    ...(filters.session === "" ? {} : { sessions: [filters.session] }),
    ...(filters.model === "" ? {} : { models: [filters.model] }),
  };
  return Object.keys(value).length === 0 ? undefined : value;
}

function ledgerQuery(filters: OverviewFilters): RequestLedgerQuery {
  return {
    limit: REQUEST_PAGE_SIZE,
    from: filters.from,
    to: filters.to,
    ...(filters.protocol === "" ? {} : { protocolId: filters.protocol }),
    ...(filters.session === "" ? {} : { clientSessionId: filters.session }),
    ...(filters.model === "" ? {} : { realModelId: filters.model }),
  };
}

function matchesRecord(record: RequestLedgerRecord, filters: OverviewFilters): boolean {
  if (record.acceptedAt < filters.from || record.acceptedAt >= filters.to) return false;
  if (filters.protocol !== "" && record.protocolId !== filters.protocol) return false;
  if (filters.session !== "" && record.clientSessionId !== filters.session) return false;
  if (filters.model !== "" && record.realModelId !== filters.model) return false;
  return true;
}

function mergeRecords(
  current: readonly RequestLedgerRecord[],
  incoming: readonly RequestLedgerRecord[],
): RequestLedgerRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => right.id - left.id);
}

function statusTone(status: PrimaryStatus): string {
  switch (status) {
    case "Success":
      return "good";
    case "Running":
      return "running";
    case "Aborted":
    case "Unknown model":
    case "Model unavailable":
      return "warning";
    default:
      return "error";
  }
}

function shortCodeDisplay(value: string): React.JSX.Element | string {
  if (value === "-") return "-";
  return <span title={value}>{value.slice(0, 8)}</span>;
}

function SummaryCards({ summary }: { readonly summary: AnalyticsSummary | undefined }) {
  const cards = [
    ["Requests", summary === undefined ? "-" : formatTokenCount(summary.totalRequests)],
    ["Input", summary === undefined ? "-" : formatTokenCount(summary.inputTokens)],
    ["Cache read", summary === undefined ? "-" : formatTokenCount(summary.cacheReadTokens)],
    ["Output", summary === undefined ? "-" : formatTokenCount(summary.outputTokens)],
    [
      "Token speed",
      summary?.outputTokensPerSecond === undefined
        ? "-"
        : formatTokensPerSecond(summary.outputTokensPerSecond),
    ],
    ["Success", summary === undefined ? "-" : formatPercent(summary.successRate)],
  ] as const;
  return (
    <section className="overview-stats" aria-label="Overview statistics">
      {cards.map(([label, value]) => (
        <div className="overview-stat-card" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function FilterSelect({
  label,
  value,
  values,
  allLabel,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly values: readonly string[];
  readonly allLabel: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="overview-filter-field">
      <span>{label}</span>
      <select aria-label={`${label} filter`} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        <option value="">{allLabel}</option>
        {values.map((entry) => (
          <option key={entry} value={entry}>{entry}</option>
        ))}
      </select>
    </label>
  );
}

export function OverviewPage({
  api,
  readyRevision,
}: {
  readonly api: LuckyTokenDesktopApi;
  readonly readyRevision: number | undefined;
}) {
  const [filters, setFilters] = useState<OverviewFilters>(defaultFilters);
  const [summary, setSummary] = useState<AnalyticsSummary>();
  const [options, setOptions] = useState<AnalyticsOptionsResult>();
  const [records, setRecords] = useState<readonly RequestLedgerRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const validRange = filters.from < filters.to;
  const summaryFilters = useMemo(() => analyticsFilter(filters), [filters]);
  const requestQuery = useMemo(() => ledgerQuery(filters), [filters]);

  useEffect(() => {
    if (!validRange || readyRevision === undefined) {
      setSummary(undefined);
      return;
    }
    let active = true;
    void api.control.getAnalytics({
      version: 1,
      command: "summary",
      from: filters.from,
      to: filters.to,
      ...(summaryFilters === undefined ? {} : { filters: summaryFilters }),
    }).then((result) => {
      if (active && result.command === "summary") setSummary(result.totals);
    }, () => {
      if (active) setSummary(undefined);
    });
    return () => {
      active = false;
    };
  }, [api, filters.from, filters.to, readyRevision, summaryFilters, validRange]);

  useEffect(() => {
    if (!validRange || readyRevision === undefined) {
      setOptions(undefined);
      return;
    }
    let active = true;
    void api.control.getAnalytics({
      version: 1,
      command: "options",
      from: filters.from,
      to: filters.to,
    }).then((result) => {
      if (active && result.command === "options") setOptions(result);
    }, () => {
      if (active) setOptions(undefined);
    });
    return () => {
      active = false;
    };
  }, [api, filters.from, filters.to, readyRevision, validRange]);

  useEffect(() => {
    if (!validRange || readyRevision === undefined) {
      setRecords([]);
      setHasMore(false);
      return;
    }
    let active = true;
    const observed = new Map<number, RequestLedgerRecord>();
    setRecords([]);
    setHasMore(false);

    const unsubscribe = api.control.onRequestLedger(({ record }) => {
      if (!active) return;
      observed.set(record.id, record);
      setRecords((current) => {
        if (!matchesRecord(record, filters)) {
          return current.filter((entry) => entry.id !== record.id);
        }
        return mergeRecords(current, [record]);
      });
    });

    void api.control.getRequestLedger(requestQuery).then((result) => {
      if (!active) return;
      const initial = result.records.filter((record) => matchesRecord(record, filters));
      const live = [...observed.values()].filter((record) => matchesRecord(record, filters));
      setRecords(mergeRecords(initial, live));
      setHasMore(result.hasMore);
    }, () => {
      if (active) {
        setRecords([]);
        setHasMore(false);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, filters, readyRevision, requestQuery, validRange]);

  const loadMore = async (): Promise<void> => {
    const afterId = records.at(-1)?.id;
    if (afterId === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.control.getRequestLedger({ ...requestQuery, afterId });
      setRecords((current) => mergeRecords(current, result.records.filter((record) => matchesRecord(record, filters))));
      setHasMore(result.hasMore);
    } finally {
      setLoadingMore(false);
    }
  };

  const updateFilter = <K extends keyof OverviewFilters>(key: K, value: OverviewFilters[K]): void => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="overview-page">
      <SummaryCards summary={summary} />

      <section className="overview-filters" aria-label="Request filters">
        <label className="overview-filter-field overview-filter-time">
          <span>From</span>
          <input
            type="datetime-local"
            aria-label="From time"
            value={inputDateTime(filters.from)}
            onChange={(event) => {
              const value = parseInputDateTime(event.currentTarget.value);
              if (value !== undefined) updateFilter("from", value);
            }}
          />
        </label>
        <label className="overview-filter-field overview-filter-time">
          <span>To</span>
          <input
            type="datetime-local"
            aria-label="To time"
            value={inputDateTime(filters.to)}
            onChange={(event) => {
              const value = parseInputDateTime(event.currentTarget.value);
              if (value !== undefined) updateFilter("to", value);
            }}
          />
        </label>
        <FilterSelect label="Protocol" value={filters.protocol} values={options?.protocols ?? []} allLabel="All protocols" onChange={(value) => updateFilter("protocol", value)} />
        <FilterSelect label="Session" value={filters.session} values={options?.sessions ?? []} allLabel="All sessions" onChange={(value) => updateFilter("session", value)} />
        <FilterSelect label="Model" value={filters.model} values={options?.models ?? []} allLabel="All models" onChange={(value) => updateFilter("model", value)} />
      </section>

      <section className="overview-requests" aria-label="Requests">
        <div className="overview-table-scroll">
          <table className="overview-request-table">
            <thead>
              <tr>
                <th className="overview-col-compact">Start time</th>
                <th className="overview-col-compact">Session</th>
                <th className="overview-col-compact">Request ID</th>
                <th className="overview-col-compact">Protocol</th>
                <th className="overview-col-compact">Input</th>
                <th className="overview-col-compact">Cache read</th>
                <th className="overview-col-compact">Hit</th>
                <th className="overview-col-compact">Output</th>
                <th className="overview-col-compact">Token speed</th>
                <th className="overview-col-compact">Time</th>
                <th className="overview-col-model">Model</th>
                <th className="overview-col-compact">Status</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td className="overview-empty" colSpan={12}>No requests</td>
                </tr>
              ) : records.map((record) => {
                const row = projectRequestLedger(record);
                return (
                  <tr key={row.id} data-request-id={row.requestId}>
                    <td className="overview-col-compact">{formatTimestamp(row.acceptedAt)}</td>
                    <td className="overview-col-compact">{shortCodeDisplay(row.clientSessionId)}</td>
                    <td className="overview-col-compact overview-col-request-id"><code title={row.requestId}>{row.requestId.slice(0, 8)}</code></td>
                    <td className="overview-col-compact">{row.protocolId}</td>
                    <td className="overview-col-compact">{row.usage.input}</td>
                    <td className="overview-col-compact">{row.usage.cacheRead}</td>
                    <td className="overview-col-compact">{row.usage.cacheHitRate ?? "-"}</td>
                    <td className="overview-col-compact">{row.usage.output}</td>
                    <td className="overview-col-compact" title={row.speedUnavailableReason}>{row.speed}</td>
                    <td className="overview-col-compact">{row.duration}</td>
                    <td className="overview-col-model" title={row.alias === "-" ? undefined : row.alias}>{row.alias}</td>
                    <td className="overview-col-compact"><span className={`overview-status-badge ${statusTone(row.status)}`}>{row.status}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {hasMore ? (
          <button className="overview-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </section>
    </div>
  );
}
