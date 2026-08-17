/**
 * History authority (Ticket 23) — the one owner-process authority behind
 * the versioned Control Plane history surface: per-authority count preview,
 * the versioned export workflow (default-excluded capture; a second
 * explicit sensitive confirmation to include it), the irreversible
 * range/all deletion gate with a count preview, and the audit-unavailable
 * acknowledgment.
 *
 * Confirmation gates are single-use (one actionId = one execution) and
 * shaped like the settings LAN gate: a command returns
 * `confirmation_required` with a fixed message, and a later
 * `confirm {actionId}` executes. A new command replaces a pending gate.
 *
 * The stores stay authoritative: the authority never interprets records,
 * only ranges; every count, query, and delete is a store-owned operation.
 */
import type {
  HistoryCommand,
  HistoryCommandResult,
  HistoryCounts,
  HistoryDeleteResult,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
  PersistenceAuthorityId,
} from "@luckytoken/application-control-plane/control-plane";
import { randomUUID } from "node:crypto";
import { deleteResult, runHistoryDelete } from "./delete.js";
import {
  runHistoryExport,
  type HistoryExportInput,
  type HistoryExportSources,
  type HistoryExporterOptions,
} from "./export.js";
import type { PersistenceDegradationAuthority } from "../persistence-degradation/authority.js";

export interface HistoryAuthorityOptions {
  readonly sources: HistoryExportSources;
  /** The degradation authority: export manifests report its audit truth and
   *  acknowledgment routes to it. */
  readonly persistence: PersistenceDegradationAuthority;
  /** LuckyToken-owned directory trees an export may never write into. */
  readonly ownedRoots: readonly string[];
  readonly applicationVersion: string;
  readonly now?: () => number;
  readonly createActionId?: () => string;
  readonly createExportId?: () => string;
  readonly maxExportBytes?: number;
  readonly renameFile?: (fromPath: string, toPath: string) => Promise<void>;
  /** Narrow sanitized source-fault seam: reported to the degradation
   *  authority so a failing source becomes visible. */
  readonly onSourceFailure?: (
    authority: PersistenceAuthorityId,
    fact?: { readonly requestId?: string },
  ) => void;
}

export interface HistoryAuthority {
  handle(command: HistoryCommand, signal: AbortSignal): Promise<HistoryCommandResult>;
}

interface PendingExportGate {
  readonly actionId: string;
  readonly input: Omit<HistoryExportInput, "signal">;
}

interface PendingDeleteGate {
  readonly actionId: string;
  readonly range: HistoryRange;
  readonly preview: HistoryQueryResult;
}

const EXPORT_CONFIRMATION_MESSAGE =
  "Exporting raw capture includes request/response bodies, safe headers, and event timing recorded by Deep Diagnostics. Confirm this sensitive export.";

export function createHistoryAuthority(
  options: HistoryAuthorityOptions,
): HistoryAuthority {
  const createActionId = options.createActionId ?? randomUUID;
  let pendingExport: PendingExportGate | undefined;
  let pendingDelete: PendingDeleteGate | undefined;

  /** The exporter options assembled once (exactOptionalPropertyTypes). */
  const exporterOptions = (): HistoryExporterOptions => ({
    sources: options.sources,
    ownedRoots: options.ownedRoots,
    applicationVersion: options.applicationVersion,
    auditUnavailable: options.persistence.state().auditUnavailable,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.createExportId === undefined
      ? {}
      : { createExportId: options.createExportId }),
    ...(options.maxExportBytes === undefined
      ? {}
      : { maxBytes: options.maxExportBytes }),
    ...(options.renameFile === undefined
      ? {}
      : { renameFile: options.renameFile }),
    ...(options.onSourceFailure === undefined
      ? {}
      : { onSourceFailure: options.onSourceFailure }),
  });

  /** Per-authority eligible counts over one half-open range. A throwing
   *  store contributes 0 (the preview is informational; the deletion/
   *  export paths report the authoritative failure). */
  const countRange = (range: HistoryRange): HistoryCounts => {
    const fromMs = range === "all" ? undefined : range.fromMs;
    const toMs = range === "all" ? undefined : range.toMs;
    const count = (
      authority: PersistenceAuthorityId,
      store: { countRange(fromMs?: number, toMs?: number): number },
    ): number => {
      try {
        return store.countRange(fromMs, toMs);
      } catch {
        options.onSourceFailure?.(authority);
        return 0;
      }
    };
    return Object.freeze({
      requestLedger: count("requestLedger", options.sources.ledger),
      diagnostics: count("diagnostics", options.sources.diagnostics),
      capture: count("capture", options.sources.capture),
    });
  };

  const handle = async (
    command: HistoryCommand,
    signal: AbortSignal,
  ): Promise<HistoryCommandResult> => {
    if (command.command === "query") {
      const range: HistoryRange = command.range ?? "all";
      const result: HistoryQueryResult = Object.freeze({
        range,
        counts: countRange(range),
      });
      return { kind: "query", result };
    }
    if (command.command === "export") {
      const input: Omit<HistoryExportInput, "signal"> = {
        range: command.range,
        capture: command.capture,
        destinationPath: command.destinationPath,
        overwrite: command.overwrite,
      };
      if (command.capture === "excluded") {
        const result = await runHistoryExport(
          { ...input, signal },
          exporterOptions(),
        );
        return { kind: "export", result };
      }
      // Sensitive capture requires a second explicit confirmation; the
      // pending gate is single-use and replaces any earlier gate.
      pendingExport = Object.freeze({
        actionId: createActionId(),
        input,
      });
      const result: HistoryExportResult = Object.freeze({
        outcome: "confirmation_required",
        actionId: pendingExport.actionId,
        confirmationMessage: EXPORT_CONFIRMATION_MESSAGE,
      });
      return { kind: "export", result };
    }
    if (command.command === "export_confirm") {
      const gate = pendingExport;
      if (gate === undefined || gate.actionId !== command.actionId) {
        throw new Error(
          "No matching history export confirmation is pending for that action",
        );
      }
      pendingExport = undefined;
      const result = await runHistoryExport(
        { ...gate.input, signal },
        exporterOptions(),
      );
      return { kind: "export", result };
    }
    if (command.command === "delete") {
      const preview: HistoryQueryResult = Object.freeze({
        range: command.range,
        counts: countRange(command.range),
      });
      const total =
        preview.counts.requestLedger +
        preview.counts.diagnostics +
        preview.counts.capture;
      pendingDelete = Object.freeze({
        actionId: createActionId(),
        range: command.range,
        preview,
      });
      const result: HistoryDeleteResult = Object.freeze({
        outcome: "confirmation_required",
        actionId: pendingDelete.actionId,
        confirmationMessage: `Deleting history is irreversible. ${preview.counts.requestLedger} ledger, ${preview.counts.diagnostics} diagnostics, ${preview.counts.capture} capture record${total === 1 ? "" : "s"} will be permanently deleted.`,
        preview,
      });
      return { kind: "delete", result };
    }
    if (command.command === "delete_confirm") {
      const gate = pendingDelete;
      if (gate === undefined || gate.actionId !== command.actionId) {
        throw new Error(
          "No matching history deletion confirmation is pending for that action",
        );
      }
      pendingDelete = undefined;
      const attempt = runHistoryDelete(
        options.sources,
        gate.range,
        options.onSourceFailure,
      );
      return { kind: "delete", result: deleteResult(attempt) };
    }
    // acknowledge
    const outcome = options.persistence.acknowledge();
    return {
      kind: "acknowledge",
      result: Object.freeze({ outcome }),
    };
  };

  return Object.freeze({ handle });
}
