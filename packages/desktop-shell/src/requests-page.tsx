/**
 * Requests page (Ticket 19): the real-time + historical Request Ledger
 * surface. TypeScript owns everything here — list/detail projection,
 * deterministic status derivation display, filters, cursor pagination,
 * live merge/resync, and bounded rendering. The shell seam is
 * `getRequestLedger` (bounded newest-first query) and
 * `subscribeRequestLedger` (listen-first typed events); there is no
 * polling of any private store.
 *
 * Reconciliation contract:
 *  - subscribe BEFORE the head query (listen-first), so no committed
 *    record is ever missed between the two;
 *  - every record is upserted by the monotonic ledger `id` (the row id IS
 *    the sequence); a revision replaces its row;
 *  - a query result adds/replaces rows for the ids it contains and never
 *    deletes rows outside the window; only a resync wipes;
 *  - event-wins ordering: a live event received after a query was issued
 *    is never overwritten by that query's (older) snapshot — each
 *    in-flight query registers a pending-event set and skips those ids
 *    (head reload and older-page fetch alike);
 *  - on any connection drop the map is discarded, and on the next
 *    connected sequence the page re-subscribes (listen-first) and re-queries
 *    page 1 — incremental resume across a gap is forbidden;
 *  - live events are filtered by the active filters locally (the stream
 *    itself is unfiltered), keeping the window filter-consistent;
 *  - the visible window is capped so the DOM stays bounded.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  formatDuration,
  formatTimestamp,
  projectRequestLedger,
  projectRequestLedgerDetail,
  protocolDisplayName,
  type LedgerOutcome,
  type PrimaryStatus,
  type RequestLedgerQuery,
  type RequestLedgerRecord,
} from "@luckytoken/application-control-plane/control-plane";

import type { ControlPlaneState } from "./control-plane-projection.js";
import type { WindowsShellHost } from "./shell-lifecycle.js";

/** Bounded visible window: renders stay bounded even under heavy load;
 *  overflow drops the oldest rows (the cursor still pages them back). */
const MAX_RENDERED_RECORDS = 1_000;
const PAGE_SIZE = 100;

export interface RequestsPageProps {
  readonly shell: WindowsShellHost;
  readonly connection: ControlPlaneState;
}

