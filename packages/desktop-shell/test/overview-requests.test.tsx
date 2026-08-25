// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestJourneyRecord, RequestJourneySummary, StatusSnapshot } from "@luckytoken/application-control-plane/control-plane";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;
const status: StatusSnapshot = { sequence: 1, modelDataPlane: "running", provider: "configured", dataPlane: { configuredOrigin: "http://127.0.0.1:4317", configuredPort: 4317 } };
const today = new Date();
today.setHours(12, 0, 0, 0);

function summary(
  id: number,
  outcome: RequestJourneySummary["outcome"],
  usage?: RequestJourneySummary["usage"],
): RequestJourneySummary {
  return { id, runtimeId: "runtime-1", requestId: `request-${id}`, operation: "model_generation", protocol: "anthropic-messages", lane: "provider_native", outcome, completeness: "complete", createdAt: today.getTime() + id, ...(outcome === "running" ? {} : { closedAt: today.getTime() + 1_000 + id }), ...(usage === undefined ? {} : { usage }) };
}

function detail(base: RequestJourneySummary): RequestJourneyRecord {
  const location = { phase: "upstream_execution" as const, lane: "provider_native" as const, step: "send_provider_request", attempt: 2 };
  return {
    ...base,
    requestedModel: "commandcode-goat/deepseek-v4-pro",
    providerId: "commandcode-goat",
    realModelId: "deepseek/deepseek-v4-pro",
    clientSessionId: "session-client-1",
    effectiveSessionId: "session-effective-1",
    profileId: "profile-1",
    profileDisplayName: "Production",
    httpStatus: 504,
    primaryFailureLocation: location,
    admission: { operationCandidate: "model_generation", transport: "http", method: "POST", path: "/v1/messages", acceptedAt: base.createdAt, cancellation: { caller: "active", shutdown: "active" } },
    timeline: [{ runtimeId: base.runtimeId, requestId: base.requestId, sequence: 1, time: base.createdAt, observation: { kind: "profile_attributed", location, profileId: "profile-1", displayName: "Production" } }],
    artifacts: [{ artifactId: "response-body", artifactKind: "response_body", state: "captured", redaction: "applied", truncated: false }],
    incident: { primaryFailureId: "failure-1", failures: [{ kind: "failure_detected", failureId: "failure-1", role: "primary", classification: "provider_timeout", origin: "provider", originPrecision: "external_boundary", safeMessage: "The provider timed out", location }] },
    workOutcome: { outcome: "failed", terminalAuthority: "provider_native_handler", location },
    clientPresentation: { status: 504, mediaType: "application/json", location },
    handoffOutcome: { outcome: "finished", transport: "http", writableFinished: true, location },
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function flush(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe("Overview Request Journeys", () => {
  it("shows complete row usage before request details are loaded", async () => {
    const completed = summary(9, "success", {
      completeness: "complete",
      inputTokens: 11,
      cacheReadTokens: 3,
      outputTokens: 7,
      cacheHitRate: 3 / 14,
      outputTokensPerSecond: 7,
    });
    const completedSummary: RequestJourneySummary = {
      ...completed,
      requestedModel: "commandcode-goat/deepseek-v4-pro",
      providerId: "commandcode-goat",
      realModelId: "deepseek/deepseek-v4-pro",
      clientSessionId: "session-client-9",
      effectiveSessionId: "session-effective-9",
      profileId: "credential-production",
      profileDisplayName: "Production",
      httpStatus: 200,
    };
    const getRequestJourney = vi.fn();
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [completedSummary], hasMore: false } }),
      getRequestJourney,
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();

    const cells = [...container.querySelectorAll('tr[data-request-id="request-9"] > td')];
    expect(cells.slice(4, 9).map((cell) => cell.textContent)).toEqual([
      "11",
      "3",
      "21.4%",
      "7",
      "7.0 t/s",
    ]);
    expect(cells[1]?.textContent).toBe("session-client-9");
    expect(cells[10]?.textContent).toBe("commandcode-goat/deepseek-v4-pro");
    expect(cells[11]?.textContent).toBe("200");
    expect(getRequestJourney).not.toHaveBeenCalled();
  });

  it("hides incomplete row usage and explains why it is unavailable", async () => {
    const partial = summary(8, "success", {
      completeness: "partial",
      reason: "component_unreported",
    });
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [partial], hasMore: false } }),
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();

    const usageCells = [...container.querySelectorAll('tr[data-request-id="request-8"] > td')].slice(4, 9);
    expect(usageCells.map((cell) => cell.textContent)).toEqual(["—", "—", "—", "—", "—"]);
    for (const cell of usageCells) {
      expect(cell.getAttribute("title")).toBe("Provider did not report all required usage components.");
      expect(cell.getAttribute("aria-label")).toBe("Provider did not report all required usage components.");
    }
  });

  it("explains unavailable derived metrics without hiding complete token counts", async () => {
    const completed = summary(7, "success", {
      completeness: "complete",
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 2,
    });
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [completed], hasMore: false } }),
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();

    const usageCells = [...container.querySelectorAll('tr[data-request-id="request-7"] > td')].slice(4, 9);
    expect(usageCells.map((cell) => cell.textContent)).toEqual(["0", "0", "—", "2", "—"]);
    expect(usageCells[2]?.getAttribute("title")).toBe("Cache hit is unavailable because no input or cache-read tokens were reported.");
    expect(usageCells[4]?.getAttribute("title")).toBe("Token speed is unavailable because execution timing was incomplete.");
  });

  it("shows terminal usage as pending for a running request", async () => {
    const running = summary(6, "running");
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [running], hasMore: false } }),
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();

    const usageCells = [...container.querySelectorAll('tr[data-request-id="request-6"] > td')].slice(4, 9);
    expect(usageCells.map((cell) => cell.textContent)).toEqual(["—", "—", "—", "—", "—"]);
    for (const cell of usageCells) {
      expect(cell.getAttribute("title")).toBe("Terminal usage is pending.");
    }
  });

  it("lists summaries, merges live updates, and loads structured detail on expansion", async () => {
    const failed = summary(10, "failed");
    const listeners = new Set<(record: RequestJourneySummary) => void>();
    const getRequestJourney = vi.fn(async () => ({ outcome: "ok" as const, result: detail(failed) }));
    const api = createFakeDesktopApi({ control: { getBackendState: async () => ({ revision: 1, kind: "ready", status }), onBackendState: () => () => undefined, queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [failed], hasMore: false } }), getRequestJourney, onRequestJourneys: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } } });
    await act(async () => root.render(<App api={api} />));
    await flush();
    expect(container.textContent).toContain("request-10");
    expect(getRequestJourney).not.toHaveBeenCalled();
    await act(async () => { (container.querySelector('button[aria-label="Show details for request request-10"]') as HTMLButtonElement).click(); });
    await flush();
    expect(getRequestJourney).toHaveBeenCalledWith({ requestId: "request-10" });
    expect(container.textContent).toContain("provider_timeout");
    expect(container.textContent).toContain("The provider timed out");
    expect(container.textContent).toContain("Why this request failed");
    expect(container.textContent).toContain("Upstream execution · Send provider request · Provider native · Attempt 2");
    expect(container.textContent).toContain("Response body");
    expect(container.textContent).toContain("Captured · Redacted");
    expect(container.textContent).toContain("Production");
    expect(container.textContent).toContain("What happened");
    expect(container.textContent).toContain("These are stored observations in sequence, not inferred causes.");
    await act(async () => { for (const listener of listeners) listener(summary(11, "running")); });
    expect(container.textContent).toContain("request-11");
    await act(async () => {
      for (const listener of listeners) listener(summary(11, "success", {
        completeness: "complete",
        inputTokens: 5,
        cacheReadTokens: 1,
        outputTokens: 4,
        cacheHitRate: 1 / 6,
        outputTokensPerSecond: 8,
      }));
    });
    const updatedCells = [...container.querySelectorAll('tr[data-request-id="request-11"] > td')];
    expect(updatedCells.slice(4, 9).map((cell) => cell.textContent)).toEqual([
      "5",
      "1",
      "16.7%",
      "4",
      "8.0 t/s",
    ]);
  });

  it("does not let a delayed stale snapshot replace a newer terminal request update", async () => {
    const stale: RequestJourneySummary = {
      ...summary(13, "success"),
      requestedModel: "deepseek/deepseek-v4-flash",
      providerId: "commandcode-goat",
      realModelId: "deepseek/deepseek-v4-flash",
      httpStatus: 426,
    };
    const current: RequestJourneySummary = {
      ...stale,
      requestedModel: "commandcode-goat/deepseek-v4-flash",
      httpStatus: 200,
      closedAt: stale.closedAt! + 1_000,
      usage: {
        completeness: "complete",
        inputTokens: 120,
        cacheReadTokens: 30,
        outputTokens: 20,
        cacheHitRate: 0.2,
        outputTokensPerSecond: 10,
      },
    };
    const listeners = new Set<(record: RequestJourneySummary) => void>();
    let resolveSnapshot: ((value: {
      outcome: "ok";
      result: { records: RequestJourneySummary[]; hasMore: false };
    }) => void) | undefined;
    const delayedSnapshot = new Promise<{
      outcome: "ok";
      result: { records: RequestJourneySummary[]; hasMore: false };
    }>((resolve) => {
      resolveSnapshot = resolve;
    });
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => delayedSnapshot,
      onRequestJourneys: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();
    expect(listeners.size).toBe(1);

    await act(async () => {
      for (const listener of listeners) listener(current);
    });
    resolveSnapshot?.({ outcome: "ok", result: { records: [stale], hasMore: false } });
    await flush();

    const cells = [...container.querySelectorAll('tr[data-request-id="request-13"] > td')];
    expect(cells.slice(4, 9).map((cell) => cell.textContent)).toEqual([
      "120",
      "30",
      "20.0%",
      "20",
      "10.0 t/s",
    ]);
    expect(cells[10]?.textContent).toBe("commandcode-goat/deepseek-v4-flash");
    expect(cells[11]?.textContent).toBe("200");
  });

  it("omits expected unsupported WebSocket upgrade probes from Overview", async () => {
    const probe: RequestJourneySummary = {
      ...summary(14, "failed"),
      operation: "unsupported_transport",
      protocol: "unsupported",
      httpStatus: 426,
    };
    const request: RequestJourneySummary = {
      ...summary(15, "success", {
        completeness: "complete",
        inputTokens: 8,
        cacheReadTokens: 2,
        outputTokens: 4,
      }),
      requestedModel: "commandcode-goat/deepseek-v4-flash",
      providerId: "commandcode-goat",
      realModelId: "deepseek/deepseek-v4-flash",
      httpStatus: 200,
    };
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({
        outcome: "ok",
        result: { records: [probe, request], hasMore: false },
      }),
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();

    expect(container.querySelector('tr[data-request-id="request-14"]')).toBeNull();
    expect(container.querySelector('tr[data-request-id="request-15"]')).not.toBeNull();
    expect(container.textContent).not.toContain("426");
  });

  it("exposes every truncated request value through a native tooltip", async () => {
    const request: RequestJourneySummary = {
      ...summary(16, "success", {
        completeness: "complete",
        inputTokens: 120_000,
        cacheReadTokens: 30_000,
        outputTokens: 20_000,
        cacheHitRate: 0.2,
        outputTokensPerSecond: 10.25,
      }),
      protocol: "openai-responses",
      requestedModel: "commandcode-goat/deepseek-v4-flash-with-a-very-long-suffix",
      providerId: "commandcode-goat",
      realModelId: "deepseek/deepseek-v4-flash-with-a-very-long-suffix",
      clientSessionId: "session-with-a-very-long-identifier",
      profileId: "profile-production-long",
      profileDisplayName: "Production profile with a long display name",
      httpStatus: 200,
    };
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({
        outcome: "ok",
        result: { records: [request], hasMore: false },
      }),
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();

    const cells = [...container.querySelectorAll('tr[data-request-id="request-16"] > td')];
    for (const cell of cells.slice(1)) {
      expect(cell.getAttribute("title"), cell.className).toBe(cell.textContent);
    }
    expect(cells[10]?.getAttribute("title")).toBe(
      "commandcode-goat/deepseek-v4-flash-with-a-very-long-suffix",
    );
  });

  it("keeps successful request facts separate from failure diagnosis and does not invent a Profile", async () => {
    const succeeded: RequestJourneySummary = {
      ...summary(12, "success"),
      requestedModel: "commandcode-goat/gpt-5.6-sol",
      providerId: "commandcode-goat",
      realModelId: "openai/gpt-5.6-sol",
      httpStatus: 200,
    };
    const location = {
      phase: "outcome_commit" as const,
      lane: "semantic_conversion" as const,
      step: "commit_request_outcome",
    };
    const succeededDetail: RequestJourneyRecord = {
      ...succeeded,
      admission: {
        operationCandidate: "model_generation",
        transport: "http",
        method: "POST",
        path: "/v1/responses",
        acceptedAt: succeeded.createdAt,
        cancellation: { caller: "active", shutdown: "active" },
      },
      timeline: [],
      artifacts: [],
      workOutcome: {
        outcome: "success",
        terminalAuthority: "openai_responses_handler",
        location,
      },
      clientPresentation: {
        status: 200,
        mediaType: "application/json",
        location,
      },
      handoffOutcome: {
        outcome: "finished",
        transport: "http",
        writableFinished: true,
        location,
      },
    };
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => ({ outcome: "ok", result: { records: [succeeded], hasMore: false } }),
      getRequestJourney: async () => ({ outcome: "ok", result: succeededDetail }),
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();
    await act(async () => {
      (container.querySelector('button[aria-label="Show details for request request-12"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(container.querySelector(".request-primary-failure")).toBeNull();
    expect(container.querySelector(".request-detail-facts > div:nth-child(3) strong")?.textContent).toBe("Not recorded");
    expect(container.querySelectorAll(".request-journey li")).toHaveLength(5);
    expect(container.textContent).toContain("commandcode-goat / openai/gpt-5.6-sol");
    expect(container.textContent).toContain("HTTP 200");
  });

  it("renders typed diagnostics unavailability", async () => {
    const api = createFakeDesktopApi({ control: { getBackendState: async () => ({ revision: 1, kind: "ready", status }), onBackendState: () => () => undefined, queryRequestJourneys: async () => ({ outcome: "unavailable", error: { code: "diagnostics_unavailable", classification: "diagnostics_storage_unavailable", message: "Diagnostics storage is unavailable" } }) } });
    await act(async () => root.render(<App api={api} />));
    await flush();
    expect(container.textContent).toContain("Request history is temporarily unavailable.");
    expect(container.textContent).not.toContain("No requests");
  });

  it("keeps the last successful request snapshot visible when reconciliation fails", async () => {
    let unavailable = false;
    const completed = summary(17, "success", {
      completeness: "complete",
      inputTokens: 10,
      cacheReadTokens: 0,
      outputTokens: 5,
    });
    const api = createFakeDesktopApi({ control: {
      getBackendState: async () => ({ revision: 1, kind: "ready", status }),
      onBackendState: () => () => undefined,
      queryRequestJourneys: async () => unavailable
        ? { outcome: "unavailable", error: { code: "diagnostics_unavailable", classification: "diagnostics_storage_unavailable", message: "Diagnostics storage is unavailable" } }
        : { outcome: "ok", result: { records: [completed], hasMore: false } },
    } });

    await act(async () => root.render(<App api={api} />));
    await flush();
    expect(container.querySelector('tr[data-request-id="request-17"]')).not.toBeNull();

    unavailable = true;
    await act(async () => {
      (container.querySelector('button[aria-label="Refresh overview"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('tr[data-request-id="request-17"]')).not.toBeNull();
    expect(container.textContent).toContain("Showing the last successful snapshot.");
  });
});
