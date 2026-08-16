// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ClientTokenCommand,
  ClientTokenCommandResult,
  ModelsCommand,
  RuntimeCommand,
  SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/App.js";
import type { ControlPlaneState } from "../src/control-plane-projection.js";
import type {
  DesktopShellSnapshot,
  WindowsShellHost,
} from "../src/shell-lifecycle.js";
import type { DiagnosticsWarning } from "../src/tauri-shell-runtime.js";

/**
 * Ticket 17 desktop picker seam: the Client Tokens page drives the native
 * directory picker, then creates exactly one token for the picked path
 * through the Control Plane. Cancel, success, and backend-rejection flows
 * are exercised through the public shell host; the renderer never
 * canonicalizes a path itself.
 */
function connectedState(): ControlPlaneState {
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
    },
  };
}

function makeShell(overrides: {
  readonly pick?: () => Promise<string | undefined>;
  readonly onCommand?: (
    command: ClientTokenCommand,
  ) => Promise<ClientTokenCommandResult>;
  readonly listScopes?: () => NonNullable<ClientTokenCommandResult["scopes"]>;
}): WindowsShellHost {
  const listScopes =
    overrides.listScopes ??
    (() => [{ type: "global", maskedToken: "canary-g…lob" }]);
  const onCommand =
    overrides.onCommand ??
    (async (
      _command: ClientTokenCommand,
    ): Promise<ClientTokenCommandResult> => ({
      outcome: "ok",
      revision: 1,
      scopes: listScopes(),
    }));
  let snapshot: DesktopShellSnapshot = {
    lifecycle: "open",
    activePage: "client-tokens",
    connection: connectedState(),
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
    executeSettingsCommand: async () => snapshot,
    executeClientTokenCommand: onCommand,
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
    queryDiagnosticsWarnings: async () => [] as readonly DiagnosticsWarning[],
    getAutoStartStatus: async () => ({ enabled: false }),
    setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
    pickDirectory: overrides.pick ?? (async () => undefined),
    getRequestIdentities: async () => ({ records: [] }),
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
    dispose: async () => undefined,
  };
}

describe("Client Tokens page native directory picker flows", () => {
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
        <App shell={shell} retryConnection={async () => connectedState()} />,
      );
    });
  }

  function addButton(): HTMLButtonElement {
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    );
    const add = buttons.find((button) =>
      button.textContent?.includes("Add directory token"),
    );
    if (add === undefined)
      throw new Error("Add directory token button not found");
    return add;
  }

  it("does nothing when the native picker is cancelled", async () => {
    const commands: ClientTokenCommand[] = [];
    const shell = makeShell({
      pick: async () => undefined,
      onCommand: async (command) => {
        commands.push(command);
        return {
          outcome: "ok",
          revision: 1,
          scopes: [{ type: "global", maskedToken: "canary-g…lob" }],
        };
      },
    });
    render(shell);

    await act(async () => {
      addButton().click();
    });
    expect(commands.filter((command) => command.command !== "list")).toEqual(
      [],
    );
    expect(container.textContent).not.toContain(
      "This directory already has a token",
    );
  });

  it("creates one token for the picked directory and lists the canonical scope", async () => {
    const commands: ClientTokenCommand[] = [];
    let projectScopes: NonNullable<ClientTokenCommandResult["scopes"]> = [
      { type: "global", maskedToken: "canary-g…lob" },
    ];
    const shell = makeShell({
      pick: async () => "C:\\picked\\directory",
      onCommand: async (command) => {
        commands.push(command);
        if (command.command === "create") {
          projectScopes = [
            { type: "global", maskedToken: "canary-g…lob" },
            {
              type: "project",
              projectDir: "C:\\canonical\\project",
              maskedToken: "canary-p…oje",
            },
          ];
          return { outcome: "ok", revision: 2, scopes: projectScopes };
        }
        return { outcome: "ok", revision: 2, scopes: projectScopes };
      },
    });
    render(shell);

    await act(async () => {
      addButton().click();
    });
    const create = commands.find((command) => command.command === "create");
    expect(create).toEqual({
      command: "create",
      protocolId: "anthropic-messages",
      scope: { type: "project", projectDir: "C:\\picked\\directory" },
    });
    // The canonical scope (backend-verified) is displayed, never the raw
    // picked path.
    expect(container.textContent).toContain("C:\\canonical\\project");
    expect(container.textContent).not.toContain("C:\\picked\\directory");
    // The masked token is shown, never the raw secret.
    expect(container.textContent).toContain("canary-p…oje");
  });

  it("renders a value-free message when the backend rejects the picked directory", async () => {
    const shell = makeShell({
      pick: async () => "C:\\vanished\\directory",
      onCommand: async (command) => {
        if (command.command === "create") {
          return {
            outcome: "invalid_directory",
            revision: 1,
            reason: "not_found",
            error: "Selected directory is not usable as a client token scope",
          };
        }
        return {
          outcome: "ok",
          revision: 1,
          scopes: [{ type: "global", maskedToken: "canary-g…lob" }],
        };
      },
    });
    render(shell);

    await act(async () => {
      addButton().click();
    });
    expect(container.textContent).toContain(
      "The selected directory no longer exists.",
    );
    // The raw picked path never reaches the renderer error surface.
    expect(container.textContent).not.toContain("vanished");
    expect(container.textContent).not.toContain(
      "Selected directory is not usable",
    );
  });

  it("reports an existing scope instead of creating a duplicate token", async () => {
    const creates = vi.fn();
    const shell = makeShell({
      pick: async () => "C:\\picked\\directory",
      onCommand: async (command) => {
        if (command.command === "create") {
          creates();
          return {
            outcome: "already_exists",
            revision: 1,
            error: "Client token scope already has a token",
          };
        }
        return {
          outcome: "ok",
          revision: 1,
          scopes: [
            { type: "global", maskedToken: "canary-g…lob" },
            {
              type: "project",
              projectDir: "C:\\canonical\\project",
              maskedToken: "canary-p…oje",
            },
          ],
        };
      },
    });
    render(shell);

    await act(async () => {
      addButton().click();
    });
    expect(creates).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "This directory already has a token.",
    );
  });
});
