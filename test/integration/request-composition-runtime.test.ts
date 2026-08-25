import {
  InMemoryCredentialStore,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfiguredPiModels } from "../support/configured-data-plane.js";

/**
 * Ticket 10 data plane seam: models.json apply + effective catalog query for
 * static facts, and the controlled real Provider invocation/fetch/stream
 * seam for effective base URL, API key, authHeader, merged headers, compat
 * and per-request dynamic resolution. Stored-vs-configured credential
 * precedence runs through the Pi-compatible credential store. Env and
 * command sources are always injected deterministic adapters — no real
 * credential command ever executes in the test suite.
 */
describe("request-time auth and header composition in the data plane", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  interface Fixture {
    readonly modelsJsonPath: string;
  }

  async function writeFixture(modelsJson: Record<string, unknown>): Promise<Fixture> {
    const directory = await mkdtemp(
      join(tmpdir(), "Token-request-composition-"),
    );
    directories.push(directory);
    const piDirectory = join(directory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const modelsJsonPath = join(piDirectory, "models.json");
    await writeFile(modelsJsonPath, JSON.stringify(modelsJson), "utf8");
    return { modelsJsonPath };
  }

  function piContext() {
    return {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
    };
  }

  function anthropicSseResponse(text: string): Response {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_upstream",
          type: "message",
          role: "assistant",
          content: [],
          model: "m1",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      },
    );
  }

  async function compose(
    fixture: Fixture,
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly commands?: Readonly<Record<string, string>>;
      readonly credentials?: InMemoryCredentialStore;
      readonly fetch?: FetchFunction;
    } = {},
  ): Promise<{
    models: Awaited<ReturnType<typeof createConfiguredPiModels>>["models"];
    providerAuthBindings: Awaited<ReturnType<typeof createConfiguredPiModels>>["providerAuthBindings"];
    credentialManagement: Awaited<ReturnType<typeof createConfiguredPiModels>>["credentialManagement"];
    readonly runs: Array<{ command: string }>;
  }> {
    const runs: Array<{ command: string }> = [];
    const { models, providerAuthBindings, credentialManagement } = await createConfiguredPiModels({
      piDirectory: ".unused-in-memory-pi",
      modelsJsonPath: fixture.modelsJsonPath,
      credentialSeedStore: options.credentials ?? new InMemoryCredentialStore(),
      fetch: options.fetch ?? (async () => new Response()),
      providerPackages: {},
      configValueAdapters: {
        envSource: (name) => options.env?.[name],
        commandRunner: (command) => {
          runs.push({ command });
          const output = options.commands?.[command];
          return output === undefined ? undefined : output.trim() || undefined;
        },
      },
      now: () => 1,
      createUuid: () => "00000000-0000-4000-8000-000000000010",
    });
    return { models, providerAuthBindings, credentialManagement, runs };
  }

  async function runBound<T>(
    providerId: string,
    bindings: Awaited<ReturnType<typeof createConfiguredPiModels>>["providerAuthBindings"],
    operation: () => Promise<T>,
  ): Promise<T> {
    const capture = await bindings.capture(providerId);
    return bindings.runBound(capture, operation);
  }

  it("preserves built-in static model headers through an overlay and delivers them to the provider request", async () => {
    const upstreamRequests: Request[] = [];
    const fixture = await writeFixture({
      providers: {
        "github-copilot": {
          apiKey: "copilot-key",
          modelOverrides: { "claude-haiku-4.5": { name: "Overridden name" } },
        },
      },
    });
    const { models, providerAuthBindings } = await compose(fixture, {
      fetch: async () => new Response(),
    });
    const model = models.getModel("github-copilot", "claude-haiku-4.5");
    expect(model).toBeDefined();
    // Overlay preserved the built-in model fact (name overridden, headers intact).
    expect(model?.name).toBe("Overridden name");

    const result = await runBound("github-copilot", providerAuthBindings, () => models
      .streamSimple(model!, piContext() as never, {
        sessionId: "00000000-0000-4000-8000-000000000011",
        fetch: upstreamFetch(upstreamRequests, anthropicSseResponse("ok")),
      } as never)
      .result());
    expect(result.stopReason).toBe("stop");
    expect(upstreamRequests).toHaveLength(1);
    // The static built-in model headers survive the overlay and reach the wire.
    expect(upstreamRequests[0]?.headers.get("User-Agent")).toBe(
      "GitHubCopilotChat/0.35.0",
    );
    expect(upstreamRequests[0]?.headers.get("Copilot-Integration-Id")).toBe(
      "vscode-chat",
    );
  });

  it("resolves env and command apiKey per request and merges provider headers with authHeader", async () => {
    const env: Record<string, string> = { GW_KEY: "key-one", HDR: "hdr-one" };
    const commands: Record<string, string> = {};
    const upstreamRequests: Request[] = [];
    const fixture = await writeFixture({
      providers: {
        gw: {
          api: "anthropic-messages",
          baseUrl: "https://gw.example.com",
          apiKey: "$GW_KEY",
          headers: { "X-Static": "sv", "X-Dynamic": "$HDR" },
          authHeader: true,
          models: [{ id: "m1" }],
        },
      },
    });
    const { models, providerAuthBindings, runs } = await compose(fixture, {
      env,
      commands,
      fetch: async () => new Response(),
    });
    const model = models.getModel("gw", "m1")!;

    const first = await runBound("gw", providerAuthBindings, () => models
      .streamSimple(model, piContext() as never, {
        sessionId: "s1",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          upstreamRequests.push(new Request(input, init));
          return anthropicSseResponse("one");
        },
      } as never)
      .result());
    void first;
    // Second request with changed env/command sources: per-request resolution.
    env.GW_KEY = "key-two";
    env.HDR = "hdr-two";
    const second = await runBound("gw", providerAuthBindings, () => models
      .streamSimple(model, piContext() as never, {
        sessionId: "s2",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          upstreamRequests.push(new Request(input, init));
          return anthropicSseResponse("two");
        },
      } as never)
      .result());
    void second;

    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe(
      "Bearer key-one",
    );
    expect(upstreamRequests[0]?.headers.get("x-static")).toBe("sv");
    expect(upstreamRequests[0]?.headers.get("x-dynamic")).toBe("hdr-one");
    expect(upstreamRequests[1]?.headers.get("authorization")).toBe(
      "Bearer key-two",
    );
    expect(upstreamRequests[1]?.headers.get("x-dynamic")).toBe("hdr-two");
    expect(runs).toEqual([]);
  });

  it("runs !command apiKey per request through the injected runner", async () => {
    const commands: Record<string, string> = { "fetch-gw-key": "cmd-one" };
    const upstreamRequests: Request[] = [];
    const fixture = await writeFixture({
      providers: {
        gw: {
          api: "anthropic-messages",
          baseUrl: "https://gw.example.com",
          apiKey: "!fetch-gw-key",
          models: [{ id: "m1" }],
        },
      },
    });
    const { models, providerAuthBindings, runs } = await compose(fixture, {
      commands,
      fetch: async () => new Response(),
    });
    const model = models.getModel("gw", "m1")!;
    await runBound("gw", providerAuthBindings, () => models
      .streamSimple(model, piContext() as never, {
        sessionId: "s1",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          upstreamRequests.push(new Request(input, init));
          return anthropicSseResponse("one");
        },
      } as never)
      .result());
    commands["fetch-gw-key"] = "cmd-two";
    await runBound("gw", providerAuthBindings, () => models
      .streamSimple(model, piContext() as never, {
        sessionId: "s2",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          upstreamRequests.push(new Request(input, init));
          return anthropicSseResponse("two");
        },
      } as never)
      .result());
    expect(upstreamRequests.map((entry) => entry.headers.get("x-api-key"))).toEqual([
      "cmd-one",
      "cmd-two",
    ]);
    expect(runs).toEqual([{ command: "fetch-gw-key" }, { command: "fetch-gw-key" }]);
  });

  it("merges model-definition and modelOverride headers with case-insensitive collisions", async () => {
    const rawHeaders: Array<Record<string, string>> = [];
    const fixture = await writeFixture({
      providers: {
        gw: {
          api: "anthropic-messages",
          baseUrl: "https://gw.example.com",
          apiKey: "sk",
          headers: { "X-Collide": "provider", "X-Provider": "pv" },
          models: [{ id: "m1", headers: { "x-collide": "model", "X-Model": "mv" } }],
          modelOverrides: {
            m1: { headers: { "X-Override": "ov", "X-Model": "override" } },
          },
        },
      },
    });
    const { models, providerAuthBindings } = await compose(fixture, {
      fetch: async () => new Response(),
    });
    await runBound("gw", providerAuthBindings, () => models
      .streamSimple(models.getModel("gw", "m1")!, piContext() as never, {
        sessionId: "s1",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          // The provider HTTP layer sends a Headers instance (names
          // normalized); collisions must have collapsed to exactly one entry.
          rawHeaders.push(
            Object.fromEntries(new Headers(init?.headers).entries()),
          );
          return anthropicSseResponse("ok");
        },
      } as never)
      .result());
    const headerRecord = rawHeaders[0]!;
    // Model-level headers win over provider-level on case-insensitive names
    // (a single "x-collide" remains); the model definition wins over the
    // modelOverride on the exact key; unrelated headers survive.
    expect(
      Object.keys(headerRecord).filter((name) => name === "x-collide"),
    ).toEqual(["x-collide"]);
    expect(headerRecord["x-collide"]).toBe("model");
    expect(headerRecord["x-model"]).toBe("mv");
    expect(headerRecord["x-override"]).toBe("ov");
    expect(headerRecord["x-provider"]).toBe("pv");
  });

  it("prefers the stored credential, then the configured key, then built-in env auth", async () => {
    const fixture = await writeFixture({
      providers: {
        gw: {
          api: "anthropic-messages",
          baseUrl: "https://gw.example.com",
          apiKey: "sk-configured",
          models: [{ id: "m1" }],
        },
      },
    });
    const credentials = new InMemoryCredentialStore();
    const { models, providerAuthBindings } = await compose(fixture, {
      credentials,
      fetch: async () => new Response(),
    });
    const model = models.getModel("gw", "m1")!;
    const invoke = async (): Promise<string | null> => {
      let key: string | null = null;
      await runBound("gw", providerAuthBindings, () => models
        .streamSimple(model, piContext() as never, {
          sessionId: "s",
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            key = new Request(input, init).headers.get("x-api-key");
            return anthropicSseResponse("ok");
          },
        } as never)
        .result());
      return key;
    };
    // Configured fallback first.
    expect(await invoke()).toBe("sk-configured");
    // A managed Profile present at composition wins over the configured key.
    const managedCredentials = new InMemoryCredentialStore();
    await managedCredentials.modify("gw", async () => ({
      type: "api_key",
      key: "sk-stored",
    }));
    const managed = await compose(fixture, {
      credentials: managedCredentials,
      fetch: async () => new Response(),
    });
    const managedModel = managed.models.getModel("gw", "m1")!;
    const invokeManaged = async (): Promise<string | null> => {
      let key: string | null = null;
      await runBound("gw", managed.providerAuthBindings, () => managed.models
        .streamSimple(managedModel, piContext() as never, {
          sessionId: "managed",
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            key = new Request(input, init).headers.get("x-api-key");
            return anthropicSseResponse("ok");
          },
        } as never)
        .result());
      return key;
    };
    expect(await invokeManaged()).toBe("sk-stored");
    const projection = await managed.credentialManagement.query(["gw"]);
    const provider = projection.providers[0]!;
    await managed.credentialManagement.remove({
      providerId: "gw",
      credentialId: provider.profiles[0]!.credentialId,
      expectedRevision: provider.revision!,
    });
    expect(await invokeManaged()).toBe("sk-configured");
  });

  it("fails cleanly with the pinned authHeader error when the resolved auth has no API key", async () => {
    // The built-in Anthropic auth resolves ANTHROPIC_AUTH_TOKEN to headers
    // only (no apiKey); with authHeader: true the composed auth must fail
    // with the exact pinned error before any request is sent.
    const fixture = await writeFixture({
      providers: {
        anthropic: {
          authHeader: true,
          modelOverrides: { "claude-opus-4-7": { name: "noop" } },
        },
      },
    });
    const { models, providerAuthBindings } = await compose(fixture, {
      env: { ANTHROPIC_AUTH_TOKEN: "token-canary" },
    });
    const result = await runBound("anthropic", providerAuthBindings, () => models
      .streamSimple(models.getModel("anthropic", "claude-opus-4-7")!, piContext() as never, {
        sessionId: "s",
      } as never)
      .result());
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("authHeader requires a resolved API key");
  });

  it("never executes real shell commands and keeps canaries out of resolution failures", async () => {
    const fixture = await writeFixture({
      providers: {
        gw: {
          api: "anthropic-messages",
          baseUrl: "https://gw.example.com",
          apiKey: "$CANARY_ENV_NAME_42",
          headers: { "X-Header": "!canary-command-text-77" },
          models: [{ id: "m1" }],
        },
      },
    });
    const { models, providerAuthBindings } = await compose(fixture);
    const result = await runBound("gw", providerAuthBindings, () => models
      .streamSimple(models.getModel("gw", "m1")!, piContext() as never, {
        sessionId: "s",
      } as never)
      .result());
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toContain("CANARY_ENV_NAME_42");
    expect(result.errorMessage).not.toContain("canary-command-text-77");
    expect(result.errorMessage).toContain('API key for provider "gw"');
  });

  it("composes OAuth toAuth with configured headers and authHeader generically", async () => {
    const fixture = await writeFixture({
      providers: {
        anthropic: {
          headers: { "X-OAuth-Header": "ov" },
          authHeader: true,
          modelOverrides: { "claude-opus-4-7": { name: "via oauth" } },
        },
      },
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(
      "anthropic",
      async () => ({
        type: "oauth",
        access: "access-canary",
        refresh: "refresh-canary",
        // Far in the future so the stored credential is used without refresh.
        expires: Date.now() + 3_600_000,
      }),
    );
    const { models, providerAuthBindings } = await compose(fixture, { credentials });
    const resolution = await runBound("anthropic", providerAuthBindings, () => models.getAuth(
      models.getModel("anthropic", "claude-opus-4-7")!,
    ));
    // The generic OAuth toAuth composition produced the Provider-facing
    // Authorization plus configured headers from the stored OAuth credential.
    expect(resolution?.auth.apiKey).toBe("access-canary");
    expect(resolution?.auth.headers).toMatchObject({
      "X-OAuth-Header": "ov",
      Authorization: "Bearer access-canary",
    });
  });

  it("proves a representative adapter consumes the composed compat facts on the wire", async () => {
    // openai-completions: compat.maxTokensField selects the request body
    // field. The model-level override composes onto the provider facts and
    // the adapter must emit max_tokens instead of max_completion_tokens.
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const fixture = await writeFixture({
      providers: {
        gw: {
          api: "openai-completions",
          baseUrl: "https://gw.example.com/v1",
          apiKey: "sk",
          models: [{ id: "m1", maxTokens: 77 }],
          modelOverrides: {
            m1: { compat: { maxTokensField: "max_tokens" } },
          },
        },
      },
    });
    const { models, providerAuthBindings } = await compose(fixture, {
      fetch: async () => new Response(),
    });
    const model = models.getModel("gw", "m1")!;
    expect(model.compat).toMatchObject({ maxTokensField: "max_tokens" });
    await runBound("gw", providerAuthBindings, () => models
      .streamSimple(model, piContext() as never, {
        sessionId: "s",
        maxTokens: 77,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          upstreamBodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return new Response(
            JSON.stringify({
              id: "chatcmpl-1",
              object: "chat.completion",
              created: 1,
              model: "m1",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      } as never)
      .result());
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0]).toMatchObject({ max_tokens: 77 });
    expect(upstreamBodies[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("composes Radius OAuth with configured headers and authHeader generically", async () => {
    const fixture = await writeFixture({
      providers: {
        radius: {
          baseUrl: "https://radius.example.com/v1",
          headers: { "X-Radius": "rv" },
          authHeader: true,
          models: [{ id: "m1", api: "pi-messages" }],
        },
      },
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(
      "radius",
      async () => ({
        type: "oauth",
        access: "radius-access-canary",
        refresh: "radius-refresh-canary",
        expires: Date.now() + 3_600_000,
      }),
    );
    const { models, providerAuthBindings } = await compose(fixture, { credentials });
    const resolution = await runBound("radius", providerAuthBindings, () =>
      models.getAuth(models.getModel("radius", "m1")!),
    );
    // The generic OAuth composition (no Radius-specific code in the models.json
    // path) derives the Provider-facing Authorization from the stored OAuth
    // credential and adds the configured headers.
    expect(resolution?.auth.apiKey).toBe("radius-access-canary");
    expect(resolution?.auth.headers).toMatchObject({
      "X-Radius": "rv",
      Authorization: "Bearer radius-access-canary",
    });
  });

  it("delivers composed compat facts to the provider request path", async () => {
    const fixture = await writeFixture({
      providers: {
        gw: {
          api: "anthropic-messages",
          baseUrl: "https://gw.example.com",
          apiKey: "sk",
          compat: { supportsTemperature: false },
          modelOverrides: {
            m1: { compat: { supportsStrictTools: false } },
          },
          models: [{ id: "m1" }],
        },
      },
    });
    const { models, providerAuthBindings } = await compose(fixture, {
      fetch: async () => new Response(),
    });
    const model = models.getModel("gw", "m1")!;
    // The composed model carries the merged compat facts (provider compat
    // merged into model compat, then the override layer on top).
    expect(model.compat).toMatchObject({
      supportsTemperature: false,
      supportsStrictTools: false,
    });
    await expect(
      runBound("gw", providerAuthBindings, () => models
        .streamSimple(model, piContext() as never, {
          sessionId: "s",
          fetch: async () => anthropicSseResponse("ok"),
        } as never)
        .result()),
    ).resolves.toMatchObject({ stopReason: "stop" });
  });
});

/** Wrap a fetch mock so each stream call shares the request capture list. */
function upstreamFetch(
  upstreamRequests: Request[],
  response: Response,
): FetchFunction {
  return async (input, init) => {
    upstreamRequests.push(new Request(input, init));
    return response;
  };
}
