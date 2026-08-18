// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCommandResult } from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(api = createFakeDesktopApi()): Promise<void> {
  await act(async () => {
    root.render(<App api={api} />);
  });
}

function button(name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return match;
}

describe("Home readiness product slice", () => {
  it("queries fresh Backend state on mount and shows ready state", async () => {
    const getStatus = vi.fn(async () => ({
      sequence: 3,
      modelDataPlane: "running" as const,
      provider: "configured" as const,
      dataPlane: { configuredOrigin: "http://127.0.0.1:3000", configuredPort: 3000 },
    }));
    await render(createFakeDesktopApi({ control: { getStatus } }));

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("LuckyToken is ready");
    expect(container.textContent).toContain("http://127.0.0.1:3000");
  });

  it("starts a stopped gateway through the typed command and waits for authoritative result state", async () => {
    let resolveStart: ((value: RuntimeCommandResult) => void) | undefined;
    const executeRuntime = vi.fn(
      () =>
        new Promise<RuntimeCommandResult>((resolve) => {
          resolveStart = resolve;
        }),
    );
    await render(
      createFakeDesktopApi({
        control: {
          getStatus: async () => ({
            sequence: 1,
            modelDataPlane: "stopped",
            provider: "configured",
          }),
          executeRuntime,
        },
      }),
    );

    await act(async () => button("Start gateway").click());
    expect(executeRuntime).toHaveBeenCalledWith("start");
    expect(container.textContent).toContain("Starting…");

    await act(async () => {
      resolveStart?.({
        command: "start",
        outcome: "completed",
        snapshot: {
          sequence: 2,
          modelDataPlane: "running",
          provider: "configured",
        },
      });
    });
    expect(container.textContent).toContain("LuckyToken is ready");
  });

  it("routes an unconfigured user to the Providers product task", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          getStatus: async () => ({
            sequence: 1,
            modelDataPlane: "running",
            provider: "unconfigured",
          }),
        },
      }),
    );

    expect(container.textContent).toContain("Connect an AI provider");
    await act(async () => button("Set up provider").click());
    expect(container.querySelector("h1")?.textContent).toBe("Providers");
  });

  it("distinguishes starting, actionable attention, and unavailable states", async () => {
    const api = createFakeDesktopApi({
      control: {
        getStatus: async () => ({
          sequence: 1,
          modelDataPlane: "starting",
          provider: "configured",
        }),
      },
    });
    await render(api);
    expect(container.textContent).toContain("Gateway is starting");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(
      createFakeDesktopApi({
        control: {
          getStatus: async () => ({
            sequence: 2,
            modelDataPlane: "running",
            provider: "configured",
            attention: {
              conditions: [
                {
                  id: "provider-login-invalid:example",
                  category: "provider-login-invalid",
                  since: 1,
                  page: "providers",
                  providerId: "example",
                },
              ],
            },
          }),
        },
      }),
    );
    expect(container.textContent).toContain("Needs your attention");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(
      createFakeDesktopApi({
        control: { getStatus: async () => Promise.reject(new Error("offline")) },
      }),
    );
    expect(container.textContent).toContain("LuckyToken is unavailable");
  });
});
