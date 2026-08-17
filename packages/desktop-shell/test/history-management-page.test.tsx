// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HistoryExportCommand,
  HistoryExportResult,
  HistoryDeleteCommand,
  HistoryDeleteResult,
  HistoryQueryResult,
  HistoryRange,
  PersistenceProjection,
} from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/App.js";
import type { ControlPlaneState } from "../src/control-plane-projection.js";
import type {
  DesktopShellSnapshot,
  WindowsShellHost,
} from "../src/shell-lifecycle.js";
import type { DiagnosticsWarning } from "../src/tauri-shell-runtime.js";

interface HistoryShell {
  queryHistory(range?: HistoryRange): Promise<HistoryQueryResult>;
  executeHistoryExport(command: HistoryExportCommand): Promise<HistoryExportResult>;
  confirmHistoryExport(actionId: string): Promise<HistoryExportResult>;
  executeHistoryDelete(command: HistoryDeleteCommand): Promise<HistoryDeleteResult>;
  confirmHistoryDelete(actionId: string): Promise<HistoryDeleteResult>;
  pickHistoryExportDestination(): Promise<string | undefined>;
}

function connectedState(
  persistence?: PersistenceProjection,
): ControlPlaneState {
  return {
    revision: 1,
    kind: "connected",
    applicationVersion: "0.0.0-test",
    contractVersion: 1,
    sequence: 1,
    modelDataPlane: "running",
    provider: "configured",
    ...(persistence === undefined ? {} : { persistence }),
  };
}

function makeShell(
  history: HistoryShell,
  connection: ControlPlaneState = connectedState(),
): WindowsShellHost & HistoryShell {
  let snapshot: DesktopShellSnapshot = {
    lifecycle: "open",
    activePage: "diagnostics",
    connection,
  };
  return {
    ...history,
    launch: async () => snapshot,
    navigate: (page) => {
      snapshot = { ...snapshot, activePage: page };
      return snapshot;
    },
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listener(snapshot);
      return () => undefined;
    },
    executeRuntimeCommand: async () => snapshot,
    executeSettingsCommand: async () => snapshot,
    acknowledgePersistence: async () => {
      if (
        snapshot.connection.kind === "connected" &&
        snapshot.connection.persistence !== undefined
      ) {
        snapshot = {
          ...snapshot,
          connection: {
            ...snapshot.connection,
            persistence: {
              ...snapshot.connection.persistence,
              acknowledged: true,
            },
          },
        };
      }
      return snapshot;
    },
    getAutoStartStatus: async () => ({ enabled: false }),
    setAutoStartEnabled: async (enabled) => ({ enabled }),
    executeModelsCommand: async () => snapshot,
    executeCatalogCommand: async () => ({
      outcome: "ok",
      snapshot: { version: 1, modelsJsonValid: true, providers: [], refreshErrors: [] },
    }),
    executeAliasCommand: async () => ({
      outcome: "ok",
      state: {
        revision: 0,
        path: "C:\\model-aliases.json",
        present: false,
        valid: false,
        raw: "",
        defaultsVersion: 1,
        catalogVersion: 1,
        effective: { defaultsVersion: 1, aliases: [], errors: [] },
      },
    }),
    executeCodexIntegrationCommand: async () => {
      throw new Error("unused Codex integration command");
    },
    executeClientTokenCommand: async () => ({ outcome: "ok", revision: 1, scopes: [] }),
    executeCredentialCommand: async () => ({
      outcome: "ok",
      revision: 1,
      state: {
        revision: 1,
        path: "C:\\auth.json",
        present: false,
        valid: true,
        providers: [],
      },
    }),
    executeAuthCommand: async () => {
      throw new Error("unused auth command");
    },
    respondAuthInteraction: async () => undefined,
    openUrl: async () => undefined,
    queryDiagnosticsWarnings: async () => [] as readonly DiagnosticsWarning[],
    pickDirectory: async () => undefined,
    getRequestIdentities: async () => ({ records: [] }),
    getRequestLedger: async () => ({ records: [], hasMore: false }),
    subscribeRequestLedger: async () => async () => undefined,
    getAnalytics: async () => {
      throw new Error("unused analytics query");
    },
    dispose: async () => undefined,
  };
}

