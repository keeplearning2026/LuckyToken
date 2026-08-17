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
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";
import { composeEffectiveCatalog } from "../../src/providers/effective-composition.js";

/**
 * Ticket 10 native-passthrough wire seam: anthropic-messages and
 * openai-responses models are served through the LuckyToken native
 * passthrough transports, so the composed Provider-facing request facts
 * (built-in static model headers, configured provider/model headers,
 * authHeader Authorization) must reach the upstream request exactly as the
 * pinned Pi request path would deliver them — while Client Protocol
 * conversion and the Pi semantic IR stay untouched.
 */
describe("composed Provider-facing headers on the native passthrough wire", () => {
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

  async function serve(
    modelsJson: Record<string, unknown>,
    fetch: FetchFunction,
    options: { readonly env?: Readonly<Record<string, string>> } = {},
  ): Promise<{
    readonly clientToken: string;
    readonly responsesToken: string;
    readonly runtime: Awaited<
      ReturnType<typeof createConfiguredLuckyTokenComposition>
    >["runtime"];
  }> {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-passthrough-"));
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
          "openai-responses": {
            authFile: "client-auth/openai-responses.json",
          },
        },
        pi: { directory: "pi", modelsJson: "pi/models.json" },
      }),
      "utf8",
    );
    const responsesAuthPath = join(
      stateDirectory,
      "client-auth",
      "openai-responses.json",
    );
    await createFileClientTokenStore({ path: responsesAuthPath }).create(
      { type: "global" },
      "responses-token",
    );
    const composition = await createConfiguredLuckyTokenComposition({
      config: await loadLuckyTokenCliConfig(configPath),
      fetch,
      credentials: new InMemoryCredentialStore(),
      configValueAdapters: {
        envSource: (name) => options.env?.[name],
        commandRunner: () => undefined,
      },
      createMessageId: () => "msg_passthrough",
      createSessionId: () => "00000000-0000-4000-8000-000000000030",
      now: () => 1_786_400_000_000,
    });
    compositions.push(composition);
    return {
    clientToken: "client-token",
    responsesToken: "responses-token",
    runtime: composition.runtime,
  };
  }

  function anthropicRequest(clientToken: string, model: string): Request {
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

  function anthropicJsonResponse(text: string): Response {
    return new Response(
      JSON.stringify({
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        model: "claude-haiku-4.5",
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

  it("forwards built-in static model headers, configured headers and authHeader on the anthropic passthrough wire", async () => {
    const upstreamRequests: Request[] = [];
    const { clientToken, runtime } = await serve(
      {
        providers: {
          "github-copilot": {
            apiKey: "copilot-key",
            headers: { "X-Operator": "op" },
            authHeader: true,
            modelOverrides: { "claude-haiku-4.5": { name: "Noop" } },
          },
        },
      },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return anthropicJsonResponse("ok");
      },
    );

    const response = await runtime.handle(
      anthropicRequest(clientToken, "github-copilot/claude-haiku-4.5"),
    );
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const headers = upstreamRequests[0]!.headers;
    // Built-in static model headers survive the overlay and reach the wire.
    expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
    expect(headers.get("user-agent")).toBe("GitHubCopilotChat/0.35.0");
    // Configured provider headers and authHeader Authorization reach the wire.
    expect(headers.get("x-operator")).toBe("op");
    expect(headers.get("authorization")).toBe("Bearer copilot-key");
    expect(headers.get("x-api-key")).toBe("copilot-key");
  });

  it("forwards header-only built-in auth (no apiKey) on the anthropic passthrough wire", async () => {
    const upstreamRequests: Request[] = [];
    const { clientToken, runtime } = await serve(
      {
        providers: {
          anthropic: {
            modelOverrides: { "claude-opus-4-7": { name: "Noop" } },
          },
        },
      },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return anthropicJsonResponse("ok");
      },
      { env: { ANTHROPIC_AUTH_TOKEN: "auth-token-canary" } },
    );

    const response = await runtime.handle(
      anthropicRequest(clientToken, "anthropic/claude-opus-4-7"),
    );
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    // The header-only auth is forwarded as the Provider-facing Authorization;
    // no fabricated apiKey is invented.
    expect(upstreamRequests[0]!.headers.get("authorization")).toBe(
      "Bearer auth-token-canary",
    );
    expect(upstreamRequests[0]!.headers.get("x-api-key")).toBeNull();
  });

  it("forwards composed headers on the Responses passthrough wire", async () => {
    const upstreamRequests: Request[] = [];
    const { responsesToken, runtime } = await serve(
      {
        providers: {
          openai: {
            apiKey: "openai-key",
            headers: { "X-Operator": "op" },
            authHeader: true,
            modelOverrides: { "gpt-4": { name: "Noop" } },
          },
        },
      },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return new Response(
          JSON.stringify({
            id: "resp_upstream",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-4",
            output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );

    const response = await runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${responsesToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "openai/gpt-4", input: "hello" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const headers = upstreamRequests[0]!.headers;
    expect(headers.get("x-operator")).toBe("op");
    // The Responses transport owns the Bearer Authorization from the
    // resolved key; the authHeader-composed Authorization is equivalent and
    // never duplicated.
    expect(headers.get("authorization")).toBe("Bearer openai-key");
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("accepts header-only cf-aig-authorization auth for the built-in cloudflare-ai-gateway on the Responses passthrough wire", async () => {
    // The pinned built-in cloudflare-ai-gateway resolves ambient env facts
    // (CLOUDFLARE_API_KEY + account/gateway ids) to header-only auth
    // (`cf-aig-authorization`, no apiKey) and exposes openai-responses
    // models. The native passthrough must accept that valid Provider-facing
    // credential and forward it without fabricating a Bearer.
    const upstreamRequests: Request[] = [];
    const { responsesToken, runtime } = await serve(
      { providers: {} },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return responsesJsonResponse();
      },
      {
        env: {
          CLOUDFLARE_API_KEY: "cf-api-token-canary",
          CLOUDFLARE_ACCOUNT_ID: "cf-account-123",
          CLOUDFLARE_GATEWAY_ID: "cf-gateway-456",
        },
      },
    );

    const response = await runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${responsesToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "cloudflare-ai-gateway/gpt-4o", input: "hello" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const headers = upstreamRequests[0]!.headers;
    // The resolved header-only credential reaches the upstream untouched.
    expect(headers.get("cf-aig-authorization")).toBe("Bearer cf-api-token-canary");
    // No fabricated Bearer from an absent apiKey; no client token leakage.
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    // The request-local baseUrl materializes the pinned env placeholders
    // (account/gateway ids from the resolved auth env) before the wire.
    expect(upstreamRequests[0]!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/cf-account-123/cf-gateway-456/openai/v1/responses",
    );
  });

  it("preserves a composed authorization header when no API key resolves on the Responses passthrough wire", async () => {
    const upstreamRequests: Request[] = [];
    const { responsesToken, runtime } = await serve(
      {
        providers: {
          "cloudflare-ai-gateway": {
            headers: { Authorization: "Bearer operator-token" },
          },
        },
      },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return responsesJsonResponse();
      },
      {
        env: {
          CLOUDFLARE_API_KEY: "cf-api-token-canary",
          CLOUDFLARE_ACCOUNT_ID: "cf-account-123",
          CLOUDFLARE_GATEWAY_ID: "cf-gateway-456",
        },
      },
    );

    const response = await runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${responsesToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "cloudflare-ai-gateway/gpt-4o", input: "hello" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const headers = upstreamRequests[0]!.headers;
    // apiKey absent: the composed authorization survives verbatim (never
    // `Bearer unused`/`Bearer undefined`), the ambient cf-aig credential
    // still passes through, and the client token is never forwarded.
    expect(headers.get("authorization")).toBe("Bearer operator-token");
    expect(headers.get("cf-aig-authorization")).toBe("Bearer cf-api-token-canary");
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("materializes Cloudflare env placeholders on the Anthropic passthrough wire", async () => {
    const upstreamRequests: Request[] = [];
    const { clientToken, runtime } = await serve(
      { providers: {} },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return anthropicJsonResponse("ok");
      },
      {
        env: {
          CLOUDFLARE_API_KEY: "cf-api-token-canary",
          CLOUDFLARE_ACCOUNT_ID: "cf-account-123",
          CLOUDFLARE_GATEWAY_ID: "cf-gateway-456",
        },
      },
    );

    const response = await runtime.handle(
      anthropicRequest(clientToken, "cloudflare-ai-gateway/claude-3-5-haiku"),
    );
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/cf-account-123/cf-gateway-456/anthropic/v1/messages",
    );
    expect(upstreamRequests[0]!.headers.get("cf-aig-authorization")).toBe(
      "Bearer cf-api-token-canary",
    );
    expect(upstreamRequests[0]!.headers.get("authorization")).toBeNull();
  });

  it("forwards a composed header-only x-api-key on the anthropic passthrough wire", async () => {
    // A schema-valid Provider with api anthropic-messages, a base URL and
    // only a (mixed-case) configured x-api-key header — no configured,
    // stored, or inherited apiKey. The ambient ANTHROPIC_AUTH_TOKEN gives
    // the inherited auth a headers-only resolution, so the preflight gate
    // accepts the composed x-api-key credential; it must reach the upstream
    // request exactly once.
    const upstreamRequests: Request[] = [];
    const { clientToken, runtime } = await serve(
      {
        providers: {
          anthropic: {
            headers: { "X-Api-Key": "header-key-canary" },
            modelOverrides: { "claude-opus-4-7": { name: "Noop" } },
          },
        },
      },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return anthropicJsonResponse("ok");
      },
      { env: { ANTHROPIC_AUTH_TOKEN: "auth-token-canary" } },
    );

    const response = await runtime.handle(
      anthropicRequest(clientToken, "anthropic/claude-opus-4-7"),
    );
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const headers = upstreamRequests[0]!.headers;
    // The composed x-api-key credential reaches the upstream exactly once
    // (case-insensitive: the mixed-case configured name emits one header).
    expect(headers.get("x-api-key")).toBe("header-key-canary");
    expect(headers.get("X-Api-Key")).toBe("header-key-canary");
    // The inherited header-only auth still passes through alongside it.
    expect(headers.get("authorization")).toBe("Bearer auth-token-canary");
    // No client token leakage.
    expect(headers.get("authorization")).not.toBe("Bearer client-token");
  });

  it("keeps a resolved apiKey authoritative over a conflicting composed x-api-key", async () => {
    const upstreamRequests: Request[] = [];
    const { clientToken, runtime } = await serve(
      {
        providers: {
          "github-copilot": {
            apiKey: "resolved-key",
            headers: { "x-api-key": "conflicting-composed-key" },
            modelOverrides: { "claude-haiku-4.5": { name: "Noop" } },
          },
        },
      },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return anthropicJsonResponse("ok");
      },
    );

    const response = await runtime.handle(
      anthropicRequest(clientToken, "github-copilot/claude-haiku-4.5"),
    );
    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const headers = upstreamRequests[0]!.headers;
    // The transport-generated credential from the resolved apiKey wins;
    // the conflicting composed x-api-key never overwrites it and no
    // duplicate credential headers are emitted.
    expect(headers.get("x-api-key")).toBe("resolved-key");
  });

  it("resolves Cloudflare env per request without caching and never mutates the catalog model", async () => {
    const upstreamUrls: string[] = [];
    const env: Record<string, string> = {
      CLOUDFLARE_API_KEY: "cf-api-token-canary",
      CLOUDFLARE_ACCOUNT_ID: "cf-account-111",
      CLOUDFLARE_GATEWAY_ID: "cf-gateway-111",
    };
    const { responsesToken, runtime } = await serve(
      { providers: {} },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamUrls.push(request.url);
        return responsesJsonResponse();
      },
      { env },
    );
    const request = (): Request =>
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${responsesToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "cloudflare-ai-gateway/gpt-4o", input: "hello" }),
      });

    const before = await runtime.handle(request());
    expect(before.status).toBe(200);
    env.CLOUDFLARE_ACCOUNT_ID = "cf-account-222";
    env.CLOUDFLARE_GATEWAY_ID = "cf-gateway-222";
    const after = await runtime.handle(request());
    expect(after.status).toBe(200);

    expect(upstreamUrls).toEqual([
      "https://gateway.ai.cloudflare.com/v1/cf-account-111/cf-gateway-111/openai/v1/responses",
      "https://gateway.ai.cloudflare.com/v1/cf-account-222/cf-gateway-222/openai/v1/responses",
    ]);

    // The catalog model is never mutated by requests and the effective
    // catalog projection never carries resolved env values: the built-in
    // model keeps its structural placeholder baseUrl and no account/gateway
    // id leaks into the projection.
    const catalog = JSON.stringify(composeEffectiveCatalog({}));
    expect(catalog).toContain("gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai");
    expect(catalog).not.toContain("cf-account-111");
    expect(catalog).not.toContain("cf-gateway-222");
    expect(catalog).not.toContain("cf-api-token-canary");
  });

  it("keeps the pinned safe failure when required Cloudflare env is missing (no placeholder URL on the wire)", async () => {
    const upstreamRequests: Request[] = [];
    const { responsesToken, runtime } = await serve(
      { providers: {} },
      async (input, init) => {
        const request = new Request(input, init);
        if (String(input).includes("/provider/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        upstreamRequests.push(request);
        return responsesJsonResponse();
      },
      {
        env: {
          // Only the API key: account/gateway ids missing, so the pinned
          // auth never resolves and no request with literal placeholders
          // may reach the wire.
          CLOUDFLARE_API_KEY: "cf-api-token-canary",
        },
      },
    );

    const response = await runtime.handle(
      new Request("http://luckytoken.test/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${responsesToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "cloudflare-ai-gateway/gpt-4o", input: "hello" }),
      }),
    );
    expect(response.status).toBe(502);
    expect(upstreamRequests).toHaveLength(0);
  });
});

function responsesJsonResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_upstream",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-4o",
      output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
