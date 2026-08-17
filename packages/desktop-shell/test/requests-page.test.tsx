// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ClientTokenCommand,
  ClientTokenCommandResult,
  ModelsCommand,
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
 * Ticket 19 rendered Requests page: deterministic records through the
 * WindowsShellHost seam. The page owns status derivation display, filters,
 * cursor pagination, live upserts keyed by the monotonic ledger id, and the
 * discard-and-resync lifecycle. Table internals are never asserted; the
 * public behaviors are.
 */

const clientSessionId = "20000000-0000-4000-8000-000000000031";
const effectiveSessionId = "30000000-0000-4000-8000-000000000032";

function connectedState(sequence = 1): ControlPlaneState {
  return {
    revision: 1,
    kind: "connected",
    applicationVersion: "0.0.0-test",
    contractVersion: 1,
    sequence,
    modelDataPlane: "running",
    provider: "configured",
  };
}

function disconnectedState(): ControlPlaneState {
  return {
    revision: 2,
    kind: "error",
    code: "transport_lost",
    title: "LuckyToken connection lost",
    detail: "The local Control Plane disconnected.",
    action: "Reconnect to continue.",
  };
}

type RecordOverrides = {
  readonly [K in keyof RequestLedgerRecord]?:
    | RequestLedgerRecord[K]
    | undefined;
};

function record(
  id: number,
  overrides: RecordOverrides = {},
): RequestLedgerRecord {
  const base: RequestLedgerRecord = {
    id,
    requestId: `10000000-0000-4000-8000-000000000${String(id).padStart(3, "0")}`,
    protocolId: "anthropic-messages",
    phase: "terminal-preparation",
    outcome: "success",
    acceptedAt: 1_700_000_000_000 + id,
    executionStartedAt: 1_700_000_001_000 + id,
    terminalAt: 1_700_000_003_000 + id,
    completedAt: 1_700_000_003_010 + id,
    clientHttpStatus: 200,
    externalAlias: "alpha",
    providerId: "commandcode-private",
    realModelId: "claude-fixture",
    clientSessionId,
    effectiveSessionId,
    projectDir: "C:\\Users\\fixture\\projects\\alpha",
    terminalUsage: {
      api: "commandcode-private",
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 100,
      reasoning: 10,
      normalizedTotal: 110,
      cacheHitRate: 0.3,
      completeness: "complete",
    },
  };
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as unknown as RequestLedgerRecord;
}

interface StubOptions {
  readonly records?: readonly RequestLedgerRecord[];
  readonly hasMore?: boolean;
  readonly queryError?: Error;
  readonly subscribeError?: Error;
  /** Defer every query from this 1-based index onward until
   *  `resolveDeferredQuery` supplies the result (deterministic race
   *  control for the event-wins ordering tests). */
  readonly deferFromQuery?: number;
}