describe("Diagnostics history management page (Ticket 23)", () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function render(shell: WindowsShellHost): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<App shell={shell} retryConnection={async () => connectedState()} />);
    });
  }

  function button(label: string): HTMLButtonElement {
    const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (entry) => entry.textContent?.includes(label),
    );
    if (match === undefined) throw new Error(`Button not found: ${label}`);
    return match;
  }

  it("keeps the audit-unavailable warning visible after acknowledgment without claiming recovery", async () => {
    const shell = makeShell(
      {
        queryHistory: async () => ({
          range: "all",
          counts: { requestLedger: 0, diagnostics: 0, capture: 0 },
        }),
        executeHistoryExport: async () => ({
          outcome: "failed",
          failure: { code: "internal", message: "unused" },
        }),
        confirmHistoryExport: async () => ({
          outcome: "failed",
          failure: { code: "internal", message: "unused" },
        }),
        executeHistoryDelete: async () => ({
          outcome: "failed",
          deleted: { requestLedger: 0, diagnostics: 0, capture: 0 },
          failures: [
            { authority: "requestLedger", code: "storage_failure", deleted: 0 },
          ],
        }),
        confirmHistoryDelete: async () => ({
          outcome: "failed",
          deleted: { requestLedger: 0, diagnostics: 0, capture: 0 },
          failures: [
            { authority: "requestLedger", code: "storage_failure", deleted: 0 },
          ],
        }),
        pickHistoryExportDestination: async () => undefined,
      },
      connectedState({
        auditUnavailable: true,
        acknowledged: false,
        authorities: [{ authority: "requestLedger", since: 1_756_000_000_000 }],
      }),
    );
    render(shell);
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("History audit storage is unavailable");
    expect(container.textContent).toContain("audit guarantee is unavailable until storage recovers");
    await act(async () => button("Acknowledge").click());

    expect(container.textContent).toContain("Acknowledged");
    expect(container.textContent).toContain("audit guarantee remains unavailable until recovery");
    expect(
      Array.from(container.querySelectorAll("button")).some((entry) =>
        entry.textContent?.includes("Acknowledge"),
      ),
    ).toBe(false);
  });

  it("queries all history and exports structured records without raw capture by default", async () => {
    const queryHistory = vi.fn(async (): Promise<HistoryQueryResult> => ({
      range: "all",
      counts: { requestLedger: 12, diagnostics: 4, capture: 3 },
    }));
    const executeHistoryExport = vi.fn(
      async (): Promise<HistoryExportResult> => ({
        outcome: "ok",
        exportId: "export-001",
        destinationPath: "C:\\exports\\history.json",
        manifest: {
          manifestVersion: 1,
          exportedAt: 1_756_000_000_000,
          sensitive: false,
          auditUnavailable: false,
          sources: {
            requestLedger: { schemaVersion: 2, count: 12 },
            diagnostics: { schemaVersion: 1, count: 4 },
            capture: { included: false, reason: "excluded-by-default" },
          },
        },
      }),
    );
    const shell = makeShell({
      queryHistory,
      executeHistoryExport,
      confirmHistoryExport: async () => {
        throw new Error("unused confirmation");
      },
      executeHistoryDelete: async () => {
        throw new Error("unused deletion");
      },
      confirmHistoryDelete: async () => {
        throw new Error("unused deletion confirmation");
      },
      pickHistoryExportDestination: async () => "C:\\exports\\history.json",
    });

    render(shell);
    await act(async () => undefined);

    expect(queryHistory).toHaveBeenCalledWith("all");
    expect(container.textContent).toContain("12 requests");
    expect(container.textContent).toContain("4 diagnostics");
    expect(container.textContent).toContain("3 raw captures");
    expect(container.textContent).toContain("Raw capture is excluded by default");

    await act(async () => button("Export structured history").click());

    expect(executeHistoryExport).toHaveBeenCalledWith({
      range: "all",
      capture: "excluded",
      destinationPath: "C:\\exports\\history.json",
      overwrite: false,
    });
    expect(container.textContent).toContain("Export completed");
    expect(container.textContent).toContain("Raw capture excluded");
  });

  it("requires a second explicit confirmation before exporting sensitive raw capture", async () => {
    const executeHistoryExport = vi.fn(
      async (): Promise<HistoryExportResult> => ({
        outcome: "confirmation_required",
        actionId: "confirm-sensitive-001",
        confirmationMessage:
          "Exporting raw capture includes request/response bodies, safe headers, and event timing recorded by Deep Diagnostics. Confirm this sensitive export.",
      }),
    );
    const confirmHistoryExport = vi.fn(
      async (): Promise<HistoryExportResult> => ({
        outcome: "ok",
        exportId: "export-sensitive-001",
        destinationPath: "C:\\exports\\sensitive-history.json",
        manifest: {
          manifestVersion: 1,
          exportedAt: 1_756_000_000_000,
          sensitive: true,
          auditUnavailable: false,
          sources: {
            requestLedger: { schemaVersion: 2, count: 2 },
            diagnostics: { schemaVersion: 1, count: 1 },
            capture: { included: true, schemaVersion: 1, count: 1 },
          },
        },
      }),
    );
    const shell = makeShell({
      queryHistory: async () => ({
        range: "all",
        counts: { requestLedger: 2, diagnostics: 1, capture: 1 },
      }),
      executeHistoryExport,
      confirmHistoryExport,
      executeHistoryDelete: async () => {
        throw new Error("unused deletion");
      },
      confirmHistoryDelete: async () => {
        throw new Error("unused deletion confirmation");
      },
      pickHistoryExportDestination: async () =>
        "C:\\exports\\sensitive-history.json",
    });

    render(shell);
    await act(async () => undefined);
    const includeCapture = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
    ).find((input) =>
      input.closest("label")?.textContent?.includes("Include raw capture"),
    );
    if (includeCapture === undefined) throw new Error("Sensitive capture option not found");

    act(() => includeCapture.click());
    await act(async () => button("Export history").click());

    expect(executeHistoryExport).toHaveBeenCalledWith({
      range: "all",
      capture: "included",
      destinationPath: "C:\\exports\\sensitive-history.json",
      overwrite: false,
    });
    expect(confirmHistoryExport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Confirm this sensitive export");

    await act(async () => button("Confirm sensitive export").click());

    expect(confirmHistoryExport).toHaveBeenCalledWith("confirm-sensitive-001");
    expect(container.textContent).toContain("Export completed");
    expect(container.textContent).toContain("Sensitive capture included");
  });

  it("previews an irreversible all-history deletion and only deletes after confirmation", async () => {
    const executeHistoryDelete = vi.fn(
      async (): Promise<HistoryDeleteResult> => ({
        outcome: "confirmation_required",
        actionId: "confirm-delete-001",
        preview: {
          range: "all",
          counts: { requestLedger: 8, diagnostics: 5, capture: 2 },
        },
        confirmationMessage:
          "Deleting history is irreversible. 8 ledger, 5 diagnostics, 2 capture records will be permanently deleted.",
      }),
    );
    const confirmHistoryDelete = vi.fn(
      async (): Promise<HistoryDeleteResult> => ({
        outcome: "completed",
        deleted: { requestLedger: 8, diagnostics: 5, capture: 2 },
      }),
    );
    const shell = makeShell({
      queryHistory: async () => ({
        range: "all",
        counts: { requestLedger: 8, diagnostics: 5, capture: 2 },
      }),
      executeHistoryExport: async () => {
        throw new Error("unused export");
      },
      confirmHistoryExport: async () => {
        throw new Error("unused export confirmation");
      },
      executeHistoryDelete,
      confirmHistoryDelete,
      pickHistoryExportDestination: async () => undefined,
    });

    render(shell);
    await act(async () => undefined);
    await act(async () => button("Delete history").click());

    expect(executeHistoryDelete).toHaveBeenCalledWith({ range: "all" });
    expect(confirmHistoryDelete).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Deleting history is irreversible");
    expect(container.textContent).toContain("8 ledger");

    await act(async () => button("Permanently delete history").click());

    expect(confirmHistoryDelete).toHaveBeenCalledWith("confirm-delete-001");
    expect(container.textContent).toContain("Deletion completed");
    expect(container.textContent).toContain("8 requests");
    expect(container.textContent).toContain("5 diagnostics");
    expect(container.textContent).toContain("2 raw captures");
  });

  it("applies an inclusive UTC calendar-date range to queries and deletion previews", async () => {
    const queryHistory = vi.fn(
      async (range?: HistoryRange): Promise<HistoryQueryResult> => ({
        range: range ?? "all",
        counts: { requestLedger: 3, diagnostics: 2, capture: 1 },
      }),
    );
    const executeHistoryDelete = vi.fn(
      async (): Promise<HistoryDeleteResult> => ({
        outcome: "confirmation_required",
        actionId: "confirm-range-delete",
        preview: {
          range: { fromMs: 1_785_542_400_000, toMs: 1_786_406_400_000 },
          counts: { requestLedger: 3, diagnostics: 2, capture: 1 },
        },
        confirmationMessage: "Deleting history is irreversible.",
      }),
    );
    const shell = makeShell({
      queryHistory,
      executeHistoryExport: async () => {
        throw new Error("unused export");
      },
      confirmHistoryExport: async () => {
        throw new Error("unused export confirmation");
      },
      executeHistoryDelete,
      confirmHistoryDelete: async () => {
        throw new Error("unused deletion confirmation");
      },
      pickHistoryExportDestination: async () => undefined,
    });

    render(shell);
    await act(async () => undefined);
    const rangeMode = container.querySelector<HTMLSelectElement>(
      'select[aria-label="History range"]',
    );
    const from = container.querySelector<HTMLInputElement>('input[aria-label="Start date"]');
    const to = container.querySelector<HTMLInputElement>('input[aria-label="End date"]');
    if (rangeMode === null || from === null || to === null) {
      throw new Error("History range controls not found");
    }

    act(() => {
      rangeMode.value = "range";
      rangeMode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      from.value = "2026-08-01";
      from.dispatchEvent(new Event("input", { bubbles: true }));
      to.value = "2026-08-10";
      to.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Apply range").click());

    const expectedRange = {
      fromMs: 1_785_542_400_000,
      toMs: 1_786_406_400_000,
    };
    expect(queryHistory).toHaveBeenLastCalledWith(expectedRange);
    await act(async () => button("Delete history").click());
    expect(executeHistoryDelete).toHaveBeenCalledWith({ range: expectedRange });
  });

  it("never overwrites an existing export until the user explicitly confirms replacement", async () => {
    const executeHistoryExport = vi
      .fn<HistoryShell["executeHistoryExport"]>()
      .mockResolvedValueOnce({
        outcome: "failed",
        failure: {
          code: "destination_exists",
          message: "The export destination already exists",
        },
      })
      .mockResolvedValueOnce({
        outcome: "ok",
        exportId: "export-replaced",
        destinationPath: "C:\\exports\\history.json",
        manifest: {
          manifestVersion: 1,
          exportedAt: 1_756_000_000_000,
          sensitive: false,
          auditUnavailable: false,
          sources: {
            requestLedger: { schemaVersion: 2, count: 1 },
            diagnostics: { schemaVersion: 1, count: 1 },
            capture: { included: false, reason: "excluded-by-default" },
          },
        },
      });
    const shell = makeShell({
      queryHistory: async () => ({
        range: "all",
        counts: { requestLedger: 1, diagnostics: 1, capture: 0 },
      }),
      executeHistoryExport,
      confirmHistoryExport: async () => {
        throw new Error("unused export confirmation");
      },
      executeHistoryDelete: async () => ({ outcome: "failed" }),
      confirmHistoryDelete: async () => ({ outcome: "failed" }),
      pickHistoryExportDestination: async () => "C:\\exports\\history.json",
    });

    render(shell);
    await act(async () => undefined);
    await act(async () => button("Export structured history").click());

    expect(executeHistoryExport).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("already exists");
    await act(async () => button("Replace existing export").click());

    expect(executeHistoryExport).toHaveBeenLastCalledWith({
      range: "all",
      capture: "excluded",
      destinationPath: "C:\\exports\\history.json",
      overwrite: true,
    });
    expect(container.textContent).toContain("Export completed");
  });
});
