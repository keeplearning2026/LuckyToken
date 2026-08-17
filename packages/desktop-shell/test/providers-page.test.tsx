// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

const providerStatus = (overrides: Record<string, unknown> = {}) => ({
  providerId: "example",
  stored: true,
  storedType: "oauth" as const,
  environment: false,
  modelsJson: false,
  commandDerived: false,
  expired: false,
  unavailable: false,
  effectiveSource: "stored" as const,
  ...overrides,
});

const authQuery = (overrides: Record<string, unknown> = {}) => ({
  outcome: "ok" as const,
  state: {
    revision: 1,
    path: "auth.json",
    present: true,
    valid: true,
    providers: [providerStatus(overrides)],
  },
  options: {
    providers: [
      {
        providerId: "example",
        name: "Example AI",
        account: true,
        subscription: true,
        accountLabel: "Use Example account",
        apiKey: true,
        apiKeyLabel: "Use API key",
        status: providerStatus(overrides),
      },
    ],
  },
});

const catalogQuery = () => ({
  outcome: "ok" as const,
  snapshot: {
    version: 1,
    modelsJsonValid: true,
    providers: [
      {
        providerId: "example",
        name: "Example AI",
        dynamic: true,
        state: "succeeded" as const,
        models: [
          { id: "model-a", dynamic: true, availability: "available" as const },
          { id: "model-b", dynamic: true, availability: "available" as const },
        ],
      },
    ],
    refreshErrors: [],
  },
});

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

async function render(api: ReturnType<typeof createFakeDesktopApi>): Promise<void> {
  await act(async () => root.render(<App api={api} />));
  await act(async () => {
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === "Providers",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("Providers nav missing");
    button.click();
  });
}

function click(name: string): Promise<void> {
  return act(async () => {
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === name,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
    button.click();
  });
}

describe("Providers product slice", () => {
  it("shows typed auth and catalog state without credential values", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogQuery(),
        },
      }),
    );

    expect(container.textContent).toContain("Example AI");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("2 models available");
    expect(container.textContent).not.toContain("secret");
  });

  it("shows expired authentication as an explicit reconnect action", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery({ expired: true }),
          executeCatalog: async () => catalogQuery(),
        },
      }),
    );
    expect(container.textContent).toContain("Reconnect required");
    expect(container.textContent).toContain("Use Example account");
  });

  it("projects login events, supports cancellation, and applies the terminal authoritative status", async () => {
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const respondAuth = vi.fn(async () => undefined);
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      listener?.({ type: "progress", message: "Waiting for browser sign-in" });
      return new Promise<ReturnType<typeof authQuery>>((resolve) => {
        loginResolve = resolve;
      });
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth,
          respondAuth,
          executeCatalog: async () => catalogQuery(),
        },
      }),
    );

    await click("Use Example account");
    expect(container.textContent).toContain("Waiting for browser sign-in");
    await click("Cancel sign-in");
    expect(respondAuth).toHaveBeenCalledWith({ type: "cancel" });

    await act(async () => loginResolve?.(authQuery()));
    expect(container.textContent).toContain("Connected");
  });

  it("refreshes model availability and shows bounded per-Provider failures", async () => {
    const executeCatalog = vi.fn(async (command) => {
      if (command.command === "query") return catalogQuery();
      return {
        ...catalogQuery(),
        refresh: {
          trigger: "manual" as const,
          startedAt: 1,
          finishedAt: 2,
          providers: [
            {
              providerId: "example",
              outcome: "failed" as const,
              error: "Provider refresh failed",
              errorCode: "provider_error",
            },
          ],
        },
      };
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog,
        },
      }),
    );

    await click("Refresh models");
    expect(executeCatalog).toHaveBeenLastCalledWith({ command: "refresh", mode: "manual" });
    expect(container.textContent).toContain("Provider refresh failed");
  });
});
