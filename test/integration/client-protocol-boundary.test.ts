import { describe, expect, it } from "vitest";

import type { ClientProtocolHandler } from "../../src/http.js";
import { createTokenRuntime } from "../../src/runtime.js";

function clientProtocol(
  pathname: string,
  protocol: string,
): ClientProtocolHandler {
  return {
    method: "POST",
    pathname,
    handle: async (request) =>
      Response.json({ protocol, requestPath: new URL(request.url).pathname }),
  };
}

describe("Client Protocol boundary", () => {
  it("routes unrelated Client Protocols without teaching Runtime their semantics", async () => {
    const runtime = createTokenRuntime({
      clientProtocols: [
        clientProtocol("/v1/messages", "anthropic-fixture"),
        clientProtocol("/v1/responses", "openai-responses-fixture"),
      ],
    });

    const anthropic = await runtime.handle(
      new Request("http://Token.test/v1/messages", { method: "POST" }),
    );
    const openai = await runtime.handle(
      new Request("http://Token.test/v1/responses", { method: "POST" }),
    );

    await expect(anthropic.json()).resolves.toEqual({
      protocol: "anthropic-fixture",
      requestPath: "/v1/messages",
    });
    await expect(openai.json()).resolves.toEqual({
      protocol: "openai-responses-fixture",
      requestPath: "/v1/responses",
    });
    expect(Object.keys(runtime).sort()).toEqual(["handle", "routes"]);
    expect(runtime.routes).toEqual([
      { method: "POST", pathname: "/v1/messages" },
      { method: "POST", pathname: "/v1/responses" },
    ]);
    expect(runtime).not.toHaveProperty("clientProtocols");
  });

  it("rejects duplicate route ownership at composition time", () => {
    expect(() =>
      createTokenRuntime({
        clientProtocols: [
          clientProtocol("/v1/messages", "first"),
          clientProtocol("/v1/messages", "second"),
        ],
      }),
    ).toThrow("Duplicate Client Protocol route");
  });
});