interface FilterDraft {
  readonly outcome: string;
  readonly protocolId: string;
  readonly providerId: string;
  readonly realModelId: string;
  readonly projectDir: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_DRAFT: FilterDraft = Object.freeze({
  outcome: "",
  protocolId: "",
  providerId: "",
  realModelId: "",
  projectDir: "",
  from: "",
  to: "",
});

const OUTCOME_OPTIONS: Readonly<Array<readonly [LedgerOutcome, string]>> =
  Object.freeze([
    ["running", "Running"],
    ["success", "Success"],
    ["failed", "Failed"],
    ["aborted", "Aborted"],
    ["rejected-auth", "Auth rejected"],
    ["unknown-alias", "Unknown model"],
    ["unavailable-alias", "Model unavailable"],
    ["interrupted", "Interrupted"],
  ]);

/**
 * Local filter matcher mirroring the store semantics: an absent optional
 * value never matches a filter, and the acceptedAt range is inclusive.
 * Live events pass through this before entering the window.
 */
export function requestMatchesLedgerFilters(
  record: RequestLedgerRecord,
  filters: RequestLedgerQuery,
): boolean {
  if (filters.outcome !== undefined && record.outcome !== filters.outcome) {
    return false;
  }
  if (filters.protocolId !== undefined && record.protocolId !== filters.protocolId) {
    return false;
  }
  if (
    filters.providerId !== undefined &&
    (record.providerId ?? "-") !== filters.providerId
  ) {
    return false;
  }
  if (
    filters.realModelId !== undefined &&
    (record.realModelId ?? "-") !== filters.realModelId
  ) {
    return false;
  }
  if (
    filters.projectDir !== undefined &&
    (record.projectDir ?? "-") !== filters.projectDir
  ) {
    return false;
  }
  if (filters.from !== undefined && record.acceptedAt < filters.from) {
    return false;
  }
  if (filters.to !== undefined && record.acceptedAt > filters.to) {
    return false;
  }
  return true;
}

function parseDateTimeLocal(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}

function statusTone(status: PrimaryStatus): string {
  switch (status) {
    case "Running":
      return "running";
    case "Success":
      return "success";
    case "Client error":
      return "client-error";
    case "Server error":
      return "server-error";
    case "Failed":
      return "failed";
    case "Aborted":
      return "aborted";
    case "Auth rejected":
      return "auth-rejected";
    case "Unknown model":
      return "unknown-model";
    case "Model unavailable":
      return "model-unavailable";
    case "Interrupted":
      return "interrupted";
  }
}

export function RequestsPage({
  shell,
  connection,
}: RequestsPageProps) {
  const recordsRef = useRef(new Map<number, RequestLedgerRecord>());
  const filtersRef = useRef<RequestLedgerQuery>({});
  const stopRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const pendingCountRef = useRef(0);
  const reloadGenerationRef = useRef(0);
  const requestIdRef = useRef<HTMLElement | null>(null);
  /** Event-wins ordering: every in-flight query registers one Set here;
   *  live events received after a query was issued add their record ids to
   *  all registered Sets, and the query result never overwrites those ids
   *  (the event is the newer revision). Bounded: each Set lives only for
   *  one query round-trip and is deregistered on every exit path. */
  const pendingEventIdsRef = useRef(new Set<Set<number>>());
  // Narrowed connection facts: `sequence` exists only while connected and
  // doubles as the reconnect signal (every reconnect bumps it).
  const connected = connection.kind === "connected";
  const sequence = connected ? connection.sequence : undefined;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState<number | undefined>();
  const [announcement, setAnnouncement] = useState<string | undefined>();
  const [filters, setFilters] = useState<RequestLedgerQuery>({});
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [filterError, setFilterError] = useState<string | undefined>();
  const [resyncKey, setResyncKey] = useState(0);
  const [busyOlder, setBusyOlder] = useState(false);
  filtersRef.current = filters;

  /** Discard + page-1 query under the current filters. The last issued
   *  reload wins (generation guard), so a filter change during an in-flight
   *  head query can never be overwritten by the stale result. Rows that
   *  received a live event after this query was issued are never
   *  overwritten by its (older) snapshot. */
  const reloadHead = useCallback(
    async (isActive: () => boolean): Promise<void> => {
      const generation = ++reloadGenerationRef.current;
      const pendingEvents = new Set<number>();
      pendingEventIdsRef.current.add(pendingEvents);
      recordsRef.current.clear();
      setSelectedId(undefined);
      setReady(false);
      setError(undefined);
      try {
        const result = await shell.getRequestLedger(filtersRef.current);
        if (!isActive() || generation !== reloadGenerationRef.current) return;
        const map = recordsRef.current;
        for (const record of result.records) {
          if (pendingEvents.has(record.id)) continue;
          if (requestMatchesLedgerFilters(record, filtersRef.current)) {
            map.set(record.id, record);
          }
        }
        setHasMore(result.hasMore);
        setReady(true);
        setVersion((value) => value + 1);
      } catch (loadError) {
        if (!isActive() || generation !== reloadGenerationRef.current) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
        setReady(false);
      } finally {
        pendingEventIdsRef.current.delete(pendingEvents);
      }
    },
    [shell],
  );

  /** Subscription lifecycle: one subscription per connected session,
   *  listen-first, with full resync after any reconnect. */
  useEffect(() => {
    if (!connected) {
      recordsRef.current.clear();
      setSelectedId(undefined);
      setReady(false);
      setHasMore(false);
      setError(undefined);
      setVersion((value) => value + 1);
      return;
    }
    let active = true;
    let flushScheduled = false;
    const upsert = (ledgerEvent: { readonly record: RequestLedgerRecord }) => {
      if (!active) return;
      const record = ledgerEvent.record;
      const map = recordsRef.current;
      // Event-wins, registered BEFORE filter matching: every in-flight
      // query must never overwrite this id with its older snapshot.
      for (const pendingEvents of pendingEventIdsRef.current) {
        pendingEvents.add(record.id);
      }
      // The live stream is unfiltered; the window stays filter-consistent.
      // A newer record that no longer matches the active filters removes
      // any old row for the id (a Running row must not linger after its
      // Success event, and no stale query can reinsert it — its id is in
      // every pending set).
      let changed = false;
      if (!requestMatchesLedgerFilters(record, filtersRef.current)) {
        if (map.has(record.id)) {
          map.delete(record.id);
          changed = true;
        }
      } else {
        map.set(record.id, record);
        changed = true;
        if (map.size > MAX_RENDERED_RECORDS) {
          const overflow = Array.from(map.keys()).sort((a, b) => a - b);
          for (const oldest of overflow.slice(0, map.size - MAX_RENDERED_RECORDS)) {
            map.delete(oldest);
          }
        }
      }
      if (!changed) return;
      pendingCountRef.current += 1;
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          flushScheduled = false;
          if (!active) return;
          const count = pendingCountRef.current;
          pendingCountRef.current = 0;
          setAnnouncement(
            `Updated with ${count} new request${count === 1 ? "" : "s"}.`,
          );
          setVersion((value) => value + 1);
        });
      }
    };
    const onStreamError = (streamError: Error) => {
      if (!active) return;
      setError(`Request ledger stream error: ${streamError.message}`);
      setReady(false);
    };
    (async () => {
      // Drain a previous subscription before opening a new one so the
      // native unsubscribe (if any) always completes first.
      await stopRef.current?.();
      stopRef.current = undefined;
      if (!active) return;
      try {
        stopRef.current = await shell.subscribeRequestLedger(
          upsert,
          onStreamError,
        );
      } catch (subscribeError) {
        if (!active) return;
        setError(
          subscribeError instanceof Error
            ? subscribeError.message
            : String(subscribeError),
        );
        setReady(false);
        return;
      }
      if (!active) return;
      await reloadHead(() => active);
    })();
    return () => {
      active = false;
      void stopRef.current?.();
    };
  }, [connected, sequence, shell, resyncKey, reloadHead]);

  /** Filter apply: a fresh head query under the new filters (the
   *  subscription itself is untouched). The initial mount is skipped — the
   *  subscription effect owns the first head load; unchanged filters (any
   *  reconnect) never repeat the query. */
  const previousFiltersRef = useRef<RequestLedgerQuery | undefined>(undefined);
  useEffect(() => {
    const previous = previousFiltersRef.current;
    previousFiltersRef.current = filters;
    if (previous === undefined) return;
    if (previous === filters) return;
    if (!connectedRef.current) return;
    let active = true;
    void reloadHead(() => active);
    return () => {
      active = false;
    };
  }, [filters, reloadHead]);

  const applyFilters = () => {
    const from = parseDateTimeLocal(draft.from);
    const to = parseDateTimeLocal(draft.to);
    if (from !== undefined && to !== undefined && from > to) {
      setFilterError("The From time must not be after the To time.");
      return;
    }
    setFilterError(undefined);
    setFilters({
      ...(draft.outcome === ""
        ? {}
        : { outcome: draft.outcome as LedgerOutcome }),
      ...(draft.protocolId.trim() === ""
        ? {}
        : { protocolId: draft.protocolId.trim() }),
      ...(draft.providerId.trim() === ""
        ? {}
        : { providerId: draft.providerId.trim() }),
      ...(draft.realModelId.trim() === ""
        ? {}
        : { realModelId: draft.realModelId.trim() }),
      ...(draft.projectDir.trim() === ""
        ? {}
        : { projectDir: draft.projectDir.trim() }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
  };

  const clearFilters = () => {
    setDraft(EMPTY_DRAFT);
    setFilterError(undefined);
    setFilters({});
  };

  const loadOlder = async () => {
    const map = recordsRef.current;
    if (map.size === 0) return;
    const afterId = Math.min(...map.keys());
    const pendingEvents = new Set<number>();
    pendingEventIdsRef.current.add(pendingEvents);
    setBusyOlder(true);
    try {
      const result = await shell.getRequestLedger({
        afterId,
        limit: PAGE_SIZE,
        ...filtersRef.current,
      });
      for (const record of result.records) {
        if (pendingEvents.has(record.id)) continue;
        if (requestMatchesLedgerFilters(record, filtersRef.current)) {
          map.set(record.id, record);
        }
      }
      if (map.size > MAX_RENDERED_RECORDS) {
        const overflow = Array.from(map.keys()).sort((a, b) => a - b);
        for (const oldest of overflow.slice(0, map.size - MAX_RENDERED_RECORDS)) {
          map.delete(oldest);
        }
      }
      setHasMore(result.hasMore);
      setVersion((value) => value + 1);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      pendingEventIdsRef.current.delete(pendingEvents);
      setBusyOlder(false);
    }
  };

  const rows = useMemo(
    () =>
      Array.from(recordsRef.current.values())
        .sort((a, b) => b.id - a.id)
        .map((record) => projectRequestLedger(record)),
    // The version state is the explicit invalidation signal for the map.
    [version],
  );

  const protocolOptions = Array.from(
    new Set(rows.map((row) => row.protocolId)),
  ).sort();
  const providerOptions = Array.from(
    new Set(rows.map((row) => row.providerId).filter((value) => value !== "-")),
  ).sort();
  const modelOptions = Array.from(
    new Set(rows.map((row) => row.realModelId).filter((value) => value !== "-")),
  ).sort();
  const projectOptions = Array.from(
    new Set(rows.map((row) => row.projectDir).filter((value) => value !== "-")),
  ).sort();

  const selected =
    selectedId === undefined ? undefined : recordsRef.current.get(selectedId);
  const selectedProjection =
    selected === undefined ? undefined : projectRequestLedgerDetail(selected);

  const offline =
    connection.kind !== "connected"
      ? "The Control Plane is not connected. Requests reload automatically when it reconnects."
      : undefined;

  const copyRequestId = async () => {
    const value = selected?.requestId ?? "";
    try {
      if (navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {
      // Inline fallback below (e.g. non-secure context).
    }
    const element = requestIdRef.current;
    if (element !== null) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  return (
    <section className="requests-page" aria-label="Requests">
      <div className="requests-toolbar">
        <strong>Requests</strong>
        <span className="requests-count">{rows.length} shown</span>
        <button
          type="button"
          onClick={() => setResyncKey((value) => value + 1)}
        >
          Refresh
        </button>
      </div>

      <form
        className="requests-filters"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <label>
          Outcome
          <select
            name="outcome"
            value={draft.outcome}
            onChange={(event) =>
              setDraft({ ...draft, outcome: event.target.value })
            }
          >
            <option value="">Any</option>
            {OUTCOME_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Protocol
          <input
            list="requests-protocols"
            name="protocolId"
            placeholder="Any"
            value={draft.protocolId}
            onChange={(event) =>
              setDraft({ ...draft, protocolId: event.target.value })
            }
          />
          <datalist id="requests-protocols">
            {protocolOptions.map((value) => (
              <option key={value} value={value}>
                {protocolDisplayName(value)}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          Provider
          <input
            list="requests-providers"
            name="providerId"
            placeholder="Any"
            value={draft.providerId}
            onChange={(event) =>
              setDraft({ ...draft, providerId: event.target.value })
            }
          />
          <datalist id="requests-providers">
            {providerOptions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label>
          Model
          <input
            list="requests-models"
            name="realModelId"
            placeholder="Any"
            value={draft.realModelId}
            onChange={(event) =>
              setDraft({ ...draft, realModelId: event.target.value })
            }
          />
          <datalist id="requests-models">
            {modelOptions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label>
          Project directory
          <input
            list="requests-projects"
            name="projectDir"
            placeholder="Any"
            value={draft.projectDir}
            onChange={(event) =>
              setDraft({ ...draft, projectDir: event.target.value })
            }
          />
          <datalist id="requests-projects">
            {projectOptions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label>
          Accepted from
          <input
            name="from"
            type="datetime-local"
            value={draft.from}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value })
            }
          />
        </label>
        <label>
          Accepted to
          <input
            name="to"
            type="datetime-local"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <div className="requests-filter-actions">
          <button type="submit">Apply</button>
          <button type="button" onClick={clearFilters}>
            Clear
          </button>
        </div>
      </form>

      {filterError === undefined ? null : (
        <p className="client-token-error">{filterError}</p>
      )}
      {offline !== undefined ? (
        <p className="requests-offline">{offline}</p>
      ) : error !== undefined ? (
        <p className="client-token-error" role="alert">
          {error}
        </p>
      ) : !ready ? (
        <p className="requests-loading">Loading requests…</p>
      ) : rows.length === 0 ? (
        <p>No requests yet. Authorized model requests appear here.</p>
      ) : (
        <>
          <div className="requests-table-scroll">
            <table className="requests-table">
              <caption>Requests</caption>
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Protocol</th>
                  <th>Alias</th>
                  <th>Provider / model</th>
                  <th>Status</th>
                  <th>Input</th>
                  <th>Cache</th>
                  <th>Output</th>
                  <th>Cache Hit Rate</th>
                  <th>Accepted</th>
                  <th>Completed</th>
                  <th>Speed</th>
                  <th>Attempts</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td
                      className="request-id-cell"
                      title={row.requestId}
                    >
                      {row.requestId}
                    </td>
                    <td title={row.protocolId}>{row.protocolName}</td>
                    <td>{row.alias}</td>
                    <td>
                      {row.providerId} / {row.realModelId}
                    </td>
                    <td>
                      <span
                        className={`status-badge status-${statusTone(row.status)}`}
                        aria-label={`Status ${row.status}`}
                      >
                        {row.status}
                      </span>
                      {row.status === "Running" ? (
                        <small className="status-secondary">
                          {row.phaseLabel}
                        </small>
                      ) : row.clientHttpStatus !== undefined ? (
                        <small className="status-secondary">
                          {row.clientHttpStatus}
                        </small>
                      ) : null}
                    </td>
                    <td>{row.usage.input}</td>
                    <td>
                      {row.usage.cacheRead}/{row.usage.cacheWrite}
                    </td>
                    <td>{row.usage.output}</td>
                    <td>{row.usage.cacheHitRate ?? "-"}</td>
                    <td>{formatTimestamp(row.acceptedAt)}</td>
                    <td>
                      {row.completedAt === undefined
                        ? "-"
                        : formatTimestamp(row.completedAt)}
                    </td>
                    <td title={row.speedUnavailableReason}>{row.speed}</td>
                    <td>
                      {row.attemptCount > 0
                        ? `${row.attemptCount} attempts`
                        : "-"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="row-view"
                        aria-label={`View request ${row.requestId}`}
                        onClick={() => setSelectedId(row.id)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="requests-pagination">
            <button
              type="button"
              disabled={busyOlder || !hasMore}
              onClick={() => void loadOlder()}
            >
              Older
            </button>
          </div>
        </>
      )}

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>

      {selectedProjection === undefined ? null : (
        <aside
          className="requests-detail"
          role="region"
          aria-label="Request detail"
        >
          <div className="requests-detail-head">
            <button type="button" onClick={() => setSelectedId(undefined)}>
              Back to list
            </button>
            <h3>Request detail</h3>
          </div>
          {selectedProjection.persistenceWarnings > 0 ? (
            <p className="persistence-warning" role="alert">
              Some ledger records could not be persisted (
              {selectedProjection.persistenceWarnings}).
            </p>
          ) : null}
          <dl>
            <div>
              <dt>Primary status</dt>
              <dd>
                <span
                  className={`status-badge status-${statusTone(selectedProjection.status)}`}
                >
                  {selectedProjection.status}
                </span>
                {selectedProjection.status === "Running" ? (
                  <small className="status-secondary">
                    {selectedProjection.phaseLabel}
                  </small>
                ) : selectedProjection.clientHttpStatus !== undefined ? (
                  <small className="status-secondary">
                    {selectedProjection.clientHttpStatus}
                  </small>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Phase</dt>
              <dd>
                {selectedProjection.phaseLabel} ({selectedProjection.phase})
              </dd>
            </div>
            <div>
              <dt>Outcome (raw)</dt>
              <dd>{selectedProjection.outcome}</dd>
            </div>
            <div>
              <dt>Client HTTP status</dt>
              <dd>{selectedProjection.clientHttpStatus ?? "-"}</dd>
            </div>
            <div>
              <dt>Pi stop reason (raw)</dt>
              <dd>{selectedProjection.piStopReason ?? "-"}</dd>
            </div>
            <div>
              <dt>Request ID</dt>
              <dd>
                <code
                  className="request-id-full"
                  ref={requestIdRef}
                >
                  {selectedProjection.requestId}
                </code>{" "}
                <button type="button" onClick={() => void copyRequestId()}>
                  Copy
                </button>
              </dd>
            </div>
            <div>
              <dt>Client protocol</dt>
              <dd title={selectedProjection.protocolId}>
                {selectedProjection.protocolName}
              </dd>
            </div>
            <div>
              <dt>External alias (at request time)</dt>
              <dd>{selectedProjection.alias}</dd>
            </div>
            <div>
              <dt>Provider (at request time)</dt>
              <dd>{selectedProjection.providerId}</dd>
            </div>
            <div>
              <dt>Model (at request time)</dt>
              <dd>{selectedProjection.realModelId}</dd>
            </div>
            <div>
              <dt>Client session</dt>
              <dd>{selectedProjection.clientSessionId}</dd>
            </div>
            <div>
              <dt>Internal session (effective)</dt>
              <dd>{selectedProjection.effectiveSessionId ?? "-"}</dd>
            </div>
            <div>
              <dt>Project directory</dt>
              <dd>{selectedProjection.projectDir}</dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>{formatTimestamp(selectedProjection.acceptedAt)}</dd>
            </div>
            <div>
              <dt>Execution started</dt>
              <dd>
                {selectedProjection.executionStartedAt === undefined
                  ? "-"
                  : formatTimestamp(selectedProjection.executionStartedAt)}
              </dd>
            </div>
            <div>
              <dt>Terminal</dt>
              <dd>
                {selectedProjection.terminalAt === undefined
                  ? "-"
                  : formatTimestamp(selectedProjection.terminalAt)}
              </dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>
                {selectedProjection.completedAt === undefined
                  ? "-"
                  : formatTimestamp(selectedProjection.completedAt)}
              </dd>
            </div>
            <div>
              <dt>Execution duration</dt>
              <dd>
                {selectedProjection.executionDurationMs === undefined
                  ? "-"
                  : formatDuration(selectedProjection.executionDurationMs)}
              </dd>
            </div>
            <div>
              <dt>Total duration</dt>
              <dd>
                {selectedProjection.totalDurationMs === undefined
                  ? "-"
                  : formatDuration(selectedProjection.totalDurationMs)}
              </dd>
            </div>
            <div>
              <dt>Average output speed</dt>
              <dd title={selectedProjection.speedUnavailableReason}>
                {selectedProjection.speed}
              </dd>
            </div>
            <div>
              <dt>Input tokens</dt>
              <dd>{selectedProjection.usage.input}</dd>
            </div>
            <div>
              <dt>Cache read</dt>
              <dd>{selectedProjection.usage.cacheRead}</dd>
            </div>
            <div>
              <dt>Cache write</dt>
              <dd>{selectedProjection.usage.cacheWrite}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{selectedProjection.usage.output}</dd>
            </div>
            <div>
              <dt>Normalized total</dt>
              <dd>{selectedProjection.usage.normalizedTotal ?? "-"}</dd>
            </div>
            <div>
              <dt>Cache hit rate</dt>
              <dd>{selectedProjection.usage.cacheHitRate ?? "-"}</dd>
            </div>
            <div>
              <dt>Usage completeness</dt>
              <dd>
                {selectedProjection.usage.completeness}
                {selectedProjection.usage.reason === undefined
                  ? ""
                  : ` — ${selectedProjection.usage.reason}`}
              </dd>
            </div>
            {selectedProjection.failure === undefined ? null : (
              <div>
                <dt>Failure</dt>
                <dd>
                  {selectedProjection.failure.classification}
                  {selectedProjection.failure.stage === undefined
                    ? ""
                    : ` · ${selectedProjection.failure.stage}`}{" "}
                  (message hash {selectedProjection.failure.messageHash})
                </dd>
              </div>
            )}
          </dl>

          {selectedProjection.attempts.length > 0 ? (
            <section className="requests-facts" aria-label="Invocation attempts">
              <h4>Invocation attempts</h4>
              <ul>
                {selectedProjection.attempts.map((attempt) => (
                  <li key={attempt.attempt}>
                    Attempt #{attempt.attempt} · {attempt.classification} ·{" "}
                    {attempt.stage}
                    {attempt.status === undefined
                      ? ""
                      : ` · HTTP ${attempt.status}`}
                    {attempt.retryable === undefined
                      ? ""
                      : attempt.retryable
                        ? " · retryable"
                        : " · not retryable"}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {selectedProjection.notices.length > 0 ? (
            <section
              className="requests-facts"
              aria-label="Conversion notices"
            >
              <h4>Conversion notices</h4>
              <ul>
                {selectedProjection.notices.map((notice, index) => (
                  <li key={index}>
                    {notice.adapter} ·{" "}
                    {notice.direction === "request" ? "request →" : "response ←"}{" "}
                    · {notice.code}
                    {notice.jsonPath === undefined
                      ? ""
                      : ` · ${notice.jsonPath}`}{" "}
                    ·{" "}
                    {notice.action === "xrepair"
                      ? "repaired automatically"
                      : notice.action}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      )}
    </section>
  );
}