function makeShell(options: StubOptions = {}) {
  const allRecords = [...(options.records ?? [])].sort((a, b) => b.id - a.id);
  let queryError = options.queryError;
  const subscribeError = options.subscribeError;
  let connection: ControlPlaneState = connectedState();
  let snapshot: DesktopShellSnapshot = {
    lifecycle: "open",
    activePage: "requests",
    connection,
  };
  const subscribers = new Set<(value: DesktopShellSnapshot) => void>();
  const queries: RequestLedgerQuery[] = [];
  const deferredResolvers: Array<
    (result: { readonly records: readonly RequestLedgerRecord[]; readonly hasMore: boolean }) => void
  > = [];
  let ledgerListener: ((event: RequestLedgerEvent) => void) | undefined;
  let ledgerOnError: ((error: Error) => void) | undefined;
  let subscriptionCount = 0;
  const queryMatches = (query: RequestLedgerQuery, candidate: RequestLedgerRecord) => {
    if (query.outcome !== undefined && candidate.outcome !== query.outcome) return false;
    if (query.protocolId !== undefined && candidate.protocolId !== query.protocolId) return false;
    if (query.providerId !== undefined && (candidate.providerId ?? "-") !== query.providerId) return false;
    if (query.realModelId !== undefined && (candidate.realModelId ?? "-") !== query.realModelId) return false;
    if (query.projectDir !== undefined && (candidate.projectDir ?? "-") !== query.projectDir) return false;
    if (query.from !== undefined && candidate.acceptedAt < query.from) return false;
    if (query.to !== undefined && candidate.acceptedAt > query.to) return false;
    return true;
  };
  const shell: WindowsShellHost = {
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
    executeRuntimeCommand: async (): Promise<DesktopShellSnapshot> => snapshot,
    executeSettingsCommand: async (): Promise<DesktopShellSnapshot> => snapshot,
    executeClientTokenCommand: async (): Promise<ClientTokenCommandResult> => ({
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
    getAnalytics: async () => {
      throw new Error("unused analytics");
    },
    async getRequestLedger(query) {
      queries.push(query ?? {});
      if (
        options.deferFromQuery !== undefined &&
        queries.length >= options.deferFromQuery
      ) {
        return new Promise((resolve) => deferredResolvers.push(resolve));
      }
      if (queryError !== undefined) {
        const error = queryError;
        queryError = undefined;
        throw error;
      }
      const eligible = allRecords.filter((candidate) => queryMatches(query ?? {}, candidate));
      const afterId = query?.afterId;
      const limited =
        afterId === undefined ? eligible : eligible.filter((candidate) => candidate.id < afterId);
      const limit = query?.limit ?? 100;
      const visible = limited.slice(0, limit);
      return { records: visible, hasMore: limited.length > limit || (options.hasMore ?? false) };
    },
    async subscribeRequestLedger(listener, onError) {
      subscriptionCount += 1;
      if (subscribeError !== undefined) throw subscribeError;
      ledgerListener = listener;
      ledgerOnError = onError;
      return async () => {
        ledgerListener = undefined;
      };
    },
  };
  return {
    shell,
    queries,
    subscriptionCount: () => subscriptionCount,
    resolveDeferredQuery(result: {
      readonly records: readonly RequestLedgerRecord[];
      readonly hasMore: boolean;
    }) {
      deferredResolvers.shift()?.(result);
    },
    push(ledgerRecord: RequestLedgerRecord) {
      ledgerListener?.({ type: "request_ledger", record: ledgerRecord });
    },
    failStream(error: Error) {
      ledgerOnError?.(error);
    },
    setConnection(next: ControlPlaneState) {
      connection = next;
      snapshot = { ...snapshot, connection };
      for (const subscriber of subscribers) subscriber(snapshot);
    },
  };
}

describe("Requests page (Ticket 19)", () => {
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
    // Flush the async subscribe + head-query effects.
    await act(async () => {
      await Promise.resolve();
    });
  }

  function viewButton(): HTMLButtonElement | undefined {
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    );
    return buttons.find((button) => button.textContent?.trim() === "View");
  }

  it("renders rows with status, snapshots, tokens, cache hit, times and speed", async () => {
    const fixture = makeShell({
      records: [
        record(1),
        record(2, {
          outcome: "running",
          phase: "execution",
          terminalAt: undefined,
          completedAt: undefined,
        }),
      ],
    });
    await render(fixture.shell);
    const text = container.textContent ?? "";
    // Request id, protocol display name, request-time snapshots.
    expect(text).toContain("10000000-0000-4000-8000-000000000001");
    expect(text).toContain("Anthropic Messages");
    expect(text).toContain("alpha");
    expect(text).toContain("commandcode-private");
    expect(text).toContain("claude-fixture");
    // Statuses: derived Success and live Running with its phase label.
    expect(text).toContain("Success");
    expect(text).toContain("Running");
    expect(text).toContain("Executing");
    // Canonical usage numbers and the percentage cache-hit rate.
    expect(text).toContain("5");
    expect(text).toContain("3");
    expect(text).toContain("2");
    expect(text).toContain("100");
    expect(text).toContain("30.0%");
    // Exact speed: 100 tokens over (2000 ms / 1000).
    expect(text).toContain("50.0 tokens/s");
    // A running row has no completed time; its speed is unavailable.
    expect(text).toContain("-");
  });

  it("keeps partial usage components visible with its reason and no invented rate", async () => {
    const fixture = makeShell({
      records: [
        record(1, {
          terminalUsage: {
            api: "anthropic-messages",
            input: 7,
            cacheRead: 1,
            cacheWrite: 0,
            output: 100,
            completeness: "partial",
            reason: "component_unreported",
          },
        }),
      ],
    });
    await render(fixture.shell);
    const text = container.textContent ?? "";
    // Known components render as numbers even for Partial usage...
    expect(text).toContain("7");
    expect(text).toContain("1/0");
    expect(text).toContain("100");
    // ...but no cache-hit percentage is invented (only the validated
    // Ticket 20 rate renders) and the known output over the valid
    // duration still yields the single-request speed.
    expect(text).not.toContain("30.0%");
    expect(text).toContain("50.0 tokens/s");
    // The detail keeps the completeness reason visible.
    await act(async () => {
      viewButton()!.click();
    });
    const detail = container.querySelector('[aria-label="Request detail"]');
    expect(detail?.textContent ?? "").toContain("component_unreported");
    expect(detail?.textContent ?? "").toContain("Partial");
  });

  it("renders `-` for missing client values and never leaks the effective session", async () => {
    const fixture = makeShell({
      records: [
        record(1, {
          clientSessionId: undefined,
          effectiveSessionId: undefined,
          projectDir: undefined,
          externalAlias: undefined,
          providerId: undefined,
          realModelId: undefined,
          facts: undefined,
        }),
      ],
    });
    await render(fixture.shell);
    const text = container.textContent ?? "";
    expect(text).toContain("Anthropic Messages");
    expect(text).not.toContain("No requests yet");
    expect(text).not.toContain(effectiveSessionId);
    expect(text).not.toContain("effectiveSessionId");
    expect(text).not.toContain("Internal (effective)");
  });

  it("opens a detail pane that preserves every raw fact under its own label", async () => {
    const fixture = makeShell({
      records: [
        record(1, {
          outcome: "failed",
          clientHttpStatus: 502,
          facts: {
            piStopReason: "overloaded_error",
            failure: {
              classification: "http",
              stage: "dispatch",
              messageHash: "ab".repeat(32),
            },
            notices: [
              {
                adapter: "anthropic",
                direction: "request",
                code: "degraded-field",
                jsonPath: "$.usage",
                action: "degrade",
              },
            ],
            attempts: [
              { attempt: 1, classification: "http", stage: "dispatch", status: 429, retryable: true },
            ],
            persistenceWarnings: 1,
          },
          terminalUsage: {
            api: "commandcode-private",
            input: 5,
            cacheRead: 3,
            cacheWrite: 2,
            output: 100,
            completeness: "complete",
          },
        }),
      ],
    });
    await render(fixture.shell);
    expect(container.textContent ?? "").toContain("Server error");
    await act(async () => {
      viewButton()!.click();
    });
    const detail = container.querySelector('[aria-label="Request detail"]');
    expect(detail).not.toBeNull();
    const text = detail!.textContent ?? "";
    // Raw facts keep their own labels: never merged into the primary status.
    expect(text).toContain("Server error");
    expect(text).toContain("502");
    expect(text).toContain("Phase");
    expect(text).toContain("terminal-preparation");
    expect(text).toContain("Outcome (raw)");
    expect(text).toContain("failed");
    expect(text).toContain("Client HTTP status");
    expect(text).toContain("Pi stop reason (raw)");
    expect(text).toContain("overloaded_error");
    // The effective session id is a separately labeled internal field.
    expect(text).toContain("Internal session (effective)");
    expect(text).toContain(effectiveSessionId);
    // Bounded facts: notices, attempts, failure hash, persistence callout.
    expect(text).toContain("degraded-field");
    expect(text).toContain("429");
    expect(text).toContain("ab".repeat(32));
    expect(text).toContain("Some ledger records could not be persisted (1)");
    // Canonical usage reservation with completeness.
    expect(text).toContain("Complete");
    // The client session id renders under its own label too.
    expect(text).toContain(clientSessionId);
  });

  it("applies filters with a fresh head query and a reset window", async () => {
    const fixture = makeShell({
      records: [
        record(1, { providerId: "commandcode-private" }),
        record(2, { providerId: "other-provider", externalAlias: "beta" }),
      ],
    });
    await render(fixture.shell);
    expect(container.textContent ?? "").toContain("other-provider");
    // Typing and applying are separate user events: React re-renders
    // between them, so the Apply handler reads the freshly committed draft.
    await act(async () => {
      const provider = container.querySelector<HTMLInputElement>(
        'input[name="providerId"]',
      );
      // The native setter bypasses React's input value tracker, then the
      // input event commits the draft (as a real keystroke would).
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(provider, "commandcode-private");
      provider!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const apply = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Apply");
      apply!.click();
      await Promise.resolve();
    });
    expect(fixture.queries.length).toBeGreaterThanOrEqual(2);
    expect(fixture.queries.at(-1)).toMatchObject({
      providerId: "commandcode-private",
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("other-provider");
  });

  it("appends older pages with the afterId cursor and keeps newest-first order", async () => {
    const fixture = makeShell({
      records: [record(3), record(2), record(1)],
      hasMore: true,
    });
    await render(fixture.shell);
    // Initial page: newest record only is not simulated; the stub returns
    // everything, so assert the cursor query instead.
    const older = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Older");
    await act(async () => {
      older!.click();
      await Promise.resolve();
    });
    expect(fixture.queries.at(-1)).toMatchObject({ afterId: 1 });
  });

  it("upserts live events by ledger id, newest first, with one announcement", async () => {
    const fixture = makeShell({ records: [record(1)] });
    await render(fixture.shell);
    const before = container.textContent ?? "";
    expect(before).toContain("10000000-0000-4000-8000-000000000001");
    await act(async () => {
      fixture.push(record(3, { outcome: "running", phase: "rendering", terminalAt: undefined, completedAt: undefined }));
      fixture.push(record(2));
      fixture.push(record(1, { outcome: "aborted" }));
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    // New rows appear and a revision replaces its row without duplicating.
    expect(text).toContain("10000000-0000-4000-8000-000000000003");
    expect(text).toContain("Aborted");
    expect(text.match(/10000000-0000-4000-8000-000000000001/g)?.length).toBe(1);
    // One coalesced announcement for the batch.
    expect(text).toContain("Updated with 3 new requests.");
  });

  it("discards and fully resyncs after a disconnect and reconnect", async () => {
    const fixture = makeShell({ records: [record(1)] });
    await render(fixture.shell);
    expect(fixture.subscriptionCount()).toBe(1);
    expect(fixture.queries).toHaveLength(1);
    await act(async () => {
      fixture.setConnection(disconnectedState());
    });
    const offline = container.textContent ?? "";
    expect(offline).toContain("not connected");
    expect(offline).not.toContain("10000000-0000-4000-8000-000000000001");
    // Reconnect with a fresh sequence: subscribe again (listen-first) and
    // re-query page 1; nothing is resumed incrementally.
    await act(async () => {
      fixture.setConnection(connectedState(2));
      await Promise.resolve();
    });
    expect(fixture.subscriptionCount()).toBe(2);
    expect(fixture.queries.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent ?? "").toContain(
      "10000000-0000-4000-8000-000000000001",
    );
  });

  it("shows empty, loading, error and stream-failure states", async () => {
    // Empty state.
    const empty = makeShell({ records: [] });
    await render(empty.shell);
    expect(container.textContent ?? "").toContain(
      "No requests yet. Authorized model requests appear here.",
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();

    // Error state on the head query, with Refresh recovery.
    const failing = makeShell({
      records: [record(1)],
      queryError: new Error("boom"),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <App shell={failing.shell} retryConnection={async () => connectedState()} />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent ?? "").toContain("boom");
    await act(async () => {
      const refresh = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Refresh");
      refresh!.click();
      await Promise.resolve();
    });
    expect(container.textContent ?? "").toContain(
      "10000000-0000-4000-8000-000000000001",
    );

    // Stream failure after a successful subscription surfaces non-fatally.
    const stream = makeShell({ records: [] });
    await act(async () => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <App shell={stream.shell} retryConnection={async () => connectedState()} />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      stream.failStream(new Error("invalid ledger event"));
      await Promise.resolve();
    });
    expect(container.textContent ?? "").toContain("invalid ledger event");
  });

  it("keeps a newer terminal event over a delayed stale head query (refresh)", async () => {
    const running = record(1, {
      outcome: "running",
      phase: "execution",
      terminalAt: undefined,
      completedAt: undefined,
    });
    const fixture = makeShell({ records: [running], deferFromQuery: 2 });
    await render(fixture.shell);
    expect(container.textContent ?? "").toContain("Executing");

    // Refresh issues head query #2; its server snapshot predates the
    // terminal event below (deferred until the test resolves it).
    await act(async () => {
      const refresh = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Refresh");
      refresh!.click();
      await Promise.resolve();
    });
    // The terminal event commits while the stale query is in flight.
    await act(async () => {
      fixture.push(
        record(1, { outcome: "success", phase: "terminal-preparation" }),
      );
      await Promise.resolve();
    });
    // The stale snapshot (the pre-event running revision) resolves last.
    await act(async () => {
      fixture.resolveDeferredQuery({ records: [running], hasMore: false });
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Success");
    expect(text).not.toContain("Executing");
  });

  it("keeps a newer terminal event over a delayed stale resync after reconnect", async () => {
    const running = record(1, {
      outcome: "running",
      phase: "execution",
      terminalAt: undefined,
      completedAt: undefined,
    });
    const fixture = makeShell({ records: [running], deferFromQuery: 2 });
    await render(fixture.shell);
    await act(async () => {
      fixture.setConnection(disconnectedState());
    });
    await act(async () => {
      fixture.setConnection(connectedState(2));
      await Promise.resolve();
    });
    // The resync head query (#2) is deferred; the terminal event lands
    // first, then the stale snapshot resolves and must not regress it.
    await act(async () => {
      fixture.push(
        record(1, { outcome: "success", phase: "terminal-preparation" }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      fixture.resolveDeferredQuery({ records: [running], hasMore: false });
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Success");
    expect(text).not.toContain("Executing");
  });

  it("keeps a newer terminal event over a delayed stale filter query", async () => {
    const running = record(1, {
      outcome: "running",
      phase: "execution",
      terminalAt: undefined,
      completedAt: undefined,
    });
    const fixture = makeShell({
      records: [
        running,
        record(2, { providerId: "other-provider", externalAlias: "beta" }),
      ],
      deferFromQuery: 2,
    });
    await render(fixture.shell);
    // Apply a provider filter: the filtered head query (#2) is deferred.
    await act(async () => {
      const provider = container.querySelector<HTMLInputElement>(
        'input[name="providerId"]',
      );
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(provider, "commandcode-private");
      provider!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const apply = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Apply");
      apply!.click();
      await Promise.resolve();
    });
    // The terminal event (matching the filter) lands while the filtered
    // query is in flight; the stale snapshot must not regress it.
    await act(async () => {
      fixture.push(
        record(1, { outcome: "success", phase: "terminal-preparation" }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      fixture.resolveDeferredQuery({ records: [running], hasMore: false });
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Success");
    expect(text).not.toContain("Executing");
    expect(text).not.toContain("other-provider");
  });

  it("keeps a newer terminal event over a delayed stale older-page result", async () => {
    const running = record(3, {
      outcome: "running",
      phase: "execution",
      terminalAt: undefined,
      completedAt: undefined,
    });
    const fixture = makeShell({
      records: [record(5), record(4), running, record(2), record(1)],
      hasMore: true,
      deferFromQuery: 2,
    });
    await render(fixture.shell);
    expect(container.textContent ?? "").toContain("Executing");
    // "Older" issues the cursor query (#2, deferred).
    await act(async () => {
      const older = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Older");
      older!.click();
      await Promise.resolve();
    });
    // A terminal event for a row inside the older window lands first.
    await act(async () => {
      fixture.push(
        record(3, { outcome: "success", phase: "terminal-preparation" }),
      );
      await Promise.resolve();
    });
    // The stale snapshot carries the pre-event running revision of id 3.
    await act(async () => {
      fixture.resolveDeferredQuery({
        records: [running, record(2), record(1)],
        hasMore: false,
      });
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Success");
    expect(text).not.toContain("Executing");
  });
});
