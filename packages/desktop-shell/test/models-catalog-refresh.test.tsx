// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CatalogCommand,
  CatalogCommandResult,
  CatalogStatusProjection,
  ModelsCommand,
  ModelsCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

import { ModelsFileWorkspace } from "../src/models-editors.js";

/**
 * Ticket 11 UI seam: the Models & Aliases workspace schedules the
 * non-blocking background refresh when it opens, shows the per-Provider
 * refresh states from the authoritative snapshot, and surfaces the bounded
 * per-Provider results of a Manual Refresh.
 */

const path = "C:\\models.json";

const modelsState: ModelsCommandResult = {
  outcome: "ok",
  state: {
    revision: 1,
    path,
    present: true,
    valid: true,
    raw: "{}\n",
    providers: {},
    catalog: {
      schemaVersion: "luckytoken-effective-catalog-v1",
      baseline: {
        package: "@earendil-works/pi-coding-agent",
        version: "0.84.1",
        schema: "pi-coding-agent-0.84.1-models-json-schema",
      },
      providers: [],
      compositionErrors: [],
    },
  },
};

const catalogResult: CatalogCommandResult = {
  outcome: "ok",
  snapshot: {
    version: 4,
    modelsJsonValid: true,
    refreshedAt: 1_700_000_000_000,
    providers: [
      {
        providerId: "dynamic-a",
        name: "dynamic-a",
        dynamic: true,
        state: "succeeded",
        refreshedAt: 1_700_000_000_000,
        models: [
          { id: "fresh-model", dynamic: true, availability: "available" },
        ],
      },
      {
        providerId: "openai",
        name: "OpenAI",
        dynamic: false,
        state: "known",
        models: [
          { id: "gpt-4", dynamic: false, availability: "unavailable" },
        ],
      },
    ],
    refreshErrors: [],
  },
};

const catalogStatus: CatalogStatusProjection = {
  version: 4,
  refreshing: false,
  refreshedAt: 1_700_000_000_000,
  failedProviderIds: [],
};

describe("catalog refresh workspace seam", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderWorkspace(options: {
    readonly onCatalogCommand: (command: CatalogCommand) => void;
    readonly catalogResult?: CatalogCommandResult;
    readonly catalogStatus?: CatalogStatusProjection;
  }) {
    await act(async () => {
      root.render(
        <ModelsFileWorkspace
          busy={false}
          mode="models"
          onCatalogCommand={options.onCatalogCommand}
          onCommand={() => undefined}
          onReload={() => undefined}
          projection={{ revision: 1, path, present: true, valid: true }}
          result={modelsState}
          {...(options.catalogResult === undefined
            ? {}
            : { catalogResult: options.catalogResult })}
          {...(options.catalogStatus === undefined
            ? {}
            : { catalogStatus: options.catalogStatus })}
        />,
      );
    });
  }

  /** Opens the Catalog refresh tab (the component starts on the editor). */
  async function openRefreshTab() {
    const buttons = [...container.querySelectorAll("button")];
    const tab = buttons.find(
      (button) => button.textContent === "Catalog refresh",
    );
    if (tab === undefined) throw new Error("Catalog refresh tab not found");
    await act(async () => {
      tab.click();
    });
  }

  it("schedules a non-blocking background refresh and a catalog query when it opens", async () => {
    const commands: CatalogCommand[] = [];
    await renderWorkspace({
      onCatalogCommand: (command) => commands.push(command),
    });
    expect(commands).toContainEqual({ command: "refresh", mode: "background" });
    expect(commands).toContainEqual({ command: "query" });
  });

  it("shows per-Provider refresh states from the authoritative snapshot", async () => {
    await renderWorkspace({
      onCatalogCommand: () => undefined,
      catalogResult,
      catalogStatus,
    });
    await openRefreshTab();
    expect(container.textContent).toContain("dynamic-a");
    expect(container.textContent).toContain("succeeded");
    expect(container.textContent).toContain("openai");
    expect(container.textContent).toContain("known");
    expect(container.textContent).toContain("Catalog refresh");
  });

  it("surfaces bounded per-Provider results after a Manual Refresh", async () => {
    const commands: CatalogCommand[] = [];
    await renderWorkspace({
      onCatalogCommand: (command) => commands.push(command),
      catalogResult: {
        outcome: "ok",
        snapshot: catalogResult.snapshot,
        refresh: {
          trigger: "manual",
          startedAt: 1_699_999_000_000,
          finishedAt: 1_700_000_000_000,
          providers: [{ providerId: "dynamic-a", outcome: "succeeded" }],
        },
      },
      catalogStatus,
    });
    await openRefreshTab();
    expect(container.textContent).toContain("Manual Refresh");
    // The manual report renders the per-Provider outcome.
    expect(container.textContent).toContain("dynamic-a");
    expect(container.textContent).toContain("succeeded");
    // The Manual Refresh button issues the explicit refresh command.
    const refreshButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Manual Refresh",
    );
    await act(async () => {
      refreshButton?.click();
    });
    expect(commands).toContainEqual({
      command: "refresh",
      mode: "manual",
    });
  });

  it("shows the refreshing state while a background refresh runs", async () => {
    await renderWorkspace({
      onCatalogCommand: () => undefined,
      catalogResult,
      catalogStatus: { ...catalogStatus, refreshing: true },
    });
    await openRefreshTab();
    expect(container.textContent).toContain("Refreshing");
  });

  it("aggregates visible refresh errors with value-safe messages", async () => {
    await renderWorkspace({
      onCatalogCommand: () => undefined,
      catalogResult: {
        outcome: "ok",
        snapshot: {
          version: 5,
          modelsJsonValid: true,
          providers: [
            {
              providerId: "dynamic-a",
              name: "dynamic-a",
              dynamic: true,
              state: "failed",
              error: 'Model catalog refresh failed for provider "dynamic-a"',
              errorCode: "model_source",
              models: [],
            },
          ],
          refreshErrors: [
            {
              providerId: "dynamic-a",
              code: "model_source",
              message: 'Model catalog refresh failed for provider "dynamic-a"',
            },
          ],
        },
      },
      catalogStatus: { ...catalogStatus, failedProviderIds: ["dynamic-a"] },
    });
    await openRefreshTab();
    expect(container.textContent).toContain("dynamic-a");
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("Some Providers could not refresh");
  });
});
