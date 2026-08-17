/**
 * Analytics page (Ticket 21): filterable provider and total analytics over
 * the Request Ledger. TypeScript owns everything here — query building,
 * range presets, view/group/filter state, and rendering. The shell seam is
 * `getAnalytics` (bounded versioned summary/options queries); the page
 * never touches persistence, the catalog, or any monetary value.
 *
 * Display rules:
 *  - counts include every matching request regardless of usage
 *    completeness (a caption states this next to the numbers);
 *  - token/cache aggregates include only Complete terminal usage, with
 *    participating / total / excluded always visible;
 *  - `reasoning` renders as an output subset and is never added to any
 *    total (footnote beside it);
 *  - the cache hit rate renders as the exact aggregate fraction
 *    numerator/denominator — never an average of per-request rates;
 *  - requests attribute to their acceptedAt bucket even when completion
 *    crosses a boundary;
 *  - no cost, price, subscription, or billing value exists on this page.
 *
 * Library-free and accessible: native form controls with labels, table
 * captions, `th scope`, an `aria-live` results region, and bars that are
 * decorative (`aria-hidden`) while the table cells carry the data.
 */
import { useEffect, useMemo, useState } from "react";

import {
  type AnalyticsBucket,
  type AnalyticsFilter,
  type AnalyticsGroupBy,
  type AnalyticsGroupRow,
  type AnalyticsOptionsResult,
  type AnalyticsQuery,
  type AnalyticsResult,
  type AnalyticsSummary,
} from "@luckytoken/application-control-plane/control-plane";

import type { WindowsShellHost } from "./shell-lifecycle.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface AnalyticsPageProps {
  readonly shell: WindowsShellHost;
}

type PresetId = "24h" | "7d" | "30d" | "all" | "custom";
type ViewMode = "total" | "provider";
type GroupChoice = "none" | "model" | "protocol" | "project" | "outcome";

const PRESETS: ReadonlyArray<readonly [PresetId, string]> = Object.freeze([
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["all", "All time"],
  ["custom", "Custom"],
]);

const GROUP_OPTIONS: ReadonlyArray<readonly [GroupChoice, string]> =
  Object.freeze([
    ["none", "None"],
    ["model", "Real model"],
    ["protocol", "Client protocol"],
    ["project", "Project"],
    ["outcome", "Outcome"],
  ]);

const OUTCOME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  running: "Running",
  success: "Success",
  failed: "Failed",
  aborted: "Aborted",
  rejectedAuth: "Auth rejected",
  unknownAlias: "Unknown model",
  unavailableAlias: "Model unavailable",
  interrupted: "Interrupted",
});

export interface AnalyticsFilterDraft {
  readonly provider: string;
  readonly model: string;
  readonly protocol: string;
  readonly project: string;
  readonly outcome: string;
}

const EMPTY_FILTERS: AnalyticsFilterDraft = Object.freeze({
  provider: "",
  model: "",
  protocol: "",
  project: "",
  outcome: "",
});

/** datetime-local value (local time) → epoch-ms, or undefined when blank or
 *  unparseable. */
