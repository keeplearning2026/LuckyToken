// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it } from "vitest";

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
 * Ticket 17 identity seam through the actual Requests surface: the public
 * ledger renders the client-provided session id or `-`, never the internal
 * effective session identity.
 */
const clientSession = "11111111-1111-4111-8111-111111111111";

function connectedState(): ControlPlaneState {
  return {
    revision: 1,
    kind: "connected",
    applicationVersion: "0.0.0-test",
    contractVersion: 1,
    sequence: 1,
    modelDataPlane: "running",
    provider: "configured",
  };
}

function makeShell(identities: {
  readonly withClient: boolean;
  readonly projectDir?: string;
}): WindowsShellHost {
  let snapshot: DesktopShellSnapshot = {
    lifecycle: "open",
    activePage: "requests",
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
    executeClientTokenCommand: async (): Promise<ClientTokenCommandResult> => ({
      outcome: "ok",
      revision: 1,
      scopes: [],
    }),
    queryDiagnosticsWarnings: async () => [] as readonly DiagnosticsWarning[],
    getAutoStartStatus: async () => ({ enabled: false }),
    setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
    pickDirectory: async () => undefined,
    getRequestIdentities: async () => ({
      records: [
        {
          id: 2,
          time: 1_700_000_000_000,
          protocolId: "anthropic-messages",
          ...(identities.withClient
            ? { clientSessionId: clientSession }
            : {}),
          ...(identities.projectDir === undefined
            ? {}
            : { projectDir: identities.projectDir }),
        },
        {
          id: 1,
          time: 1_699_999_999_999,
          protocolId: "openai-responses",
        },
      ],
    }),
    executeModelsCommand: async () => snapshot,
    dispose: async () => undefined,
  };
}

describe("Requests page public identity projection", () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(shell: WindowsShellHost): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App shell={shell} retryConnection={async () => connectedState()} />);
    });
    // Flush the async identities query effect.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("renders the provided client session id and `-` for missing ones", async () => {
    await render(makeShell({ withClient: true, projectDir: "C:\\canonical\\project" }));
    const text = container.textContent ?? "";
    // The client-provided id renders verbatim.
    expect(text).toContain(clientSession);
    // The missing client id renders as "-" (the second row).
    expect(text).toContain("openai-responses");
    // The canonical project context renders for the directory request.
    expect(text).toContain("C:\\canonical\\project");
    // The internal effective session identity is never rendered anywhere.
    expect(text).not.toContain("effectiveSessionId");
    expect(text).not.toContain("00000000-0000-4000-8000-");
  });

  it("renders `-` when no client supplied a session id", async () => {
    await render(makeShell({ withClient: false }));
    const text = container.textContent ?? "";
    expect(text).not.toContain(clientSession);
    expect(text).not.toContain("00000000-0000-4000-8000-");
  });
});
