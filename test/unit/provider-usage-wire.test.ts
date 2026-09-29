import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  fetchProviderUsageJson,
  normalizePercent,
  normalizeResetAt,
  PROVIDER_USAGE_RESPONSE_MAX_BYTES,
} from "../../src/provider-usage/wire.js";

function fetchResponse(response: Response): FetchFunction {
  return async (_input, init) => {
    expect(init?.redirect).toBe("error");
    return response;
  };
}

describe("Provider Usage wire", () => {
  it("clamps finite percentages into the 0..100 domain", () => {
    expect(normalizePercent(-0.1)).toBe(0);
    expect(normalizePercent(100.1)).toBe(100);
    expect(normalizePercent(0)).toBe(0);
    expect(normalizePercent(100)).toBe(100);
    expect(normalizePercent(Number.NaN)).toBeUndefined();
  });

  it("omits invalid reset timestamps", () => {
    expect(normalizeResetAt(0)).toBeUndefined();
    expect(normalizeResetAt(-1)).toBeUndefined();
    expect(normalizeResetAt("not-a-date")).toBeUndefined();
  });

  it("classifies malformed JSON and oversized bodies as schema failures", async () => {
    const malformed = await fetchProviderUsageJson(
      fetchResponse(
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
      "https://fixture.invalid/usage",
      { method: "GET" },
      new AbortController().signal,
    );
    expect(malformed.reason).toBe("schema");

    let cancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(PROVIDER_USAGE_RESPONSE_MAX_BYTES + 1),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversized = await fetchProviderUsageJson(
      fetchResponse(new Response(oversizedStream, { status: 200 })),
      "https://fixture.invalid/usage",
      { method: "GET" },
      new AbortController().signal,
    );
    expect(oversized.reason).toBe("schema");
    expect(cancelled).toBe(true);
  });

  it("classifies body-read transport failure as network", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body transport failed"));
      },
    });
    const result = await fetchProviderUsageJson(
      fetchResponse(new Response(stream, { status: 200 })),
      "https://fixture.invalid/usage",
      { method: "GET" },
      new AbortController().signal,
    );

    expect(result.reason).toBe("network");
  });

  it("propagates body-read abort as network and cancels the reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const pending = fetchProviderUsageJson(
      fetchResponse(new Response(stream, { status: 200 })),
      "https://fixture.invalid/usage",
      { method: "GET" },
      controller.signal,
    );

    controller.abort(new Error("timeout"));

    await expect(pending).resolves.toMatchObject({ reason: "network" });
    expect(cancelled).toBe(true);
  });

  it("treats fetch redirect rejection as network and always requests redirect:error", async () => {
    const fetch: FetchFunction = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("redirect rejected");
    };
    const result = await fetchProviderUsageJson(
      fetch,
      "https://fixture.invalid/usage",
      { method: "GET" },
      new AbortController().signal,
    );
    expect(result.reason).toBe("network");
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "upstream"],
    [500, "upstream"],
  ] as const)("classifies HTTP %i as %s", async (status, reason) => {
    const result = await fetchProviderUsageJson(
      fetchResponse(new Response("{}", { status })),
      "https://fixture.invalid/usage",
      { method: "GET" },
      new AbortController().signal,
    );
    expect(result.reason).toBe(reason);
  });
});
