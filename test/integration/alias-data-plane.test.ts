import { InMemoryCredentialStore, type FetchFunction } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAliasRegistryAuthority } from "../../src/aliases/authority.js";
import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";
import { COMMANDCODE_MODELS } from "../../packages/provider-commandcode-private/src/models.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";
import { parseModelsJson } from "../../src/providers/models-json.js";
import {
  COMMANDCODE_PROVIDER_PACKAGE,
  commandCodeProviderImportModule,
} from "../support/commandcode-provider-package.js";

/**
 * Ticket 15 alias-only model data plane — driven through the real HTTP
 * Request/Response seam of the composed data plane (both Client Protocols,
 * converted and native-passthrough branches), the real Ticket 14 alias
 * authority (in-memory file), and the real Ticket 11 served catalog
 * snapshot. No resolver internals are invoked directly.
 */

const NOW = 1_786_400_000_000;

function commandCodeText(text: string): Response {
  return new Response(
    [
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", text }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      }),
      "",
    ].join("\n"),
  );
}

function anthropicJson(text: string, model = "claude-sonnet"): Response {
  return new Response(
    JSON.stringify({
      id: "msg_upstream",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function responsesJson(text: string, model = "gpt-4o"): Response {
  return new Response(
    JSON.stringify({
      id: "resp_upstream",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      model,
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      usage: {
        input_tokens: 4,
        output_tokens: 5,
        total_tokens: 9,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function anthropicSse(model = "claude-sonnet"): string {
  return [
    "event: message_start",
    `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}`,
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
    "",
  ].join("\n");
}

function responsesSse(model = "gpt-4o"): string {
  const responseObject = (output: unknown[]) =>
    JSON.stringify({
      id: "resp_upstream",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      model,
      output,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      usage: {
        input_tokens: 4,
        output_tokens: 5,
        total_tokens: 9,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  const item = JSON.stringify({
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hello", annotations: [] }],
  });
  return [
    "event: response.created",
    `data: ${responseObject([])}`,
    "",
    "event: response.output_item.added",
    `data: {"type":"response.output_item.added","output_index":0,"item":${item}}`,
    "",
    "event: response.content_part.added",
    'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}',
    "",
    "event: response.output_text.done",
    'data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"content_index":0,"text":"hello"}',
    "",
    "event: response.output_item.done",
    `data: {"type":"response.output_item.done","output_index":0,"item":${item}}`,
    "",
    "event: response.completed",
    `data: ${responseObject([JSON.parse(item)])}`,
    "",
    "",
  ].join("\n");
}

interface UpstreamCall {
  readonly url: string;
  readonly body: string;
  readonly respond: (response: Response) => void;
  readonly fail: (error: Error) => void;
}

interface AliasDataPlaneFixture {
  readonly runtime: Awaited<
    ReturnType<typeof createConfiguredLuckyTokenComposition>
  >["runtime"];
  readonly composition: Awaited<
    ReturnType<typeof createConfiguredLuckyTokenComposition>
  >;
  readonly authority: ReturnType<typeof createAliasRegistryAuthority>;
  readonly aliasFile: string;
  readonly clientToken: string;
  readonly responsesToken: string;
  readonly setCatalogFacts: (knownTargets: ReadonlySet<string>) => void;
  readonly nextUpstreamCall: () => Promise<UpstreamCall>;
  readonly upstreamCallCount: () => number;
  readonly close: () => Promise<void>;
}

const fixtures: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function commandCodeTargets(): Set<string> {
  const targets = new Set<string>();
  for (const model of COMMANDCODE_MODELS) {
    targets.add(`commandcode-private\u0000${model.id}`);
  }
  return targets;
}

async function createAliasDataPlaneFixture(
  initialAliases: Readonly<Record<string, unknown>>,
): Promise<AliasDataPlaneFixture> {
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-alias-plane-"));
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
  const responsesAuthPath = join(
    stateDirectory,
    "client-auth",
    "openai-responses.json",
  );
  await createFileClientTokenStore({ path: responsesAuthPath }).create(
    { type: "global" },
    "responses-token",
  );
  const modelsJsonPath = join(piDirectory, "models.json");
  await writeFile(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        "my-anthropic": {
          baseUrl: "https://gateway.example.com",
          api: "anthropic-messages",
          apiKey: "gateway-key",
          models: [{ id: "claude-sonnet", contextWindow: 200000, maxTokens: 64000 }],
        },
        "my-openai": {
          baseUrl: "https://gateway.example.com",
          api: "openai-responses",
          apiKey: "gateway-key",
          models: [{ id: "gpt-4o", contextWindow: 200000, maxTokens: 64000 }],
        },
      },
    }),
    "utf8",
  );
  const configPath = join(stateDirectory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { port: 0 },
      clientProtocols: {
        "anthropic-messages": {
          authFile: "client-auth/anthropic-messages.json",
        },
        "openai-responses": {
          authFile: "client-auth/openai-responses.json",
        },
      },
      providerPackages: { [COMMANDCODE_PROVIDER_PACKAGE]: {} },
      pi: { directory: "pi", modelsJson: "pi/models.json" },
    }),
    "utf8",
  );

  // The alias authority validates against the authoritative Ticket 11
  // catalog snapshot facts; the slot is swapped together with the served
  // catalog so the two never diverge in the fixture.
  const facts = {
    catalogVersion: 1,
    knownTargets: commandCodeTargets(),
  };
  facts.knownTargets.add("my-anthropic\u0000claude-sonnet");
  facts.knownTargets.add("my-openai\u0000gpt-4o");

  const aliasFile = join(piDirectory, "model-aliases.json");
  await writeFile(
    aliasFile,
    `${JSON.stringify({ aliases: initialAliases }, null, 2)}\n`,
    "utf8",
  );
  const authority = createAliasRegistryAuthority({
    path: aliasFile,
    // Deterministic fixture: no curated defaults, only the explicit file.
    defaults: [],
    defaultsVersion: 0,
    catalogFacts: () => facts,
  });

  const upstreamCalls: UpstreamCall[] = [];
  let upstreamTotal = 0;
  const waiters: Array<() => void> = [];
  const routeOf = (url: string): string | undefined => {
    if (url.includes("/provider/v1/models")) return undefined;
    if (url.includes("api.commandcode.ai")) return "commandcode";
    if (url.includes("/v1/messages")) return "anthropic";
    if (url.includes("/v1/responses")) return "responses";
    return undefined;
  };
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    const url = request.url;
    const route = routeOf(url);
    if (route === undefined) {
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = await request.text();
    const released = deferred<Response>();
    const call: UpstreamCall = Object.freeze({
      url,
      body,
      respond: (response: Response) => released.resolve(response),
      fail: (error: Error) => released.reject(error),
    });
    upstreamCalls.push(call);
    upstreamTotal += 1;
    waiters.splice(0).forEach((wake) => wake());
    return released.promise;
  };
  const nextUpstreamCall = async (): Promise<UpstreamCall> => {
    while (upstreamCalls.length === 0) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    return upstreamCalls.shift() as UpstreamCall;
  };

  const credentials = new InMemoryCredentialStore();
  await credentials.modify("commandcode-private", async () => ({
    type: "api_key",
    key: "provider-secret",
  }));

  const composition = await createConfiguredLuckyTokenComposition({
    config: await loadLuckyTokenCliConfig(configPath),
    credentials,
    fetch,
    importModule: commandCodeProviderImportModule({
      projectSnapshot: { snapshot: async () => createEmptyServerConfig() },
    }),
    aliasAuthority: authority,
    createMessageId: () => "msg_alias_plane",
    createSessionId: () => "00000000-0000-4000-8000-000000000300",
    now: () => NOW,
  });
  const close = async () => {
    await composition.diagnosticsStore.close();
    await composition.requestLedger.close();
    await rm(directory, { recursive: true, force: true });
  };
  fixtures.push({ close });

  return Object.freeze({
    runtime: composition.runtime,
    composition,
    authority,
    aliasFile,
    clientToken: "client-token",
    responsesToken: "responses-token",
    setCatalogFacts: (knownTargets: ReadonlySet<string>) => {
      facts.catalogVersion += 1;
      facts.knownTargets = new Set(knownTargets);
    },
    nextUpstreamCall,
    upstreamCallCount: () => upstreamTotal,
    close,
  });
}

function anthropicRequest(
  body: Record<string, unknown>,
  token: string,
): Request {
  return new Request("http://luckytoken.test/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

function responsesRequest(
  body: Record<string, unknown>,
  token: string,
): Request {
  return new Request("http://luckytoken.test/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const INITIAL_ALIASES = Object.freeze({
  // Object-form target: the canonical model id itself contains a slash.
  flash: {
    provider: "commandcode-private",
    model: "deepseek/deepseek-v4-flash",
  },
  luna: "commandcode-private/gpt-5.6-luna",
  sonnet: "my-anthropic/claude-sonnet",
  gpt: "my-openai/gpt-4o",
  ghost: "my-anthropic/claude-opus",
});

describe("alias-only model data plane", () => {
  it("dispatches a callable alias to its captured canonical target and echoes the alias", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const pending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "flash",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const call = await fixture.nextUpstreamCall();
    call.respond(commandCodeText("converted through Pi"));
    const response = await pending;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "flash",
      content: [{ type: "text", text: "converted through Pi" }],
    });
    // Provider-observed canonical target: the upstream sees the captured
    // canonical model id, never the alias.
    const upstream = JSON.parse(call.body) as { params: { model: string } };
    expect(upstream.params.model).toBe("deepseek/deepseek-v4-flash");
  });

  it("dispatches a callable alias through the Responses converted path", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const pending = fixture.runtime.handle(
      responsesRequest({ model: "luna", input: "hello" }, fixture.responsesToken),
    );
    const call = await fixture.nextUpstreamCall();
    call.respond(commandCodeText("converted through Pi"));
    const response = await pending;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      model: "luna",
      output: [{ type: "message", content: [{ type: "output_text", text: "converted through Pi" }] }],
    });
    const upstream = JSON.parse(call.body) as { params: { model: string } };
    expect(upstream.params.model).toBe("gpt-5.6-luna");
  });

  it("rejects bare model ids even when they are real and callable", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    // "gpt-5.6-luna" is a real CommandCode model id but is not a configured alias.
    const anthropic = await fixture.runtime.handle(
      anthropicRequest(
        {
          model: "gpt-5.6-luna",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    expect(anthropic.status).toBe(404);
    await expect(anthropic.json()).resolves.toMatchObject({
      error: { type: "not_found_error" },
    });
    expect(fixture.upstreamCallCount()).toBe(0);

    const responses = await fixture.runtime.handle(
      responsesRequest({ model: "deepseek/deepseek-v4-flash", input: "hi" }, fixture.responsesToken),
    );
    expect(responses.status).toBe(400);
    await expect(responses.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error", code: "unknown_model" },
    });
    expect(fixture.upstreamCallCount()).toBe(0);
  });

  it("rejects canonical provider/model selectors even when they are callable", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const anthropic = await fixture.runtime.handle(
      anthropicRequest(
        {
          model: "commandcode-private/deepseek/deepseek-v4-flash",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    expect(anthropic.status).toBe(404);
    await expect(anthropic.json()).resolves.toMatchObject({
      error: { type: "not_found_error" },
    });
    expect(fixture.upstreamCallCount()).toBe(0);

    const responses = await fixture.runtime.handle(
      responsesRequest(
        { model: "my-openai/gpt-4o", input: "hi" },
        fixture.responsesToken,
      ),
    );
    expect(responses.status).toBe(400);
    await expect(responses.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error", code: "unknown_model" },
    });
    expect(fixture.upstreamCallCount()).toBe(0);
  });

  it("renders an unknown alias as the target-protocol unknown_model result without leaking canonical identity", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const anthropic = await fixture.runtime.handle(
      anthropicRequest(
        {
          model: "does-not-exist",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    expect(anthropic.status).toBe(404);
    const anthropicBody = (await anthropic.json()) as {
      error: { type: string; message: string };
    };
    expect(anthropicBody.error.type).toBe("not_found_error");
    expect(anthropicBody.error.message).toContain("does-not-exist");
    expect(JSON.stringify(anthropicBody)).not.toContain("commandcode-private");
    expect(JSON.stringify(anthropicBody)).not.toContain("deepseek-v4-flash");

    const responses = await fixture.runtime.handle(
      responsesRequest({ model: "does-not-exist", input: "hi" }, fixture.responsesToken),
    );
    expect(responses.status).toBe(400);
    const responsesBody = (await responses.json()) as {
      error: { type: string; code: string; message: string };
    };
    expect(responsesBody.error.type).toBe("invalid_request_error");
    expect(responsesBody.error.code).toBe("unknown_model");
    expect(JSON.stringify(responsesBody)).not.toContain("my-anthropic");
    expect(JSON.stringify(responsesBody)).not.toContain("claude-sonnet");
    expect(fixture.upstreamCallCount()).toBe(0);
  });

  it("renders a configured alias with an unavailable target as a distinct model_unavailable result without leaking canonical identity", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const anthropic = await fixture.runtime.handle(
      anthropicRequest(
        {
          model: "ghost",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    expect(anthropic.status).toBe(502);
    const anthropicBody = (await anthropic.json()) as {
      error: { type: string; message: string };
    };
    expect(anthropicBody.error.type).toBe("api_error");
    expect(anthropicBody.error.message).not.toContain("ghost");
    expect(JSON.stringify(anthropicBody)).not.toContain("my-anthropic");
    expect(JSON.stringify(anthropicBody)).not.toContain("claude-opus");

    const responses = await fixture.runtime.handle(
      responsesRequest({ model: "ghost", input: "hi" }, fixture.responsesToken),
    );
    expect(responses.status).toBe(503);
    const responsesBody = (await responses.json()) as {
      error: { type: string; code: string };
    };
    expect(responsesBody.error.type).toBe("api_error");
    expect(responsesBody.error.code).toBe("model_unavailable");
    expect(JSON.stringify(responsesBody)).not.toContain("my-anthropic");
    expect(JSON.stringify(responsesBody)).not.toContain("claude-opus");
    expect(fixture.upstreamCallCount()).toBe(0);
  });

  it("rewrites native passthrough non-streaming response model identity to the requested alias", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    // Anthropic native passthrough.
    const anthropicPending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const anthropicCall = await fixture.nextUpstreamCall();
    expect(JSON.parse(anthropicCall.body)).toMatchObject({
      model: "claude-sonnet",
    });
    anthropicCall.respond(anthropicJson("native anthropic", "claude-sonnet"));
    const anthropicResponse = await anthropicPending;
    expect(anthropicResponse.status).toBe(200);
    const anthropicBody = (await anthropicResponse.json()) as {
      model: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(anthropicBody.model).toBe("sonnet");
    expect(JSON.stringify(anthropicBody)).not.toContain("claude-sonnet");

    // OpenAI Responses native passthrough.
    const responsesPending = fixture.runtime.handle(
      responsesRequest({ model: "gpt", input: "hello" }, fixture.responsesToken),
    );
    const responsesCall = await fixture.nextUpstreamCall();
    expect(JSON.parse(responsesCall.body)).toMatchObject({ model: "gpt-4o" });
    responsesCall.respond(responsesJson("native responses", "gpt-4o"));
    const responsesResponse = await responsesPending;
    expect(responsesResponse.status).toBe(200);
    const responsesBody = (await responsesResponse.json()) as {
      model: string;
    };
    expect(responsesBody.model).toBe("gpt");
    expect(JSON.stringify(responsesBody)).not.toContain("gpt-4o");
  });

  it("rewrites native passthrough streaming response model identity to the requested alias", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const anthropicPending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const anthropicCall = await fixture.nextUpstreamCall();
    anthropicCall.respond(
      new Response(anthropicSse("claude-sonnet"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const anthropicResponse = await anthropicPending;
    expect(anthropicResponse.status).toBe(200);
    const anthropicText = await anthropicResponse.text();
    expect(anthropicText).toContain('"model":"sonnet"');
    expect(anthropicText).toContain('"text":"hello"');
    expect(anthropicText).toContain('"type":"message_stop"');
    expect(anthropicText).not.toContain("claude-sonnet");

    const responsesPending = fixture.runtime.handle(
      responsesRequest(
        { model: "gpt", input: "hello", stream: true },
        fixture.responsesToken,
      ),
    );
    const responsesCall = await fixture.nextUpstreamCall();
    responsesCall.respond(
      new Response(responsesSse("gpt-4o"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const responsesResponse = await responsesPending;
    expect(responsesResponse.status).toBe(200);
    const responsesText = await responsesResponse.text();
    expect(responsesText).toContain('"model":"gpt"');
    expect(responsesText).toContain('"delta":"hello"');
    expect(responsesText).toContain("event: response.completed");
    expect(responsesText).not.toContain("gpt-4o");
  });

  it("fails safely when a passthrough response shape cannot be projected without leaking upstream bytes", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const anthropicPending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const anthropicCall = await fixture.nextUpstreamCall();
    anthropicCall.respond(
      new Response("not-json-upstream-garbage{{{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const anthropicResponse = await anthropicPending;
    expect(anthropicResponse.status).toBe(502);
    const anthropicBody = await anthropicResponse.text();
    expect(anthropicBody).not.toContain("not-json-upstream-garbage");
    expect(anthropicBody).not.toContain("claude-sonnet");

    const responsesPending = fixture.runtime.handle(
      responsesRequest({ model: "gpt", input: "hello" }, fixture.responsesToken),
    );
    const responsesCall = await fixture.nextUpstreamCall();
    responsesCall.respond(
      new Response('{"object":"response","status":"completed"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const responsesResponse = await responsesPending;
    expect(responsesResponse.status).toBe(502);
    const responsesBody = await responsesResponse.text();
    // The upstream response carried no model identity and its bytes never
    // reach the client; only the safe error envelope is returned.
    expect(responsesBody).not.toContain("completed");
    expect(responsesBody).not.toContain('"object":"response"');
    expect(responsesBody).not.toContain("gpt-4o");
  });

  it("serves unauthenticated discovery listing only callable mapped aliases with real owned_by and no model ids", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const response = await fixture.runtime.handle(
      new Request("http://luckytoken.test/v1/models", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    const list = (await response.json()) as {
      object: string;
      data: Array<{ id: string; object: string; created: number; owned_by: string }>;
    };
    expect(list.object).toBe("list");
    expect(list.data).toEqual([
      { id: "flash", object: "model", created: NOW / 1000, owned_by: "commandcode-private" },
      { id: "gpt", object: "model", created: NOW / 1000, owned_by: "my-openai" },
      { id: "luna", object: "model", created: NOW / 1000, owned_by: "commandcode-private" },
      { id: "sonnet", object: "model", created: NOW / 1000, owned_by: "my-anthropic" },
    ]);
    const serialized = JSON.stringify(list);
    // "ghost" is configured but its target is not callable: hidden.
    expect(serialized).not.toContain("ghost");
    // Real model ids never appear; only aliases and real providers do.
    expect(serialized).not.toContain("claude-sonnet");
    expect(serialized).not.toContain("gpt-4o");
    expect(serialized).not.toContain("deepseek-v4-flash");
    expect(serialized).not.toContain("claude-opus");
    expect(serialized).not.toContain("/");
  });

  it("hot alias replacement applies to new requests only while the in-flight request keeps its captured alias and canonical target", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const pendingFirst = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "flash",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    // Request 1 accepted and in flight (blocked at the upstream).
    const firstCall = await fixture.nextUpstreamCall();

    // Hot alias replacement: "flash" now maps to a different canonical target.
    await writeFile(
      fixture.aliasFile,
      `${JSON.stringify(
        {
          aliases: {
            ...INITIAL_ALIASES,
            flash: "commandcode-private/gpt-5.6-luna",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const pendingSecond = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "flash",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const secondCall = await fixture.nextUpstreamCall();
    // The new request resolved through the replacement snapshot.
    expect(JSON.parse(secondCall.body)).toMatchObject({
      params: { model: "gpt-5.6-luna" },
    });
    secondCall.respond(commandCodeText("second"));

    // The in-flight request still uses the alias and canonical target it
    // captured at acceptance.
    firstCall.respond(commandCodeText("first"));
    const firstResponse = await pendingFirst;
    const secondResponse = await pendingSecond;
    expect(JSON.parse(firstCall.body)).toMatchObject({
      params: { model: "deepseek/deepseek-v4-flash" },
    });
    await expect(firstResponse.json()).resolves.toMatchObject({
      model: "flash",
      content: [{ type: "text", text: "first" }],
    });
    await expect(secondResponse.json()).resolves.toMatchObject({
      model: "flash",
      content: [{ type: "text", text: "second" }],
    });
  });

  it("hot catalog replacement applies to new requests only while the in-flight response projection keeps its captured alias", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const pendingFirst = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    // Request 1 accepted and in flight; it captured the alias snapshot and
    // the canonical target "my-anthropic/claude-sonnet".
    const firstCall = await fixture.nextUpstreamCall();

    // Hot catalog replacement: the served catalog swaps to a snapshot that
    // no longer contains claude-sonnet (the composition hook mirrors the
    // Ticket 11 refresh controller wiring).
    fixture.composition.catalog.recompose(
      parseModelsJson(
        JSON.stringify({
          providers: {
            "my-anthropic": {
              baseUrl: "https://gateway.example.com",
              api: "anthropic-messages",
              apiKey: "gateway-key",
              models: [{ id: "claude-opus", contextWindow: 200000, maxTokens: 64000 }],
            },
            "my-openai": {
              baseUrl: "https://gateway.example.com",
              api: "openai-responses",
              apiKey: "gateway-key",
              models: [{ id: "gpt-4o", contextWindow: 200000, maxTokens: 64000 }],
            },
          },
        }),
      ),
    );
    fixture.composition.catalog.capture();
    fixture.setCatalogFacts(
      new Set([
        ...commandCodeTargets(),
        "my-anthropic\u0000claude-opus",
        "my-openai\u0000gpt-4o",
      ]),
    );
    fixture.authority.onCatalogSnapshot();

    // A new request for the same alias now reports model_unavailable: its
    // target is no longer in the active catalog.
    const secondResponse = await fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    expect(secondResponse.status).toBe(502);
    await expect(secondResponse.json()).resolves.toMatchObject({
      error: { type: "api_error" },
    });
    expect(fixture.upstreamCallCount()).toBe(1);

    // The in-flight request completes through its captured alias and target.
    firstCall.respond(anthropicJson("in-flight first", "claude-sonnet"));
    const firstResponse = await pendingFirst;
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({
      model: "sonnet",
    });
    expect(JSON.parse(firstCall.body)).toMatchObject({ model: "claude-sonnet" });
  });

  it("fails closed when an Anthropic message_start also carries a top-level model canary", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const pending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const call = await fixture.nextUpstreamCall();
    const stream = [
      "event: message_start",
      'data: {"type":"message_start","model":"claude-sonnet","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      "",
    ].join("\n");
    call.respond(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const response = await pending;
    expect(response.status).toBe(502);
    const text = await response.text();
    // No upstream byte and no canonical model identity may reach the client.
    expect(text).not.toContain("claude-sonnet");
    expect(text).not.toContain("message_start");
    expect(text).not.toContain("message_stop");
  });

  it("fails closed on ambiguous nested model positions in both protocols", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    // Anthropic non-streaming: a nested model inside a tool input cannot be
    // told apart from semantic content.
    const anthropicPending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const anthropicCall = await fixture.nextUpstreamCall();
    anthropicCall.respond(
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet",
          content: [
            {
              type: "tool_use",
              id: "t_1",
              caller: { type: "direct" },
              name: "create_config",
              input: { model: "claude-sonnet" },
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const anthropicResponse = await anthropicPending;
    expect(anthropicResponse.status).toBe(502);
    const anthropicText = await anthropicResponse.text();
    expect(anthropicText).not.toContain("claude-sonnet");
    expect(anthropicText).not.toContain("create_config");

    // Responses streaming: a nested model inside an output item object.
    const responsesPending = fixture.runtime.handle(
      responsesRequest({ model: "gpt", input: "hello" }, fixture.responsesToken),
    );
    const responsesCall = await fixture.nextUpstreamCall();
    responsesCall.respond(
      new Response(
        [
          "event: response.output_item.done",
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[],"model":"gpt-4o"}}',
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const responsesResponse = await responsesPending;
    expect(responsesResponse.status).toBe(502);
    const responsesText = await responsesResponse.text();
    expect(responsesText).not.toContain("gpt-4o");
    expect(responsesText).not.toContain("output_item");
  });

  it("projects CR-only and BOM-prefixed streaming responses to the alias in both protocols", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    // Anthropic: CR-only stream with a leading UTF-8 BOM.
    const anthropicPending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const anthropicCall = await fixture.nextUpstreamCall();
    const anthropicStream =
      "\uFEFF" +
      [
        "event: message_start",
        'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
        "",
      ].join("\r");
    anthropicCall.respond(
      new Response(anthropicStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const anthropicResponse = await anthropicPending;
    expect(anthropicResponse.status).toBe(200);
    const anthropicText = await anthropicResponse.text();
    expect(anthropicText).toContain('"model":"sonnet"');
    expect(anthropicText).toContain('"type":"message_stop"');
    expect(anthropicText).not.toContain("claude-sonnet");

    // Responses: CR-only stream.
    const responsesPending = fixture.runtime.handle(
      responsesRequest(
        { model: "gpt", input: "hello", stream: true },
        fixture.responsesToken,
      ),
    );
    const responsesCall = await fixture.nextUpstreamCall();
    const responsesObject = JSON.stringify({
      id: "resp_upstream",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      model: "gpt-4o",
      output: [],
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
    responsesCall.respond(
      new Response(
        [
          "event: response.created",
          `data: ${responsesObject}`,
          "",
          "event: response.completed",
          `data: ${responsesObject}`,
          "",
          "",
        ].join("\r"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const responsesResponse = await responsesPending;
    expect(responsesResponse.status).toBe(200);
    const responsesText = await responsesResponse.text();
    expect(responsesText.match(/"model":"gpt"/gu)).toHaveLength(2);
    expect(responsesText).not.toContain("gpt-4o");
  });

  it("fails closed when a root-array SSE event carries a model canary in both protocols", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    // Anthropic: a valid message_start followed by a root-array event whose
    // element carries a canonical model key.
    const anthropicPending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const anthropicCall = await fixture.nextUpstreamCall();
    anthropicCall.respond(
      new Response(
        [
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
          "",
          "event: custom",
          'data: [{"model":"claude-sonnet"}]',
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const anthropicResponse = await anthropicPending;
    expect(anthropicResponse.status).toBe(502);
    const anthropicText = await anthropicResponse.text();
    expect(anthropicText).not.toContain("claude-sonnet");
    expect(anthropicText).not.toContain("message_start");
    expect(anthropicText).not.toContain("custom");

    // Responses: a root-array event whose element carries a canonical model
    // key after a valid full-response event.
    const responsesPending = fixture.runtime.handle(
      responsesRequest(
        { model: "gpt", input: "hello", stream: true },
        fixture.responsesToken,
      ),
    );
    const responsesCall = await fixture.nextUpstreamCall();
    responsesCall.respond(
      new Response(
        [
          "event: response.created",
          `data: ${JSON.stringify({
            id: "resp_upstream",
            object: "response",
            created_at: 1,
            status: "completed",
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: {},
            model: "gpt-4o",
            output: [],
            parallel_tool_calls: true,
            temperature: null,
            tool_choice: "auto",
            tools: [],
            top_p: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          })}`,
          "",
          "event: custom",
          'data: [{"model":"gpt-4o"}]',
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const responsesResponse = await responsesPending;
    expect(responsesResponse.status).toBe(502);
    const responsesText = await responsesResponse.text();
    expect(responsesText).not.toContain("gpt-4o");
    expect(responsesText).not.toContain("response.created");
  });

  it("never forwards upstream error bodies in alias mode; renders a fixed value-free error instead", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    // Anthropic: upstream 429 error text names the canonical model.
    const anthropicPending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const anthropicCall = await fixture.nextUpstreamCall();
    anthropicCall.respond(
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "model claude-sonnet is temporarily limited",
          },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-canary-header": "claude-sonnet",
          },
        },
      ),
    );
    const anthropicResponse = await anthropicPending;
    expect(anthropicResponse.status).toBe(502);
    const anthropicText = await anthropicResponse.text();
    expect(anthropicText).not.toContain("claude-sonnet");
    expect(anthropicText).not.toContain("rate_limit");
    expect(anthropicText).not.toContain("temporarily");
    expect(anthropicResponse.headers.has("x-canary-header")).toBe(false);
    expect(JSON.parse(anthropicText)).toMatchObject({
      error: { type: "api_error", message: "Upstream provider failed" },
    });

    // Responses: upstream 500 error body names the canonical model.
    const responsesPending = fixture.runtime.handle(
      responsesRequest({ model: "gpt", input: "hello" }, fixture.responsesToken),
    );
    const responsesCall = await fixture.nextUpstreamCall();
    responsesCall.respond(
      new Response(
        JSON.stringify({
          error: { message: "model gpt-4o exploded", type: "server_error", code: null, param: null },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );
    const responsesResponse = await responsesPending;
    expect(responsesResponse.status).toBe(502);
    const responsesText = await responsesResponse.text();
    expect(responsesText).not.toContain("gpt-4o");
    expect(responsesText).not.toContain("exploded");
    expect(JSON.parse(responsesText)).toMatchObject({
      error: { message: "Upstream provider failed", type: "api_error" },
    });
  });

  it("renders a fixed value-free error on passthrough transport failure so endpoint/model canaries never reach the client", async () => {
    const fixture = await createAliasDataPlaneFixture(INITIAL_ALIASES);
    const anthropicPending = fixture.runtime.handle(
      anthropicRequest(
        {
          model: "sonnet",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        },
        fixture.clientToken,
      ),
    );
    const anthropicCall = await fixture.nextUpstreamCall();
    anthropicCall.fail(
      new Error(
        "fetch failed: https://canary-endpoint.example.com/v1/messages model claude-sonnet exploded",
      ),
    );
    const anthropicResponse = await anthropicPending;
    expect(anthropicResponse.status).toBe(502);
    const anthropicText = await anthropicResponse.text();
    expect(anthropicText).not.toContain("canary-endpoint");
    expect(anthropicText).not.toContain("claude-sonnet");
    expect(anthropicText).not.toContain("fetch failed");
    expect(anthropicText).not.toContain("exploded");
    expect(JSON.parse(anthropicText)).toMatchObject({
      error: { type: "api_error" },
    });

    const responsesPending = fixture.runtime.handle(
      responsesRequest({ model: "gpt", input: "hello" }, fixture.responsesToken),
    );
    const responsesCall = await fixture.nextUpstreamCall();
    responsesCall.fail(
      new Error(
        "fetch failed: https://canary-gateway.example.com/v1/responses model gpt-4o unreachable",
      ),
    );
    const responsesResponse = await responsesPending;
    expect(responsesResponse.status).toBe(502);
    const responsesText = await responsesResponse.text();
    expect(responsesText).not.toContain("canary-gateway");
    expect(responsesText).not.toContain("gpt-4o");
    expect(responsesText).not.toContain("fetch failed");
    expect(responsesText).not.toContain("unreachable");
  });
});
