import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AnalyticsFilter,
  AnalyticsOptionsResult,
  AnalyticsSummary,
  DesktopControlPlaneApi,
  LuckyTokenDesktopApi,
  RequestJourneySummary,
} from "../../shared/desktop-api.js";

const REQUEST_PAGE_SIZE = 1_000;
const RECONCILIATION_INTERVAL_MS = 15_000;

export interface OverviewReadModelInput {
  readonly enabled: boolean;
  readonly from: number;
  readonly to: number;
  readonly filters?: AnalyticsFilter;
}

export interface OverviewReadModelSnapshot {
  readonly records: readonly RequestJourneySummary[];
  readonly summary: AnalyticsSummary | undefined;
  readonly options: AnalyticsOptionsResult | undefined;
  readonly historyUnavailable: boolean;
  readonly analyticsUnavailable: boolean;
  readonly refreshing: boolean;
}

export interface OverviewReadModel extends OverviewReadModelSnapshot {
  /** Reconcile the complete Overview projection from the authoritative store. */
  readonly refresh: () => void;
}

const EMPTY_SNAPSHOT: OverviewReadModelSnapshot = Object.freeze({
  records: Object.freeze([]),
  summary: undefined,
  options: undefined,
  historyUnavailable: false,
  analyticsUnavailable: false,
  refreshing: false,
});

function isOverviewRequest(record: RequestJourneySummary): boolean {
  return record.operation !== "unsupported_transport";
}

function inputKey(input: OverviewReadModelInput): string {
  return JSON.stringify([
    input.enabled,
    input.from,
    input.to,
    input.filters ?? null,
  ]);
}

function mergeSummaries(
  current: readonly RequestJourneySummary[],
  incoming: readonly RequestJourneySummary[],
): RequestJourneySummary[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => right.id - left.id);
}

async function queryAllRequestJourneys(
  control: DesktopControlPlaneApi,
  input: OverviewReadModelInput,
): Promise<readonly RequestJourneySummary[] | "unavailable"> {
  const records: RequestJourneySummary[] = [];
  let afterId: number | undefined;
  for (;;) {
    const response = await control.queryRequestJourneys({
      limit: REQUEST_PAGE_SIZE,
      from: input.from,
      to: input.to,
      excludeOperations: ["unsupported_transport"],
      ...(afterId === undefined ? {} : { afterId }),
    });
    if (response.outcome === "unavailable") return "unavailable";
    records.push(...response.result.records.filter(isOverviewRequest));
    const newest = response.result.records.at(-1)?.id;
    if (!response.result.hasMore || newest === undefined || newest === afterId) break;
    afterId = newest;
  }
  return records;
}

type RecordsResult =
  | { readonly outcome: "ok"; readonly records: readonly RequestJourneySummary[] }
  | { readonly outcome: "unavailable" };

type SummaryResult =
  | { readonly outcome: "ok"; readonly summary: AnalyticsSummary }
  | { readonly outcome: "unavailable" };

type OptionsResult =
  | { readonly outcome: "ok"; readonly options: AnalyticsOptionsResult }
  | { readonly outcome: "unavailable" };

/**
 * Single writer for the Overview projection. Events are low-latency
 * invalidation hints; persisted reads remain authoritative. Every trigger
 * (input, event, timer, or user action) is coalesced through synchronize().
 */
