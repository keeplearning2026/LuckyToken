/**
 * History deletion execution (Ticket 23) — per-authority, deterministic,
 * truthful.
 *
 * Three separate SQLite/WAL files cannot delete atomically; the result is
 * therefore an explicit per-authority report. Each store executes its own
 * bounded DELETE in its own transaction and reports its own committed row
 * count; a store that fails after another committed is reported as
 * `partial_failure` with exact per-authority counts and failure entries —
 * never a blanket "deleted". The order is deterministic (ledger →
 * diagnostics → capture) so a partial failure is reproducible, and each
 * authority's operation is idempotent (deleting an already-deleted range
 * deletes nothing).
 *
 * Deletion only ever calls the three stores' `deleteRange` methods:
 * settings.json, models.json, public-models.json, Provider Profile records,
 * Client Token files, and failure journals are structurally untouched
 * (pinned by tests with byte-compare).
 */
import type {
  HistoryCounts,
  HistoryDeleteAuthorityFailure,
  HistoryDeleteResult,
  HistoryRange,
  PersistenceAuthorityId,
} from "@luckytoken/application-control-plane/control-plane";
import type { HistoryExportSources } from "./export.js";

export interface HistoryDeleteAttempt {
  readonly outcome: "completed" | "partial_failure" | "failed";
  readonly deleted: HistoryCounts;
  readonly failures: readonly HistoryDeleteAuthorityFailure[];
}

/** Deterministic per-authority deletion order; documented so a partial
 *  failure is reproducible. */
const AUTHORITY_ORDER: readonly PersistenceAuthorityId[] = Object.freeze([
  "requestLedger",
  "diagnostics",
  "capture",
]);

function emptyCounts(): HistoryCounts {
  return Object.freeze({
    requestLedger: 0,
    diagnostics: 0,
    capture: 0,
  });
}

export function runHistoryDelete(
  sources: HistoryExportSources,
  range: HistoryRange,
  onSourceFailure?: (
    authority: PersistenceAuthorityId,
    fact?: { readonly requestId?: string },
  ) => void,
): HistoryDeleteAttempt {
  const fromMs = range === "all" ? undefined : range.fromMs;
  const toMs = range === "all" ? undefined : range.toMs;
  const deleted = { ...emptyCounts() };
  const failures: HistoryDeleteAuthorityFailure[] = [];
  const deleteAuthority = (
    authority: PersistenceAuthorityId,
    execute: () => { readonly deleted: number },
  ): void => {
    try {
      const result = execute();
      deleted[authority] = Number(result.deleted);
    } catch {
      // The per-authority truth: this authority committed nothing; the
      // failure is reported with its own count and never hides an earlier
      // authority's committed rows.
      failures.push(
        Object.freeze({
          authority,
          code: "storage_failure",
          deleted: deleted[authority],
        }),
      );
      onSourceFailure?.(authority);
    }
  };
  deleteAuthority("requestLedger", () =>
    sources.ledger.deleteRange(fromMs, toMs),
  );
  deleteAuthority("diagnostics", () =>
    sources.diagnostics.deleteRange(fromMs, toMs),
  );
  deleteAuthority("capture", () =>
    sources.capture.deleteRange(fromMs, toMs),
  );
  const outcome =
    failures.length === 0
      ? "completed"
      : failures.length === AUTHORITY_ORDER.length
        ? "failed"
        : "partial_failure";
  return Object.freeze({
    outcome,
    deleted: Object.freeze(deleted),
    failures: Object.freeze(failures),
  });
}

export function deleteResult(
  attempt: HistoryDeleteAttempt,
): HistoryDeleteResult {
  return Object.freeze({
    outcome: attempt.outcome,
    deleted: attempt.deleted,
    ...(attempt.failures.length === 0
      ? {}
      : { failures: attempt.failures }),
  });
}
