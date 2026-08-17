// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AnalyticsOptionsResult,
  AnalyticsQuery,
  AnalyticsResult,
  AnalyticsSummary,
  ClientTokenCommandResult,
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerRecord,
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
 * Ticket 21 rendered Analytics page: deterministic results through the
 * WindowsShellHost `getAnalytics` seam. The page owns range presets,
 * Total/per-real-Provider view, filters, group-by, and the counts/token/
 * series rendering; table internals are never asserted — the public
 * behaviors are (values, re-query on change, aggregate cache fraction,
 * reasoning footnote, no cost/pricing text, empty/error states,
 * accessibility).
 */

const SUMMARY: AnalyticsSummary = {
  total: 7,
  success: 3,
  failed: 1,
  aborted: 1,
  other: 2,
  pending: 0,
  successRate: 3 / 7,
  failureRate: 1 / 7,
  abortRate: 1 / 7,
  participating: 3,
  totalRequests: 7,
  excluded: 4,
  inputTokens: 13,
  cacheReadTokens: 7,
  cacheWriteTokens: 4,
  outputTokens: 8,
  reasoningTokens: 2,
  normalizedTokenTotal: 32,
  cacheHitNumerator: 7,
  cacheHitDenominator: 24,
  cacheHitRate: 7 / 24,
};

const EMPTY_SUMMARY: AnalyticsSummary = {
  total: 0,
  success: 0,
  failed: 0,
  aborted: 0,
  other: 0,
  pending: 0,
  successRate: 0,
  failureRate: 0,
  abortRate: 0,
  participating: 0,
  totalRequests: 0,
  excluded: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  cacheHitNumerator: 0,
  cacheHitDenominator: 0,
};

const OPTIONS: AnalyticsOptionsResult = {
  version: 1,
  command: "options",
  providers: ["anthropic", "openai"],
  models: ["claude-x"],
  protocols: ["anthropic-messages", "openai-responses"],
  projects: ["C:\\canonical\\alpha"],
  outcomes: ["aborted", "failed", "success"],
};

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

function makeShell(options: {
  readonly summary?: AnalyticsResult;
  readonly error?: Error;
} = {}) {
  const connection: ControlPlaneState = connectedState();
  let snapshot: DesktopShellSnapshot = {
    lifecycle: "open",
    activePage: "analytics",
    connection,
  };
  const queries: AnalyticsQuery[] = [];
  const optionsQueries: AnalyticsQuery[] = [];
  const shell: WindowsShellHost = {
    launch: async () => snapshot,
    navigate: (page) => {
      snapshot = { ...snapshot, activePage: page };
      return snapshot;
    },
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    executeRuntimeCommand: async (): Promise<DesktopShellSnapshot> => snapshot,
    executeSettingsCommand: async (): Promise<DesktopShellSnapshot> => snapshot,
    acknowledgePersistence: async (): Promise<DesktopShellSnapshot> => snapshot,
    getAutoStartStatus: async () => ({ enabled: false }),
    setAutoStartEnabled: async (enabled: boolean) => ({ enabled }),
    executeClientTokenCommand: async (): Promise<ClientTokenCommandResult> => ({
      outcome: "ok",
      revision: 1,
      scopes: [],
    }),
    executeCredentialCommand: async () => {
      throw new Error("unused credential command");
    },
    executeAuthCommand: async () => {
      throw new Error("unused auth command");
    },
    respondAuthInteraction: async () => undefined,
    openUrl: async () => undefined,
    queryDiagnosticsWarnings: async () => [] as readonly DiagnosticsWarning[],
    pickDirectory: async () => undefined,
    getRequestIdentities: async () => ({ records: [] }),
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
    executeAliasCommand: async () => {
      throw new Error("unused alias command");
    },
    executeCodexIntegrationCommand: async () => {
      throw new Error("unused Codex integration command");
    },
    dispose: async () => undefined,
    getAnalytics: async (query) => {
      queries.push(query);
      if (options.error !== undefined) throw options.error;
      if (query.command === "options") {
        optionsQueries.push(query);
        return OPTIONS;
      }
      return (
        options.summary ?? {
          version: 1,
          command: "summary",
          totals: SUMMARY,
        }
      );
    },
    getRequestLedger: async (): Promise<{
      readonly records: readonly RequestLedgerRecord[];
      readonly hasMore: boolean;
    }> => ({ records: [], hasMore: false }),
    subscribeRequestLedger: async (): Promise<() => Promise<void>> =>
      async () => undefined,
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
    executeHistoryDelete: async () => {
      throw new Error("unused history delete");
    },
    confirmHistoryDelete: async () => {
      throw new Error("unused history delete confirmation");
    },
    pickHistoryExportDestination: async () => undefined,
  };
  return { shell, queries, optionsQueries };
}

