// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SettingsCommand } from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/App.js";
import type { ControlPlaneState } from "../src/control-plane-projection.js";
import type {
  DesktopShellSnapshot,
  WindowsShellHost,
} from "../src/shell-lifecycle.js";
import type { DiagnosticsWarning } from "../src/tauri-shell-runtime.js";

/**
 * Ticket 22 desktop seam: the global Deep Diagnostics capture toggle is a
 * registered hot-apply setting rendered in the Settings / Developer Lab
 * page; toggling it issues exactly one settings set command with the
 * registered key through the shell host.
 */
const DEEP_CAPTURE_SETTING = "diagnostics.deepCapture.enabled";

function connectedState(enabled: boolean): ControlPlaneState {
  return {
    revision: 1,
    kind: "connected",
    applicationVersion: "0.0.0-test",
    contractVersion: 1,
    sequence: 1,
    modelDataPlane: "running",
    provider: "configured",
    settings: {
      "protocols.anthropic-messages.enabled": {
        key: "protocols.anthropic-messages.enabled",
        type: "boolean",
        default: true,
        validation: {},
        sensitivity: "public",
        applyMode: "hot-apply",
        value: true,
      },
      "protocols.openai-responses.enabled": {
        key: "protocols.openai-responses.enabled",
        type: "boolean",
        default: true,
        validation: {},
        sensitivity: "public",
        applyMode: "hot-apply",
        value: true,
      },
      [DEEP_CAPTURE_SETTING]: {
        key: DEEP_CAPTURE_SETTING,
        type: "boolean",
        default: false,
        validation: {},
        sensitivity: "public",
        applyMode: "hot-apply",
        value: enabled,
      },
      "server.port": {
        key: "server.port",
        type: "number",
        default: 3000,
        validation: {},
        sensitivity: "public",
        applyMode: "restart-required",
        value: 3000,
        effective: 3000,
      },
      "server.bindHost": {
        key: "server.bindHost",
        type: "string",
        default: "127.0.0.1",
        validation: {},
        sensitivity: "public",
        applyMode: "restart-required",
        value: "127.0.0.1",
        effective: "127.0.0.1",
      },
    },
  };
}

function makeShell(onSettings: (command: SettingsCommand) => void): WindowsShellHost {
  let snapshot: DesktopShellSnapshot = {
    lifecycle: "open",
    activePage: "settings-developer-lab",
    connection: connectedState(false),
  };
  const subscribers = new Set<(value: DesktopShellSnapshot) => void>();
  return {
    launch: async () => snapshot,
    navigate: (page) => {
      snapshot = { ...snapshot, activePage: page };
      return snapshot;
    },
    snapshot: () => snapshot,
    subscribe: (listener) => {
      subscribers.add(listener);
      listener(snapshot);
      return () => subscribers.delete(listener);
    },
    executeRuntimeCommand: async () => snapshot,
    executeSettingsCommand: async (command) => {
      onSettings(command);
      snapshot = {
        ...snapshot,
        connection: connectedState(
          command.command === "set" && command.key === DEEP_CAPTURE_SETTING
            ? command.value === true
            : snapshot.connection.kind === "connected" &&
                snapshot.connection.settings?.[DEEP_CAPTURE_SETTING]?.value ===
                  true,
        ),
      };
      for (const subscriber of subscribers) subscriber(snapshot);
      return snapshot;
    },
    executeClientTokenCommand: async () => ({
      outcome: "ok",
      revision: 1,
      scopes: [],
    }),
    executeCredentialCommand: async () => ({
      outcome: "ok",
      revision: 1,
      state: {
        revision: 1,
        path: "C:\\auth.json",
        present: true,
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
    getAutoStartStatus: async () => ({ enabled: false }),
    setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
    pickDirectory: async () => undefined,
    getRequestIdentities: async () => ({ records: [] }),
    // Ticket 19 inert ledger surface: the toggle test never queries or
    // subscribes the Request Ledger (same neutral behavior as the other
    // WindowsShellHost test doubles).
    getRequestLedger: async () => ({ records: [], hasMore: false }),
    subscribeRequestLedger: async () => async () => undefined,
    executeModelsCommand: async () => snapshot,
    executeCatalogCommand: async () => ({
      outcome: "ok",
      snapshot: {
        version: 1,
        modelsJsonValid: true,
        providers: [],
        refreshErrors: [],
      },
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
    dispose: async () => undefined,
  };
}

describe("Deep diagnostics capture toggle (Ticket 22)", () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  function render(shell: WindowsShellHost): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <App shell={shell} retryConnection={async () => connectedState(false)} />,
      );
    });
  }

  function toggle(): HTMLInputElement {
    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
    );
    const capture = inputs.find((input) => {
      const row = input.closest("label");
      return row?.textContent?.includes("Capture raw request/response artifacts");
    });
    if (capture === undefined)
      throw new Error("Deep diagnostics capture toggle not found");
    return capture;
  }

  it("renders the global capture toggle from the registered hot-apply setting", () => {
    const shell = makeShell(vi.fn());
    render(shell);
    expect(toggle().checked).toBe(false);
    expect(container.textContent).toContain(
      "Capture raw request/response artifacts",
    );
  });

  it("issues exactly one settings set command for the registered key when toggled", async () => {
    const commands: SettingsCommand[] = [];
    const shell = makeShell((command) => commands.push(command));
    render(shell);

    act(() => {
      toggle().click();
    });
    expect(commands).toEqual([
      { command: "set", key: DEEP_CAPTURE_SETTING, value: true },
    ]);
    // The projected state reflects the hot-applied value.
    expect(toggle().checked).toBe(true);
    expect(container.textContent).not.toContain("must-not-leak");
  });
});
