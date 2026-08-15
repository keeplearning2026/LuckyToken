import { afterEach, describe, expect, it } from "vitest";

import { createLuckyTokenRuntime } from "../../../src/runtime.js";
import type { ClientProtocolHandler } from "../../../src/http.js";
import {
  createSettingsRegistry,
  type SettingsRegistry,
  type SettingsStore,
} from "../../../src/settings/catalog.js";
import { createProtocolAwareRuntime } from "../../../src/settings/runtime.js";

function emptyStore(): SettingsStore {
  return {
    async load() {
      return {};
    },
    async save() {},
  };
}

const anthropic: ClientProtocolHandler = {
  method: "POST",
  pathname: "/v1/messages",
  handle: async () => new Response("anthropic"),
};
const responses: ClientProtocolHandler = {
  method: "POST",
  pathname: "/v1/responses",
  handle: async () => new Response("responses"),
};
const models: ClientProtocolHandler = {
  method: "GET",
  pathname: "/v1/models",
  handle: async () => new Response("models"),
};

function enabledRuntime(
  registry: SettingsRegistry,
  protocols: readonly ClientProtocolHandler[],
) {
  return createProtocolAwareRuntime({
    runtime: createLuckyTokenRuntime({ clientProtocols: [...protocols, models] }),
    registry,
    protocolRoutes: [
      { id: "anthropic-messages", method: "POST", pathname: "/v1/messages" },
      { id: "openai-responses", method: "POST", pathname: "/v1/responses" },
    ],
  });
}

describe("settings-driven protocol routes", () => {
  const httpServers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(httpServers.splice(0).map((server) => server.close()));
  });

  it("serves Anthropic and OpenAI Responses model routes by default", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const runtime = enabledRuntime(registry, [anthropic, responses]);

    await expect(runtime.handle(new Request("http://x/v1/messages", { method: "POST" }))).resolves.toMatchObject({ status: 200 });
    await expect(runtime.handle(new Request("http://x/v1/responses", { method: "POST" }))).resolves.toMatchObject({ status: 200 });
  });

  it("disables each protocol independently with the same commands used by the UI", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const runtime = enabledRuntime(registry, [anthropic, responses]);

    const disabled = await registry.set(
      "protocols.anthropic-messages.enabled",
      false,
      undefined,
    );
    expect(disabled).toMatchObject({ outcome: "applied" });

    await expect(
      runtime.handle(new Request("http://x/v1/messages", { method: "POST" })),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      runtime.handle(new Request("http://x/v1/responses", { method: "POST" })),
    ).resolves.toMatchObject({ status: 200 });

    await registry.set("protocols.openai-responses.enabled", false, undefined);
    await expect(
      runtime.handle(new Request("http://x/v1/responses", { method: "POST" })),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("stops every model route when all protocols are disabled while local Control Plane stays usable", async () => {
    const registry = createSettingsRegistry(emptyStore());
    const runtime = enabledRuntime(registry, [anthropic, responses]);
    await registry.set("protocols.anthropic-messages.enabled", false, undefined);
    await registry.set("protocols.openai-responses.enabled", false, undefined);

    await expect(
      runtime.handle(new Request("http://x/v1/messages", { method: "POST" })),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      runtime.handle(new Request("http://x/v1/responses", { method: "POST" })),
    ).resolves.toMatchObject({ status: 404 });
    // The shared model discovery route remains, and Control Plane commands
    // are unaffected (they live on the local pipe, not the HTTP Data Plane).
    expect(runtime.routes.some((route) => route.pathname === "/v1/models")).toBe(
      true,
    );
    expect(registry.snapshot().settings).toBeDefined();
  });
});