class OverviewCoordinator {
  readonly #control: DesktopControlPlaneApi;
  readonly #publish: (snapshot: OverviewReadModelSnapshot) => void;
  readonly #observed = new Map<number, RequestJourneySummary>();
  #snapshot = EMPTY_SNAPSHOT;
  #input: OverviewReadModelInput | undefined;
  #inputKey: string | undefined;
  #requestedRevision = 0;
  #running = false;
  #disposed = false;
  #unsubscribe: (() => void) | undefined;
  #reconciliationTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    control: DesktopControlPlaneApi,
    publish: (snapshot: OverviewReadModelSnapshot) => void,
  ) {
    this.#control = control;
    this.#publish = publish;
  }

  setInput(input: OverviewReadModelInput): void {
    if (this.#disposed) return;
    const nextKey = inputKey(input);
    if (this.#inputKey === nextKey) return;
    this.#input = input;
    this.#inputKey = nextKey;
    this.#observed.clear();
    this.#requestedRevision += 1;
    if (!input.enabled || input.from >= input.to) {
      this.#stopObservation();
      this.#snapshot = EMPTY_SNAPSHOT;
      this.#publish(this.#snapshot);
      return;
    }
    this.#startObservation();
    this.#requestSynchronization();
  }

  refresh(): void {
    if (this.#input?.enabled !== true || this.#disposed) return;
    this.#requestedRevision += 1;
    this.#requestSynchronization();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#requestedRevision += 1;
    this.#stopObservation();
  }

  #startObservation(): void {
    if (this.#unsubscribe === undefined) {
      this.#unsubscribe = this.#control.onRequestJourneys((record) => {
        const input = this.#input;
        if (
          this.#disposed ||
          input === undefined ||
          !input.enabled ||
          !isOverviewRequest(record) ||
          record.createdAt < input.from ||
          record.createdAt >= input.to
        ) {
          return;
        }
        this.#observed.set(record.id, record);
        this.#snapshot = Object.freeze({
          ...this.#snapshot,
          records: Object.freeze(mergeSummaries(this.#snapshot.records, [record])),
        });
        this.#publish(this.#snapshot);
        // Publication follows persistence, so this reconciliation includes the
        // terminal row in analytics as well as in the Request list.
        this.refresh();
      });
    }
    if (this.#reconciliationTimer === undefined) {
      this.#reconciliationTimer = setInterval(
        () => this.refresh(),
        RECONCILIATION_INTERVAL_MS,
      );
    }
  }

  #stopObservation(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#reconciliationTimer !== undefined) {
      clearInterval(this.#reconciliationTimer);
      this.#reconciliationTimer = undefined;
    }
  }

  #requestSynchronization(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#synchronize().finally(() => {
      this.#running = false;
      if (
        !this.#disposed &&
        this.#input?.enabled === true &&
        this.#snapshot.refreshing
      ) {
        this.#requestSynchronization();
      }
    });
  }

  async #synchronize(): Promise<void> {
    while (!this.#disposed && this.#input?.enabled === true) {
      const revision = this.#requestedRevision;
      const input = this.#input;
      this.#snapshot = Object.freeze({ ...this.#snapshot, refreshing: true });
      this.#publish(this.#snapshot);

      const [recordsResult, summaryResult, optionsResult] = await Promise.all([
        queryAllRequestJourneys(this.#control, input).then<RecordsResult, RecordsResult>(
          (records) => records === "unavailable"
            ? { outcome: "unavailable" }
            : { outcome: "ok", records },
          () => ({ outcome: "unavailable" }),
        ),
        this.#control.getAnalytics({
          version: 2,
          command: "summary",
          from: input.from,
          to: input.to,
          ...(input.filters === undefined ? {} : { filters: input.filters }),
        }).then<SummaryResult, SummaryResult>(
          (result) => "outcome" in result || result.command !== "summary"
            ? { outcome: "unavailable" }
            : { outcome: "ok", summary: result.totals },
          () => ({ outcome: "unavailable" }),
        ),
        this.#control.getAnalytics({
          version: 2,
          command: "options",
          from: input.from,
          to: input.to,
        }).then<OptionsResult, OptionsResult>(
          (result) => "outcome" in result || result.command !== "options"
            ? { outcome: "unavailable" }
            : { outcome: "ok", options: result },
          () => ({ outcome: "unavailable" }),
        ),
      ]);

      if (this.#disposed || revision !== this.#requestedRevision) continue;
      const records = recordsResult.outcome === "ok"
        ? mergeSummaries(recordsResult.records, [...this.#observed.values()])
        : this.#snapshot.records;
      this.#snapshot = Object.freeze({
        records: Object.freeze(records),
        summary: summaryResult.outcome === "ok"
          ? summaryResult.summary
          : this.#snapshot.summary,
        options: optionsResult.outcome === "ok"
          ? optionsResult.options
          : this.#snapshot.options,
        historyUnavailable: recordsResult.outcome === "unavailable",
        analyticsUnavailable:
          summaryResult.outcome === "unavailable" ||
          optionsResult.outcome === "unavailable",
        refreshing: false,
      });
      this.#publish(this.#snapshot);
      return;
    }
  }
}

export function useOverviewReadModel(
  api: LuckyTokenDesktopApi,
  input: OverviewReadModelInput,
): OverviewReadModel {
  const [snapshot, setSnapshot] = useState<OverviewReadModelSnapshot>(EMPTY_SNAPSHOT);
  const coordinatorRef = useRef<OverviewCoordinator | undefined>(undefined);
  const stableInput = useMemo(
    () => input,
    [input.enabled, input.filters, input.from, input.to],
  );

  useEffect(() => {
    const coordinator = new OverviewCoordinator(api.control, setSnapshot);
    coordinatorRef.current = coordinator;
    coordinator.setInput(stableInput);
    return () => {
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = undefined;
    };
  }, [api]);

  useEffect(() => {
    coordinatorRef.current?.setInput(stableInput);
  }, [stableInput]);

  const refresh = useCallback(() => coordinatorRef.current?.refresh(), []);
  return useMemo(() => ({ ...snapshot, refresh }), [refresh, snapshot]);
}