function parseLocalTime(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatBucketTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Outcome bucket display row over a summary (labels stable). */
const OUTCOME_COLUMNS: ReadonlyArray<readonly [keyof AnalyticsSummary, string]> =
  Object.freeze([
    ["total", "Total"],
    ["success", "Success"],
    ["failed", "Failed"],
    ["aborted", "Aborted"],
    ["other", "Other"],
    ["pending", "Pending"],
  ]);

export function AnalyticsPage({ shell }: AnalyticsPageProps) {
  const [preset, setPreset] = useState<PresetId>("24h");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [view, setView] = useState<ViewMode>("total");
  const [group, setGroup] = useState<GroupChoice>("none");
  const [filters, setFilters] = useState<AnalyticsFilterDraft>(EMPTY_FILTERS);
  const [refreshTick, setRefreshTick] = useState(0);
  const [result, setResult] = useState<AnalyticsResult | undefined>();
  const [options, setOptions] = useState<AnalyticsOptionsResult | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const range = useMemo((): { from: number; to: number } | undefined => {
    const now = Date.now();
    switch (preset) {
      case "24h":
        return { from: now - 24 * HOUR_MS, to: now };
      case "7d":
        return { from: now - 7 * DAY_MS, to: now };
      case "30d":
        return { from: now - 30 * DAY_MS, to: now };
      case "all":
        return { from: 0, to: now };
      case "custom": {
        const from = parseLocalTime(customFrom);
        const to = parseLocalTime(customTo);
        if (from === undefined || to === undefined || from >= to) {
          return undefined;
        }
        return { from, to };
      }
    }
  }, [preset, customFrom, customTo]);

  const summaryQuery: AnalyticsQuery | undefined = useMemo(() => {
    if (range === undefined) return undefined;
    const filter: AnalyticsFilter = {
      ...(filters.provider === "" ? {} : { providers: [filters.provider] }),
      ...(filters.model === "" ? {} : { models: [filters.model] }),
      ...(filters.protocol === "" ? {} : { protocols: [filters.protocol] }),
      ...(filters.project === "" ? {} : { projects: [filters.project] }),
      ...(filters.outcome === "" ? {} : { outcomes: [filters.outcome] }),
    };
    const filterKeys = Object.keys(filter);
    const groupBy: AnalyticsGroupBy | undefined =
      view === "provider"
        ? "provider"
        : group === "none"
          ? undefined
          : group;
    const span = range.to - range.from;
    const series =
      span <= 24 * HOUR_MS
        ? { granularity: "hour" as const }
        : span <= 366 * DAY_MS
          ? { granularity: "day" as const }
          : undefined;
    return {
      version: 1 as const,
      command: "summary" as const,
      from: range.from,
      to: range.to,
      ...(filterKeys.length > 0 ? { filters: filter } : {}),
      ...(groupBy === undefined ? {} : { groupBy }),
      ...(series === undefined ? {} : { series }),
    };
  }, [range, view, group, filters]);

  useEffect(() => {
    if (summaryQuery === undefined) {
      setResult(undefined);
      setError(
        preset === "custom"
          ? "Enter both a From and a To time for the custom range."
          : undefined,
      );
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void shell
      .getAnalytics(summaryQuery)
      .then((value) => {
        if (cancelled) return;
        setResult(value.command === "summary" ? value : undefined);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Analytics are unavailable. Check that LuckyToken is running.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shell, summaryQuery, refreshTick, preset]);

  useEffect(() => {
    if (range === undefined) return;
    let cancelled = false;
    const query: AnalyticsQuery = {
      version: 1,
      command: "options",
      from: range.from,
      ...(preset === "all" ? {} : { to: range.to }),
    };
    void shell
      .getAnalytics(query)
      .then((value) => {
        if (!cancelled && value.command === "options") setOptions(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [shell, range, preset, refreshTick]);

  const groupBy = summaryQuery?.groupBy;
  const totals = result?.totals;
  const empty =
    totals !== undefined && totals.total === 0 && groupBy === undefined;

  return (
    <section className="analytics-page" aria-label="Analytics">
      <div className="analytics-toolbar">
        <strong>Analytics</strong>
        <fieldset className="analytics-presets">
          <legend className="visually-hidden">Time range</legend>
          {PRESETS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={preset === id ? "active" : undefined}
              aria-pressed={preset === id}
              onClick={() => setPreset(id)}
            >
              {label}
            </button>
          ))}
        </fieldset>
        {preset === "custom" ? (
          <span className="analytics-custom-range">
            <label htmlFor="analytics-from">From</label>
            <input
              id="analytics-from"
              type="datetime-local"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
            />
            <label htmlFor="analytics-to">To</label>
            <input
              id="analytics-to"
              type="datetime-local"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
            />
          </span>
        ) : null}
        <span className="analytics-view-toggle" role="group" aria-label="View">
          <button
            type="button"
            className={view === "total" ? "active" : undefined}
            aria-pressed={view === "total"}
            onClick={() => setView("total")}
          >
            Total
          </button>
          <button
            type="button"
            className={view === "provider" ? "active" : undefined}
            aria-pressed={view === "provider"}
            onClick={() => setView("provider")}
          >
            Per real Provider
          </button>
        </span>
        <label htmlFor="analytics-group" className="analytics-group-label">
          Group by
          <select
            id="analytics-group"
            value={view === "provider" ? "provider" : group}
            disabled={view === "provider"}
            onChange={(event) => setGroup(event.target.value as GroupChoice)}
          >
            {GROUP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {view === "provider" ? (
              <option value="provider" disabled>
                Provider
              </option>
            ) : null}
          </select>
        </label>
        <button
          type="button"
          className="analytics-refresh"
          onClick={() => setRefreshTick((tick) => tick + 1)}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <fieldset className="analytics-filters">
        <legend>Filters</legend>
        <label htmlFor="analytics-filter-provider">
          Provider
          <select
            id="analytics-filter-provider"
            value={filters.provider}
            onChange={(event) =>
              setFilters({ ...filters, provider: event.target.value })
            }
          >
            <option value="">All</option>
            {(options?.providers ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="analytics-filter-model">
          Real model
          <select
            id="analytics-filter-model"
            value={filters.model}
            onChange={(event) =>
              setFilters({ ...filters, model: event.target.value })
            }
          >
            <option value="">All</option>
            {(options?.models ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="analytics-filter-protocol">
          Client protocol
          <select
            id="analytics-filter-protocol"
            value={filters.protocol}
            onChange={(event) =>
              setFilters({ ...filters, protocol: event.target.value })
            }
          >
            <option value="">All</option>
            {(options?.protocols ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="analytics-filter-project">
          Project
          <select
            id="analytics-filter-project"
            value={filters.project}
            onChange={(event) =>
              setFilters({ ...filters, project: event.target.value })
            }
          >
            <option value="">All</option>
            {(options?.projects ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="analytics-filter-outcome">
          Outcome
          <select
            id="analytics-filter-outcome"
            value={filters.outcome}
            onChange={(event) =>
              setFilters({ ...filters, outcome: event.target.value })
            }
          >
            <option value="">All</option>
            {(options?.outcomes ?? []).map((value) => (
              <option key={value} value={value}>
                {OUTCOME_LABELS[value] ?? value}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <div className="analytics-results" aria-live="polite">
        {error !== undefined ? (
          <p className="analytics-empty">{error}</p>
        ) : loading && totals === undefined ? (
          <p className="analytics-loading">Loading analytics…</p>
        ) : empty ? (
          <p className="analytics-empty">
            No requests in the selected time range.
          </p>
        ) : totals === undefined ? null : (
          <>
            <AnalyticsCountsTable summary={totals} />
            <AnalyticsTokensTable summary={totals} />
            {result?.rows !== undefined ? (
              <AnalyticsGroupsTable
                rows={result.rows}
                truncated={result.truncated ?? false}
              />
            ) : null}
            {result?.buckets !== undefined ? (
              <AnalyticsSeriesTable
                buckets={result.buckets}
                granularity={
                  summaryQuery?.series?.granularity ?? "hour"
                }
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function AnalyticsCountsTable({ summary }: { readonly summary: AnalyticsSummary }) {
  return (
    <div className="analytics-table-scroll">
      <table className="analytics-table">
        <caption>
          Request counts include every matching request regardless of usage
          completeness. Rates are over the total.
        </caption>
        <thead>
          <tr>
            {OUTCOME_COLUMNS.map(([key, label]) => (
              <th key={key} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {OUTCOME_COLUMNS.map(([key]) => (
              <td key={key}>{formatCount(summary[key] as number)}</td>
            ))}
          </tr>
          <tr className="analytics-rate-row">
            {OUTCOME_COLUMNS.map(([key]) => (
              <td key={key}>
                {key === "success"
                  ? formatPercent(summary.successRate)
                  : key === "failed"
                    ? formatPercent(summary.failureRate)
                    : key === "aborted"
                      ? formatPercent(summary.abortRate)
                      : "-"}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AnalyticsTokensTable({ summary }: { readonly summary: AnalyticsSummary }) {
  const hit =
    summary.cacheHitRate === undefined
      ? "-"
      : `${formatCount(summary.cacheHitNumerator)} of ${formatCount(summary.cacheHitDenominator)} input tokens (${formatPercent(summary.cacheHitRate)})`;
  return (
    <div className="analytics-table-scroll">
      <table className="analytics-table">
        <caption>
          Token aggregates include only requests with Complete terminal
          usage. Requests without Complete usage are excluded.
        </caption>
        <tbody>
          <tr>
            <th scope="row">Participating requests</th>
            <td>{formatCount(summary.participating)}</td>
            <th scope="row">Total requests</th>
            <td>{formatCount(summary.totalRequests)}</td>
            <th scope="row">Excluded requests</th>
            <td>{formatCount(summary.excluded)}</td>
          </tr>
          <tr>
            <th scope="row">Input tokens</th>
            <td>{formatCount(summary.inputTokens)}</td>
            <th scope="row">Cache read tokens</th>
            <td>{formatCount(summary.cacheReadTokens)}</td>
            <th scope="row">Cache write tokens</th>
            <td>{formatCount(summary.cacheWriteTokens)}</td>
          </tr>
          <tr>
            <th scope="row">Output tokens</th>
            <td>
              {formatCount(summary.outputTokens)}
              {summary.reasoningTokens !== undefined ? (
                <>
                  {" "}
                  <span className="analytics-reasoning-note">
                    (including {formatCount(summary.reasoningTokens)} reasoning
                    tokens; reasoning is a subset of output and is never added
                    to token totals)
                  </span>
                </>
              ) : null}
            </td>
            <th scope="row">Normalized token total</th>
            <td>
              {summary.normalizedTokenTotal === undefined
                ? "-"
                : formatCount(summary.normalizedTokenTotal)}
            </td>
            <th scope="row">Cache hit rate</th>
            <td>{hit}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AnalyticsGroupsTable({
  rows,
  truncated,
}: {
  readonly rows: readonly AnalyticsGroupRow[];
  readonly truncated: boolean;
}) {
  return (
    <div className="analytics-table-scroll">
      <table className="analytics-table">
        <caption>
          {rows[0]?.dimension === undefined
            ? "Grouped results"
            : `Results grouped by ${rows[0].dimension}`}
          {truncated ? " (groups beyond the limit are omitted)" : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col">Value</th>
            <th scope="col">Total</th>
            <th scope="col">Success</th>
            <th scope="col">Failed</th>
            <th scope="col">Aborted</th>
            <th scope="col">Other</th>
            <th scope="col">Participating</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cache hit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.value ?? "∅"}>
              <th scope="row">{row.value ?? "-"}</th>
              <td>{formatCount(row.summary.total)}</td>
              <td>{formatCount(row.summary.success)}</td>
              <td>{formatCount(row.summary.failed)}</td>
              <td>{formatCount(row.summary.aborted)}</td>
              <td>{formatCount(row.summary.other)}</td>
              <td>{formatCount(row.summary.participating)}</td>
              <td>{formatCount(row.summary.inputTokens)}</td>
              <td>{formatCount(row.summary.outputTokens)}</td>
              <td>
                {row.summary.cacheHitRate === undefined
                  ? "-"
                  : `${formatCount(row.summary.cacheHitNumerator)} of ${formatCount(row.summary.cacheHitDenominator)} (${formatPercent(row.summary.cacheHitRate)})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalyticsSeriesTable({
  buckets,
  granularity,
}: {
  readonly buckets: readonly AnalyticsBucket[];
  readonly granularity: "hour" | "day";
}) {
  const largest = Math.max(
    1,
    ...buckets.map((bucket) => bucket.summary.total),
  );
  return (
    <div className="analytics-table-scroll">
      <table className="analytics-table">
        <caption>
          {granularity === "hour" ? "Hourly" : "Daily"} time series — each
          request is attributed to the bucket containing its acceptance
          time, even when completion crosses a boundary.
        </caption>
        <thead>
          <tr>
            <th scope="col">Bucket start</th>
            <th scope="col">Requests</th>
            <th scope="col">Participating</th>
            <th scope="col">Output tokens</th>
            <th scope="col">Cache hit</th>
            <th scope="col" aria-hidden="true" className="analytics-bar-col">
              Requests
            </th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.start}>
              <th scope="row">{formatBucketTime(bucket.start)}</th>
              <td>{formatCount(bucket.summary.total)}</td>
              <td>{formatCount(bucket.summary.participating)}</td>
              <td>{formatCount(bucket.summary.outputTokens)}</td>
              <td>
                {bucket.summary.cacheHitRate === undefined
                  ? "-"
                  : `${formatCount(bucket.summary.cacheHitNumerator)} of ${formatCount(bucket.summary.cacheHitDenominator)} (${formatPercent(bucket.summary.cacheHitRate)})`}
              </td>
              <td aria-hidden="true" className="analytics-bar-col">
                <span
                  className="analytics-bar"
                  style={{
                    width: `${Math.round((bucket.summary.total / largest) * 100)}%`,
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}