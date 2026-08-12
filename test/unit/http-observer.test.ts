import { describe, expect, it, vi } from "vitest";

import { HttpObserver } from "../../src/http-observer.js";

function jsonResponse(status: number, body?: unknown): Response {
  const init: ResponseInit = { status, statusText: `status ${status}` };
  return new Response(body === undefined ? null : JSON.stringify(body), init);
}

describe("HttpObserver", () => {
  it("records a successful response without reading its body", async () => {
    const baseFetch = vi.fn(async () => jsonResponse(200, { ok: true }));
    const observer = new HttpObserver(baseFetch as typeof fetch);

    const response = await observer.observedFetch("https://fixture.test");

    expect(response.status).toBe(200);
    expect(observer.latestObservation).toEqual({
      kind: "response",
      status: 200,
      statusText: "status 200",
      headers: expect.any(Headers),
    });
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("clones and snapshots a non-2xx body before resolving", async () => {
    const baseFetch = vi.fn(async () =>
      jsonResponse(429, { error: { message: "rate limited" } }),
    );
    const observer = new HttpObserver(baseFetch as typeof fetch);

    const response = await observer.observedFetch("https://fixture.test");

    expect(response.status).toBe(429);
    const observation = observer.latestObservation;
    expect(observation?.kind).toBe("response");
    if (observation?.kind !== "response") return;
    expect(observation.status).toBe(429);
    expect(observation.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(observation.body)).toContain("rate limited");
  });

  it("records a transport error and rethrows", async () => {
    const cause = new Error("ECONNRESET");
    const baseFetch = vi.fn(async () => {
      throw cause;
    });
    const observer = new HttpObserver(baseFetch as typeof fetch);

    await expect(observer.observedFetch("https://fixture.test")).rejects.toThrow(
      "ECONNRESET",
    );
    expect(observer.latestObservation).toEqual({
      kind: "transport-error",
      error: cause,
    });
  });

  it("keeps the latest fetch call, not the latest completion", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const baseFetch = vi.fn(() => {
      // First call resolves after the second call starts.
      return new Promise<Response>((resolve) => {
        if (resolveFirst === undefined) {
          resolveFirst = resolve;
        } else {
          resolveSecond = resolve;
        }
      });
    });
    const observer = new HttpObserver(baseFetch as typeof fetch);

    const first = observer.observedFetch("https://fixture.test/1");
    const second = observer.observedFetch("https://fixture.test/2");

    // Second call completes first with 503; latest must be the second call.
    resolveSecond(jsonResponse(503, { error: "retry" }));
    await second;
    expect(observer.latestObservation).toMatchObject({
      kind: "response",
      status: 503,
    });

    // First call completes later with 200; latest must NOT revert to it.
    resolveFirst(jsonResponse(200, { ok: true }));
    await first;
    expect(observer.latestObservation).toMatchObject({
      kind: "response",
      status: 503,
    });
  });

  it("returns undefined before any fetch call resolves", () => {
    const observer = new HttpObserver();
    expect(observer.latestObservation).toBeUndefined();
  });
});
