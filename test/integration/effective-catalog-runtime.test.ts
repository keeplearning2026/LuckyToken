import {
  InMemoryCredentialStore,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { createConfiguredLuckyTokenDataPlane } from "../../src/composition.js";

/**
 * Ticket 09 data plane seam: the runtime registers the same effective
 * composition the Control Plane projects, so the served catalog can never
 * diverge from the projected catalog — built-in overlays, identity upserts,
 * appended custom models, and per-Provider composition isolation.
 */
describe("effective composition in the data plane", () => {
  const directories: string[] = [];
  const compositions: Array<{ diagnosticsStore: { close(): void }; requestLedger: { close(): void }; deepCaptureStore: { close(): void } }> = [];

  afterEach(async () => {
    compositions.splice(0).forEach((composition) => {
      composition.diagnosticsStore.close();
      composition.requestLedger.close();
        composition.deepCaptureStore.close();
    });
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function writeRuntimeFixture(
    modelsJson: Record<string, unknown>,
  ): Promise<{
    readonly configPath: string;
    readonly clientToken: string;
    readonly modelsJsonPath: string;
  }> {
    const directory = await mkdtemp(
      join(tmpdir(), "luckytoken-effective-runtime-"),
    );
    directories.push(directory);
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const clientAuthPath = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    await createFileClientTokenStore({ path: clientAuthPath }).create(
      { type: "global" },
      "client-token",
    );
    const modelsJsonPath = join(piDirectory, "models.json");
    await writeFile(modelsJsonPath, JSON.stringify(modelsJson), "utf8");
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
        },
        pi: { directory: "pi", modelsJson: "pi/models.json" },
      }),
      "utf8",
    );
    return { configPath, clientToken: "client-token", modelsJsonPath };
  }

  function anthropicJsonResponse(text: string): Response {
    return new Response(
      JSON.stringify({
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        model: "claude-opus-4-7",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 5 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  async function serve(
    fixture: Awaited<ReturnType<typeof writeRuntimeFixture>>,
    fetch: FetchFunction,
    options?: { readonly credentials?: InMemoryCredentialStore },
  ) {
    const composition = await createConfiguredLuckyTokenDataPlane({
      config: await loadLuckyTokenCliConfig(fixture.configPath),
      fetch,
      ...(options?.credentials === undefined
        ? {}
        : { credentials: options.credentials }),
      createMessageId: () => "msg_effective",
      createSessionId: () => "00000000-0000-4000-8000-000000000270",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);
    return composition;
  }

  function anthropicRequest(
    clientToken: string,
    model: string,
  ): Request {
    return new Request("http://luckytoken.test/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientToken}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
  }

  it("overlays a matching built-in Provider and serves through the overlaid baseUrl", async () => {
    const upstreamRequests: Request[] = [];
    const fixture = await writeRuntimeFixture({
      providers: {
        anthropic: {
          baseUrl: "https://anthropic-gateway.example.com",
          apiKey: "gateway-key",
          modelOverrides: {
            "claude-opus-4-7": { name: "Claude Opus 4.7 (Gateway)" },
          },
        },
      },
    });
    const composition = await serve(fixture, async (input, init) => {
      const request = new Request(input, init);
      if (String(input).includes("/provider/v1/models")) {
        return new Response(
          JSON.stringify({ object: "list", data: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      upstreamRequests.push(request);
      return anthropicJsonResponse("overlaid");
    });
    expect(composition.userConfiguredProviderIds).toEqual(["anthropic"]);

    const response = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "anthropic/claude-opus-4-7"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      content: [{ type: "text", text: "overlaid" }],
    });
    // The built-in model was served through the overlaid baseUrl with the
    // configured key — the built-in model facts (api, name aside from the
    // override) survived the overlay.
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://anthropic-gateway.example.com/v1/messages",
    );
    expect(upstreamRequests[0]?.headers.get("x-api-key")).toBe("gateway-key");
  });

  it("upserts a built-in model by identity and appends custom models", async () => {
    const upstreamRequests: Request[] = [];
    const fixture = await writeRuntimeFixture({
      providers: {
        anthropic: {
          baseUrl: "https://anthropic-gateway.example.com",
          apiKey: "gateway-key",
          models: [
            { id: "claude-opus-4-7", contextWindow: 200000 },
            { id: "my-custom-model" },
          ],
        },
      },
    });
    const composition = await serve(fixture, async (input, init) => {
      const request = new Request(input, init);
      if (String(input).includes("/provider/v1/models")) {
        return new Response(
          JSON.stringify({ object: "list", data: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      upstreamRequests.push(request);
      return anthropicJsonResponse("upserted");
    });

    // The upserted built-in model id resolves to the definition (with the
    // pinned defaults filling omitted fields).
    const upserted = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "anthropic/claude-opus-4-7"),
    );
    expect(upserted.status).toBe(200);
    // The appended custom model resolves through the same provider with the
    // provider-level api/baseUrl defaults.
    const appended = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "anthropic/my-custom-model"),
    );
    expect(appended.status).toBe(200);
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[0]?.url).toBe(
      "https://anthropic-gateway.example.com/v1/messages",
    );
    expect(upstreamRequests[1]?.url).toBe(
      "https://anthropic-gateway.example.com/v1/messages",
    );
  });

  it("isolates per-Provider composition failures and keeps the data plane serving", async () => {
    const fixture = await writeRuntimeFixture({
      providers: {
        broken: { baseUrl: "http://broken.example.com", models: [{ id: "m" }] },
        "ok-custom": {
          baseUrl: "http://ok.example.com",
          api: "anthropic-messages",
          apiKey: "ok-key",
          models: [{ id: "m" }],
        },
      },
    });
    const composition = await serve(
      fixture,
      async (input, init) => {
        void init;
        if (String(input).includes("/provider/v1/models")) {
          return new Response(
            JSON.stringify({ object: "list", data: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return anthropicJsonResponse("isolated");
      },
    );
    // Both ids are user-configured; only the valid one is registered.
    expect(composition.userConfiguredProviderIds).toEqual([
      "broken",
      "ok-custom",
    ]);
    const ok = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "ok-custom/m"),
    );
    expect(ok.status).toBe(200);
    // The broken provider never entered the data plane.
    const broken = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "broken/m"),
    );
    expect(broken.status).toBe(404);
    await expect(broken.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    });
  });

  it("serves only the configured models of a Radius Provider overlay", async () => {
    const upstreamRequests: Request[] = [];
    const fixture = await writeRuntimeFixture({
      providers: {
        anthropic: {
          baseUrl: "https://radius-gateway.example.com",
          oauth: "radius",
          api: "anthropic-messages",
          apiKey: "radius-key",
          models: [{ id: "claude-opus-4-7", contextWindow: 99999 }],
        },
      },
    });
    const composition = await serve(fixture, async (input, init) => {
      const request = new Request(input, init);
      if (String(input).includes("/provider/v1/models")) {
        return new Response(
          JSON.stringify({ object: "list", data: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      upstreamRequests.push(request);
      return anthropicJsonResponse("radius served");
    });
    expect(composition.userConfiguredProviderIds).toEqual(["anthropic"]);

    // The configured Radius model resolves and is served through the
    // Radius gateway with the configured key.
    const configured = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "anthropic/claude-opus-4-7"),
    );
    expect(configured.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://radius-gateway.example.com/v1/messages",
    );
    expect(upstreamRequests[0]?.headers.get("x-api-key")).toBe("radius-key");

    // A built-in Anthropic model that was not configured is gone from the
    // Radius baseline — never served.
    const removed = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "anthropic/claude-haiku-4-5"),
    );
    expect(removed.status).toBe(404);
    await expect(removed.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    });
    expect(upstreamRequests).toHaveLength(1);
  });

  it("registers a custom Radius Provider with only its configured models", async () => {
    const upstreamRequests: Request[] = [];
    const fixture = await writeRuntimeFixture({
      providers: {
        "my-radius": {
          baseUrl: "https://radius-gateway.example.com",
          oauth: "radius",
          api: "anthropic-messages",
          apiKey: "radius-key",
          models: [{ id: "gateway-model" }],
        },
      },
    });
    const composition = await serve(fixture, async (input, init) => {
      const request = new Request(input, init);
      if (String(input).includes("/provider/v1/models")) {
        return new Response(
          JSON.stringify({ object: "list", data: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      upstreamRequests.push(request);
      return anthropicJsonResponse("custom radius");
    });

    const served = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "my-radius/gateway-model"),
    );
    expect(served.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://radius-gateway.example.com/v1/messages",
    );
  });

  it("keeps the built-in base provider when its overlay fails composition", async () => {
    const upstreamRequests: Request[] = [];
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({
      type: "api_key",
      key: "stored-builtin-key",
    }));
    const fixture = await writeRuntimeFixture({
      providers: {
        anthropic: { oauth: "radius" },
      },
    });
    const composition = await serve(
      fixture,
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(
            JSON.stringify({ object: "list", data: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        upstreamRequests.push(request);
        return anthropicJsonResponse("base kept");
      },
      { credentials },
    );

    const response = await composition.runtime.handle(
      anthropicRequest(fixture.clientToken, "anthropic/claude-opus-4-7"),
    );
    expect(response.status).toBe(200);
    // The untouched built-in base serves with its own auth: the stored
    // credential through the built-in resolution path.
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(upstreamRequests[0]?.headers.get("x-api-key")).toBe(
      "stored-builtin-key",
    );
  });
});
