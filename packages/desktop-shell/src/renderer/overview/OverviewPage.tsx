import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";

import {
  formatPercent,
  formatTimestamp,
  formatTokenCount,
  formatTokensPerSecond,
  projectRequestLedgerDetail,
  type AnalyticsFilter,
  type AnalyticsOptionsResult,
  type AnalyticsSummary,
  type LuckyTokenDesktopApi,
  type PrimaryStatus,
  type RequestLedgerQuery,
  type RequestLedgerRecord,
} from "../../shared/desktop-api.js";
import {
  clampRequestColumnWidth,
  DEFAULT_REQUEST_COLUMN_WIDTHS,
  getRequestColumnStorage,
  loadRequestColumnWidths,
  REQUEST_COLUMN_DEFINITIONS,
  saveRequestColumnWidths,
  totalRequestColumnWidth,
  type RequestColumnId,
} from "./request-column-widths.js";

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

function compactTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(tokens);
}

function shortCodeDisplay(value: string): React.JSX.Element | string {
  if (value === "-") return "-";
  return <span title={value}>{value.slice(0, 8)}</span>;
}

function suggestedAction(status: PrimaryStatus): string {
  switch (status) {
    case "Success":
      return "No action is needed.";
    case "Running":
      return "Wait for the request to finish.";
    case "Auth rejected":
      return "Reconnect the provider, then retry the request.";
    case "Unknown model":
    case "Model unavailable":
      return "Choose a published, available model and retry.";
    case "Client error":
      return "Review the request parameters and protocol, then retry.";
    case "Server error":
      return "Check provider availability and retry after a short delay.";
    case "Aborted":
      return "Retry only if the cancellation was not intentional.";
    case "Interrupted":
      return "Confirm LuckyToken is running, then retry the request.";
    case "Failed":
      return "Open Advanced diagnostics for more context, then retry.";
  }
}

