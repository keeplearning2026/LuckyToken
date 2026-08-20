import type { Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  createOpenAIResponsesHandler,
  type OpenAIResponsesHandlerOptions,
} from "../../src/protocols/openai-responses/handler.js";

function request(model = "local-model"): Request {
  return new Request("http://luckytoken.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hello" }),
  });
}

describe("OpenAI Responses three-lane routing", () => {
  it("lets a claiming Local Native lane own the request without touching Pi Models", async () => {
    const claims = vi.fn((selector: string) => selector === "local-model");
    const execute = vi.fn(async () =>
      new Response("local-upstream", {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
    );
    const models = new Proxy({} as Models, {
      get() {
        throw new Error("Pi Models must not be touched after Local Native claims");
      },
    });
    const options = {
      models,
      localNativeLane: { claims, execute },
      stateFile: "unused-local-routing.json",
      maxRequestBytes: 1024,
    } as unknown as OpenAIResponsesHandlerOptions;
    const handler = createOpenAIResponsesHandler(options);

    const response = await handler.handle(request());

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe("local-upstream");
    expect(claims).toHaveBeenCalledWith("local-model");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("lets a claiming Provider Native lane own the resolved model without entering Pi execution", async () => {
    const model: Model<string> = {
      id: "upstream-model",
      name: "upstream-model",
      api: "openai-responses",
      provider: "provider-native",
      baseUrl: "https://provider.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    };
    const streamSimple = vi.fn(() => {
      throw new Error("Pi execution must not run after Provider Native claims");
    });
    const getAuth = vi.fn(() => {
      throw new Error("handler must not resolve Provider Native credentials");
    });
    const models = {
      getModels: () => [model],
      streamSimple,
      getAuth,
    } as unknown as Models;
    const claims = vi.fn(() => true);
    const execute = vi.fn(async () => new Response("provider-upstream", { status: 503 }));
    const handler = createOpenAIResponsesHandler({
      models,
      providerNativeLane: { claims, execute },
      stateFile: "unused-provider-routing.json",
      maxRequestBytes: 1024,
    } as unknown as OpenAIResponsesHandlerOptions);

    const response = await handler.handle(request("provider-native/upstream-model"));

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("provider-upstream");
    expect(claims).toHaveBeenCalledWith(model, "responses");
    expect(execute).toHaveBeenCalledOnce();
    expect(getAuth).not.toHaveBeenCalled();
    expect(streamSimple).not.toHaveBeenCalled();
  });
});