describe("Analytics page (Ticket 21)", () => {
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
      root.render(
        <App shell={shell} retryConnection={async () => connectedState()} />,
      );
    });
    // Flush the mount effects (summary + options queries).
    await act(async () => {
      await Promise.resolve();
    });
  }

  function button(label: string): HTMLButtonElement | undefined {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.trim() === label);
  }

  it("renders the counts table and token stats with the aggregate cache fraction", async () => {
    const fixture = makeShell();
    await render(fixture.shell);
    const text = container.textContent ?? "";
    // Counts (independent worked table).
    expect(text).toContain("7");
    expect(text).toContain("Success");
    expect(text).toContain("Failed");
    expect(text).toContain("Aborted");
    expect(text).toContain("Other");
    // Token stats: participating / total / excluded and sums.
    expect(text).toContain("Participating requests");
    expect(text).toContain("Total requests");
    expect(text).toContain("Excluded requests");
    expect(text).toContain("32");
    // The exact aggregate fraction, never an averaged percentage.
    expect(text).toContain("7 of 24 input tokens");
    // The completeness caption is visible next to the counts.
    expect(text).toContain(
      "Request counts include every matching request regardless of usage completeness",
    );
    expect(text).toContain(
      "Token aggregates include only requests with Complete terminal usage",
    );
  });

  it("shows reasoning as an output subset with the footnote, never added to totals", async () => {
    const fixture = makeShell();
    await render(fixture.shell);
    const text = container.textContent ?? "";
    expect(text).toContain("2 reasoning tokens");
    expect(text).toContain(
      "reasoning is a subset of output and is never added to token totals",
    );
    // The normalized total is the component sum, not sum + reasoning.
    expect(text).toContain("Normalized token total");
    expect(text).toContain("32");
  });

  it("re-queries when a filter changes and narrows the query shape", async () => {
    const fixture = makeShell();
    await render(fixture.shell);
    const before = fixture.queries.filter(
      (query) => query.command === "summary",
    ).length;
    expect(before).toBe(1);
    const providerSelect = container.querySelector<HTMLSelectElement>(
      "#analytics-filter-provider",
    );
    expect(providerSelect).not.toBeNull();
    await act(async () => {
      providerSelect!.value = "anthropic";
      providerSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const summaries = fixture.queries.filter(
      (query) => query.command === "summary",
    );
    expect(summaries.length).toBe(2);
    const latest = summaries.at(-1);
    expect(latest?.command).toBe("summary");
    if (latest?.command !== "summary") return;
    expect(latest.filters?.providers).toEqual(["anthropic"]);
  });

  it("issues groupBy provider for the Per real Provider view", async () => {
    const fixture = makeShell();
    await render(fixture.shell);
    await act(async () => {
      button("Per real Provider")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const summaries = fixture.queries.filter(
      (query) => query.command === "summary",
    );
    expect(summaries.length).toBe(2);
    expect(summaries.at(-1)?.command).toBe("summary");
    if (summaries.at(-1)?.command !== "summary") return;
    expect(summaries.at(-1)?.groupBy).toBe("provider");
    // The group-by select is disabled in provider view.
    const groupSelect = container.querySelector<HTMLSelectElement>(
      "#analytics-group",
    );
    expect(groupSelect?.disabled).toBe(true);
  });

  it("renders group rows and the hourly series when present", async () => {
    const fixture = makeShell({
      summary: {
        version: 1,
        command: "summary",
        totals: SUMMARY,
        rows: [
          {
            dimension: "provider",
            value: "anthropic",
            summary: SUMMARY,
          },
          { dimension: "provider", value: null, summary: SUMMARY },
        ],
        buckets: [
          {
            start: 1_700_000_000_000,
            end: 1_700_003_600_000,
            summary: SUMMARY,
          },
        ],
      },
    });
    await render(fixture.shell);
    const text = container.textContent ?? "";
    expect(text).toContain("Results grouped by provider");
    expect(text).toContain("Hourly time series");
    expect(text).toContain("each request is attributed to the bucket");
  });

  it("renders the empty state and the error state honestly", async () => {
    const fixture = makeShell({
      summary: { version: 1, command: "summary", totals: EMPTY_SUMMARY },
    });
    await render(fixture.shell);
    expect(container.textContent ?? "").toContain(
      "No requests in the selected time range.",
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();

    const failing = makeShell({ error: new Error("connection lost") });
    await render(failing.shell);
    expect(container.textContent ?? "").toContain(
      "Analytics are unavailable.",
    );
    // Refresh re-queries and can recover.
    await act(async () => {
      root.unmount();
    });
    container.remove();
    const recovering = makeShell({});
    await render(recovering.shell);
    await act(async () => {
      button("Refresh")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const summaries = recovering.queries.filter(
      (query) => query.command === "summary",
    );
    expect(summaries.length).toBeGreaterThanOrEqual(2);
  });

  it("never renders cost, price, billing, or currency text", async () => {
    const fixture = makeShell();
    await render(fixture.shell);
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toMatch(/cost|price|billing|usd|\$\d/u);
  });

  it("provides accessible structure: labels, captions, and aria-live", async () => {
    const fixture = makeShell();
    await render(fixture.shell);
    expect(container.querySelector("#analytics-filter-provider")).not.toBeNull();
    expect(container.querySelector("label[for='analytics-filter-provider']")).not.toBeNull();
    const captions = Array.from(container.querySelectorAll("caption"));
    expect(captions.length).toBeGreaterThanOrEqual(2);
    const scoped = Array.from(
      container.querySelectorAll("th[scope='col']"),
    );
    expect(scoped.length).toBeGreaterThan(0);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    // Custom range inputs render only in the Custom preset.
    await act(async () => {
      button("Custom")?.click();
    });
    expect(container.querySelector("label[for='analytics-from']")).not.toBeNull();
    expect(container.querySelector("label[for='analytics-to']")).not.toBeNull();
  });
});
