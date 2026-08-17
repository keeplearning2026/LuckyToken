// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it } from "vitest";

import { CodexIntegrationPanel } from "../src/codex-integration-panel.js";

describe("Codex integration panel", () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps native Codex request support visibly independent from the managed-routing switch", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <CodexIntegrationPanel
          busy={false}
          state={{
            desiredEnabled: false,
            observedState: "native",
            codexHome: "C:\\Users\\user\\.codex",
            configPath: "C:\\Users\\user\\.codex\\config.toml",
            catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
            endpoint: "http://127.0.0.1:3000/v1",
            modelCount: 8,
            warnings: [],
            restartRequired: false,
          }}
          onSync={() => undefined}
          onToggle={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("Native Codex request support");
    expect(container.textContent).toContain("Supported");
    expect(container.textContent).toContain("Route local Codex through LuckyToken");
    const toggle = container.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(toggle?.checked).toBe(false);
  });

  it("requests enabling managed Codex routing when the user turns the switch on", () => {
    const toggles: boolean[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <CodexIntegrationPanel
          busy={false}
          state={{
            desiredEnabled: false,
            observedState: "native",
            codexHome: "C:\\Users\\user\\.codex",
            configPath: "C:\\Users\\user\\.codex\\config.toml",
            catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
            endpoint: "http://127.0.0.1:3000/v1",
            modelCount: 8,
            warnings: [],
            restartRequired: false,
          }}
          onSync={() => undefined}
          onToggle={(enabled) => toggles.push(enabled)}
        />,
      );
    });
    const toggle = container.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (toggle === null) throw new Error("Codex integration toggle not found");

    act(() => toggle.click());

    expect(toggles).toEqual([true]);
  });

  it("offers explicit model synchronization only while managed routing is enabled", () => {
    let syncs = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <CodexIntegrationPanel
          busy={false}
          state={{
            desiredEnabled: true,
            observedState: "managed",
            codexHome: "C:\\Users\\user\\.codex",
            configPath: "C:\\Users\\user\\.codex\\config.toml",
            catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
            endpoint: "http://127.0.0.1:3000/v1",
            modelCount: 11,
            warnings: [],
            restartRequired: false,
          }}
          onSync={() => {
            syncs += 1;
          }}
          onToggle={() => undefined}
        />,
      );
    });
    const sync = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Sync Models",
    );
    if (sync === undefined) throw new Error("Sync Models action not found");

    act(() => sync.click());

    expect(syncs).toBe(1);
  });

  it("shows catalog compatibility warnings returned by the integration authority", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <CodexIntegrationPanel
          busy={false}
          state={{
            desiredEnabled: true,
            observedState: "managed",
            codexHome: "C:\\Users\\user\\.codex",
            configPath: "C:\\Users\\user\\.codex\\config.toml",
            catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
            endpoint: "http://127.0.0.1:3000/v1",
            modelCount: 7,
            warnings: ["Alias provider/vendor/model is not exposed to Codex."],
            restartRequired: false,
          }}
          onSync={() => undefined}
          onToggle={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain(
      "Alias provider/vendor/model is not exposed to Codex.",
    );
  });

  it("tells the user when Codex must restart to load the managed catalog", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <CodexIntegrationPanel
          busy={false}
          state={{
            desiredEnabled: true,
            observedState: "managed",
            codexHome: "C:\\Users\\user\\.codex",
            configPath: "C:\\Users\\user\\.codex\\config.toml",
            catalogPath: "C:\\Users\\user\\.luckytoken\\integrations\\codex\\model-catalog.json",
            endpoint: "http://127.0.0.1:3000/v1",
            modelCount: 8,
            warnings: [],
            restartRequired: true,
          }}
          onSync={() => undefined}
          onToggle={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("Restart Codex");
  });
});