function SummaryCards({ summary }: { readonly summary: AnalyticsSummary | undefined }) {
  const cards = [
    ["Requests", summary === undefined ? "-" : formatTokenCount(summary.totalRequests)],
    ["Input", summary === undefined ? "-" : compactTokenCount(summary.inputTokens)],
    ["Cache read", summary === undefined ? "-" : compactTokenCount(summary.cacheReadTokens)],
    ["Output", summary === undefined ? "-" : compactTokenCount(summary.outputTokens)],
    [
      "Token speed",
      summary?.outputTokensPerSecond === undefined
        ? "-"
        : formatTokensPerSecond(summary.outputTokensPerSecond).replace(" tokens/s", " t/s"),
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
  backendAvailable,
}: {
  readonly api: LuckyTokenDesktopApi;
  readonly backendAvailable: boolean;
}) {
  const [filters, setFilters] = useState<OverviewFilters>(defaultFilters);
  const [summary, setSummary] = useState<AnalyticsSummary>();
  const [options, setOptions] = useState<AnalyticsOptionsResult>();
  const [records, setRecords] = useState<readonly RequestLedgerRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedRequestId, setExpandedRequestId] = useState<string>();
  const [columnWidths, setColumnWidths] = useState(() =>
    loadRequestColumnWidths(getRequestColumnStorage()),
  );
  const columnResize = useRef<{
    readonly id: RequestColumnId;
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
  } | undefined>(undefined);
  const mouseResizeCleanup = useRef<(() => void) | undefined>(undefined);

  const validRange = filters.from < filters.to;
  const summaryFilters = useMemo(() => analyticsFilter(filters), [filters]);
  const requestQuery = useMemo(() => ledgerQuery(filters), [filters]);

  useEffect(() => {
    saveRequestColumnWidths(getRequestColumnStorage(), columnWidths);
  }, [columnWidths]);

  useEffect(() => () => mouseResizeCleanup.current?.(), []);

  useEffect(() => {
    if (!validRange || !backendAvailable) {
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
  }, [api, backendAvailable, filters.from, filters.to, summaryFilters, validRange]);

  useEffect(() => {
    if (!validRange || !backendAvailable) {
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
  }, [api, backendAvailable, filters.from, filters.to, validRange]);

  useEffect(() => {
    if (!validRange || !backendAvailable) {
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
  }, [api, backendAvailable, filters, requestQuery, validRange]);

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

  const setColumnWidth = (id: RequestColumnId, width: number): void => {
    setColumnWidths((current) => ({
      ...current,
      [id]: clampRequestColumnWidth(id, width),
    }));
  };

  const beginColumnResize = (
    event: React.PointerEvent<HTMLSpanElement>,
    id: RequestColumnId,
  ): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    columnResize.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: columnWidths[id],
    };
  };

  const beginMouseColumnResize = (
    event: React.MouseEvent<HTMLSpanElement>,
    id: RequestColumnId,
  ): void => {
    event.preventDefault();
    mouseResizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = columnWidths[id];
    const move = (moveEvent: MouseEvent): void => {
      setColumnWidth(id, startWidth + moveEvent.clientX - startX);
    };
    const finish = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      mouseResizeCleanup.current = undefined;
    };
    mouseResizeCleanup.current = finish;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
  };

  const moveColumnResize = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const resize = columnResize.current;
    if (resize === undefined || resize.pointerId !== event.pointerId) return;
    setColumnWidth(resize.id, resize.startWidth + event.clientX - resize.startX);
  };

  const endColumnResize = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const resize = columnResize.current;
    if (resize === undefined || resize.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    columnResize.current = undefined;
  };

  const resizeColumnWithKeyboard = (
    event: React.KeyboardEvent<HTMLSpanElement>,
    id: RequestColumnId,
  ): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    setColumnWidth(id, columnWidths[id] + direction * (event.shiftKey ? 32 : 8));
  };

  return (
    <div className="overview-page">
      <SummaryCards summary={summary} />

      <section className="overview-requests" aria-label="Requests">
        <div className="overview-requests-toolbar">
          <h2>Requests</h2>
          <button
            type="button"
            className={`overview-filter-toggle${filtersOpen ? " active" : ""}`}
            aria-label={filtersOpen ? "Hide request filters" : "Show request filters"}
            aria-expanded={filtersOpen}
            title={filtersOpen ? "Hide request filters" : "Show request filters"}
            onClick={() => setFiltersOpen((current) => !current)}
          >
            <SlidersHorizontal size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        {filtersOpen ? <div className="overview-filters" aria-label="Request filters">
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
        </div> : null}

        <div className="overview-table-scroll">
          <table
            className="overview-request-table"
            style={{ width: totalRequestColumnWidth(columnWidths) }}
          >
            <colgroup>
              {REQUEST_COLUMN_DEFINITIONS.map((column) => (
                <col
                  key={column.id}
                  data-request-column={column.id}
                  style={{ width: columnWidths[column.id] }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                {REQUEST_COLUMN_DEFINITIONS.map((column) => (
                  <th key={column.id} data-request-column-header={column.id}>
                    {column.label}
                    <span
                      className="column-resize-handle"
                      role="separator"
                      tabIndex={0}
                      aria-label={`Resize ${column.label} column`}
                      aria-orientation="vertical"
                      aria-valuemin={column.minWidth}
                      aria-valuemax={column.maxWidth}
                      aria-valuenow={columnWidths[column.id]}
                      title="Drag to resize · Double-click to reset"
                      onPointerDown={(event) => beginColumnResize(event, column.id)}
                      onMouseDown={(event) => beginMouseColumnResize(event, column.id)}
                      onPointerMove={moveColumnResize}
                      onPointerUp={endColumnResize}
                      onPointerCancel={endColumnResize}
                      onDoubleClick={() => setColumnWidth(column.id, DEFAULT_REQUEST_COLUMN_WIDTHS[column.id])}
                      onKeyDown={(event) => resizeColumnWithKeyboard(event, column.id)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td className="overview-empty" colSpan={12}>No requests</td>
                </tr>
              ) : records.map((record) => {
                const row = projectRequestLedgerDetail(record);
                const expanded = expandedRequestId === row.requestId;
                const cause = row.failure === undefined
                  ? "No sanitized failure classification was recorded."
                  : row.failure.stage === undefined
                    ? row.failure.classification
                    : `${row.failure.classification} during ${row.failure.stage}`;
                return (
                  <Fragment key={row.id}>
                    <tr key={row.id} data-request-id={row.requestId} className={expanded ? "expanded" : undefined}>
                      <td className="overview-col-time">
                        <button
                          type="button"
                          className="request-disclosure"
                          aria-label={`${expanded ? "Hide" : "Show"} details for request ${row.requestId}`}
                          aria-expanded={expanded}
                          title={`${expanded ? "Hide" : "Show"} request details`}
                          onClick={() => setExpandedRequestId(expanded ? undefined : row.requestId)}
                        >
                          {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                          <span>{formatTimestamp(row.acceptedAt)}</span>
                        </button>
                      </td>
                      <td className="overview-col-compact">{shortCodeDisplay(row.clientSessionId)}</td>
                      <td className="overview-col-compact overview-col-request-id"><code title={row.requestId}>{row.requestId.slice(0, 8)}</code></td>
                      <td className="overview-col-protocol" title={row.protocolName}>{row.protocolId}</td>
                      <td className="overview-col-compact">{row.usage.input}</td>
                      <td className="overview-col-compact">{row.usage.cacheRead}</td>
                      <td className="overview-col-compact">{row.usage.cacheHitRate ?? "-"}</td>
                      <td className="overview-col-compact">{row.usage.output}</td>
                      <td className="overview-col-speed" title={row.speedUnavailableReason}>{row.speed}</td>
                      <td className="overview-col-compact">{row.duration}</td>
                      <td className="overview-col-model" title={row.alias === "-" ? row.realModelId : row.alias}>{row.alias === "-" ? row.realModelId : row.alias}</td>
                      <td className="overview-col-compact"><span className={`overview-status ${statusTone(row.status)}`}><span aria-hidden="true" />{row.status}</span></td>
                    </tr>
                    {expanded ? (
                      <tr key={`${row.id}-details`} className="overview-detail-row">
                        <td colSpan={12}>
                          <div className="request-diagnosis-panel">
                            <section>
                              <strong>Diagnosis</strong>
                              <p>{row.status}{row.clientHttpStatus === undefined ? "" : ` · HTTP ${row.clientHttpStatus}`}</p>
                              <span>{row.phaseLabel} · Request {row.requestId.slice(0, 8)}</span>
                            </section>
                            <section>
                              <strong>Cause</strong>
                              <p>{cause}</p>
                              <span>{row.attemptCount} attempt{row.attemptCount === 1 ? "" : "s"} recorded</span>
                            </section>
                            <section>
                              <strong>Suggested action</strong>
                              <p>{suggestedAction(row.status)}</p>
                              <span>{row.providerId === "-" ? row.protocolName : row.providerId}</span>
                            </section>
                            {row.credentialCapture !== undefined ? (
                              <section>
                                <strong>Provider Profile</strong>
                                <p>
                                  {row.credentialCapture.displayName} · {row.credentialCapture.authMethodLabel}
                                </p>
                                <span>
                                  {row.credentialCapture.lane === "provider_native"
                                    ? "Provider Native"
                                    : "Semantic Conversion"}
                                </span>
                                {row.credentialAttempts.length > 0 ? (
                                  <ol className="credential-activity-trail">
                                    {row.credentialAttempts.map((attempt) => (
                                      <li key={`${attempt.attempt}-${attempt.credentialId}`}>
                                        {attempt.displayName} — {attempt.outcome === "http_429"
                                          ? "HTTP 429"
                                          : attempt.outcome === "success"
                                            ? "Success"
                                            : attempt.outcome === "aborted"
                                              ? "Aborted"
                                              : "Failed"}
                                        {attempt.selectionReason === "http_429_switch"
                                          ? " · HTTP 429 failover"
                                          : ""}
                                      </li>
                                    ))}
                                  </ol>
                                ) : null}
                              </section>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
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
