import { randomUUID } from "node:crypto";

import type {
  HistoryCommand,
  HistoryCommandResult,
  HistoryDeleteResult,
  HistoryExportCommand,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
} from "@luckytoken/application-control-plane/control-plane";
import type { DiagnosticsManagementAuthority } from "../diagnostics/index.js";
import { runHistoryExport } from "./export.js";

type HistoryDiagnosticsAuthority = Pick<
  DiagnosticsManagementAuthority,
  "countHistory" | "deleteHistory" | "createBackupSnapshot"
>;

export interface HistoryAuthorityOptions {
  readonly diagnostics: HistoryDiagnosticsAuthority;
  readonly ownedRoots: readonly string[];
  readonly applicationVersion: string;
  readonly now?: () => number;
  readonly createActionId?: () => string;
  readonly createExportId?: () => string;
  readonly maxExportBytes?: number;
  readonly renameFile?: (fromPath: string, toPath: string) => Promise<void>;
}

export interface HistoryAuthority {
  handle(command: HistoryCommand, signal: AbortSignal): Promise<HistoryCommandResult>;
}

const EXPORT_CONFIRMATION_MESSAGE =
  "This export contains redacted Request Journey artifacts. Confirm this sensitive history export.";

export function createHistoryAuthority(options: HistoryAuthorityOptions): HistoryAuthority {
  const createActionId = options.createActionId ?? randomUUID;
  let pendingExport:
    | { readonly actionId: string; readonly command: HistoryExportCommand }
    | undefined;
  let pendingDelete:
    | { readonly actionId: string; readonly range: HistoryRange }
    | undefined;

  const handle = async (
    command: HistoryCommand,
    signal: AbortSignal,
  ): Promise<HistoryCommandResult> => {
    if (command.command === "query") {
      const range = command.range ?? "all";
      const result: HistoryQueryResult = Object.freeze({
        range,
        counts: Object.freeze(await options.diagnostics.countHistory(range)),
      });
      return { kind: "query", result };
    }
    if (command.command === "export") {
      pendingExport = Object.freeze({ actionId: createActionId(), command });
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
        throw new Error("No matching history export confirmation is pending");
      }
      pendingExport = undefined;
      const result = await runHistoryExport(
        { ...gate.command, signal },
        {
          diagnostics: options.diagnostics,
          ownedRoots: options.ownedRoots,
          applicationVersion: options.applicationVersion,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.createExportId === undefined ? {} : { createExportId: options.createExportId }),
          ...(options.maxExportBytes === undefined ? {} : { maxBytes: options.maxExportBytes }),
          ...(options.renameFile === undefined ? {} : { renameFile: options.renameFile }),
        },
      );
      return { kind: "export", result };
    }
    if (command.command === "delete") {
      const counts = Object.freeze(await options.diagnostics.countHistory(command.range));
      const preview = Object.freeze({ range: command.range, counts });
      pendingDelete = Object.freeze({ actionId: createActionId(), range: command.range });
      const result: HistoryDeleteResult = Object.freeze({
        outcome: "confirmation_required",
        actionId: pendingDelete.actionId,
        preview,
        confirmationMessage: `Deleting history is irreversible. ${counts.requestJourneys} Request Journeys and ${counts.runtimeEvents} Runtime Events will be permanently deleted.`,
      });
      return { kind: "delete", result };
    }
    const gate = pendingDelete;
    if (gate === undefined || gate.actionId !== command.actionId) {
      throw new Error("No matching history deletion confirmation is pending");
    }
    pendingDelete = undefined;
    try {
      const deleted = await options.diagnostics.deleteHistory(gate.range);
      return {
        kind: "delete",
        result: Object.freeze({ outcome: "completed", deleted: deleted.deleted }),
      };
    } catch {
      return {
        kind: "delete",
        result: Object.freeze({
          outcome: "failed",
          failure: Object.freeze({
            code: "storage_failure",
            message: "History could not be deleted.",
          }),
        }),
      };
    }
  };
  return Object.freeze({ handle });
}
