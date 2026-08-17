// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BackupCreateCommand,
  BackupResult,
  RecoveryProjection,
} from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/App.js";
import type { ControlPlaneState } from "../src/control-plane-projection.js";
import type {
  DesktopShellSnapshot,
  WindowsShellHost,
} from "../src/shell-lifecycle.js";

function connectedState(recovery?: RecoveryProjection): ControlPlaneState {
  return {
    revision: 1,
    kind: "connected",
    applicationVersion: "0.0.0-test",
    contractVersion: 1,
    sequence: 1,
    modelDataPlane: recovery === undefined ? "running" : "stopped",
    provider: recovery === undefined ? "configured" : "unconfigured",
    ...(recovery === undefined ? {} : { recovery }),
  };
}

function makeShell(options: {
  readonly recovery?: RecoveryProjection;
  readonly executeBackup?: (command: BackupCreateCommand) => Promise<BackupResult>;
  readonly confirmBackup?: (actionId: string) => Promise<BackupResult>;
}): WindowsShellHost {
  let snapshot: DesktopShellSnapshot = {
    lifecycle: "open",
    activePage: options.recovery === undefined ? "settings-developer-lab" : "dashboard",
    connection: connectedState(options.recovery),
  };
  return {
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
    acknowledgePersistence: async () => snapshot,
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
      state: { revision: 1, path: "C:\\auth.json", present: false, valid: true, providers: [] },
    }),
    executeAuthCommand: async () => {
      throw new Error("unused auth command");
    },
    respondAuthInteraction: async () => undefined,
    openUrl: async () => undefined,
    queryDiagnosticsWarnings: async () => [],
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
      failures: [{ authority: "requestLedger", code: "internal", deleted: 0 }],
    }),
    confirmHistoryDelete: async () => ({
      outcome: "failed",
      deleted: { requestLedger: 0, diagnostics: 0, capture: 0 },
      failures: [{ authority: "requestLedger", code: "internal", deleted: 0 }],
    }),
    pickHistoryExportDestination: async () => undefined,
    pickDirectory: async () => undefined,
    getRequestIdentities: async () => ({ records: [] }),
    getRequestLedger: async () => ({ records: [], hasMore: false }),
    subscribeRequestLedger: async () => async () => undefined,
    getAnalytics: async () => {
      throw new Error("unused analytics query");
    },
    ...(options.executeBackup === undefined
      ? {}
      : { executeBackup: options.executeBackup }),
    ...(options.confirmBackup === undefined
      ? {}
      : { confirmBackup: options.confirmBackup }),
    pickBackupDestination: async () => "C:\\exports\\backup.json",
    dispose: async () => undefined,
  };
}

describe("Ticket 24 backup and recovery UI", () => {
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

  it("creates an ordinary redacted backup through the shell contract", async () => {
    const executeBackup = vi.fn(async (): Promise<BackupResult> => ({
      outcome: "ok",
      destinationPath: "C:\\exports\\backup.json",
      manifest: {
        format: "luckytoken-backup",
        formatVersion: 1,
        createdAt: 1_756_000_000_000,
        sensitive: false,
        entries: [
          { id: "config", contract: "luckytoken-config", version: "luckytoken-config-v1", sensitive: false },
        ],
      },
    }));
    render(makeShell({ executeBackup }));
    await act(async () => Promise.resolve());
    await act(async () => button("Create ordinary backup").click());

    expect(executeBackup).toHaveBeenCalledWith({
      mode: "ordinary",
      destinationPath: "C:\\exports\\backup.json",
      overwrite: false,
    });
    expect(container.textContent).toContain("Backup created: 1 versioned sources, ordinary redacted");
  });

  it("requires the backend confirmation before publishing a full-sensitive backup", async () => {
    const executeBackup = vi.fn(async (): Promise<BackupResult> => ({
      outcome: "confirmation_required",
      actionId: "backup-confirm-1",
      confirmationMessage: "This includes credentials and permanent history.",
    }));
    const confirmBackup = vi.fn(async (): Promise<BackupResult> => ({
      outcome: "ok",
      destinationPath: "C:\\exports\\backup.json",
      manifest: {
        format: "luckytoken-backup",
        formatVersion: 1,
        createdAt: 1_756_000_000_000,
        sensitive: true,
        entries: [
          { id: "auth", contract: "pi-auth", version: 1, sensitive: true },
        ],
      },
    }));
    render(makeShell({ executeBackup, confirmBackup }));
    await act(async () => Promise.resolve());
    await act(async () => button("Create full-sensitive backup").click());
    expect(container.textContent).toContain("This includes credentials and permanent history.");
    await act(async () => button("Confirm full-sensitive backup").click());

    expect(confirmBackup).toHaveBeenCalledWith("backup-confirm-1");
    expect(container.textContent).toContain("1 versioned sources, full-sensitive");
  });

  it("keeps the dashboard open with exact incompatible-file recovery facts", async () => {
    const recovery: RecoveryProjection = {
      mode: "incompatible_configuration",
      issues: [
        {
          path: "C:\\LuckyToken\\config.json",
          contract: "luckytoken-config",
          foundVersion: "luckytoken-config-v2",
          expectedVersion: "luckytoken-config-v1",
          validationError: "Unsupported schema version.",
        },
      ],
    };
    render(makeShell({ recovery }));
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("Configuration recovery required");
    expect(container.textContent).toContain("C:\\LuckyToken\\config.json");
    expect(container.textContent).toContain("luckytoken-config-v2");
    expect(container.textContent).toContain("luckytoken-config-v1");
    expect(container.textContent).toContain("model gateway is stopped");
  });
});
