import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  RequestJourneyObservationAuthority,
  RequestJourneyObservationInput,
} from "../../src/diagnostics/contract.js";
import { handleHttpRequest, type HttpBoundaryDependencies } from "../../src/http.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import type { PublicModelSource } from "../../src/public-model-seam.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";

const ALIAS = "public/gpt-native";
const publicModels: PublicModelSource = {
  requestSnapshot: async () =>
    ({
      resolve: (selector: string) =>
        selector === ALIAS ? { providerId: "openai", modelId: "gpt-native" } : undefined,
    }) as never,
};

const UPSTREAM_REJECTION =
  "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)";

interface StubRequest {
  readonly path: string;
  readonly body: string;
  readonly status: number;
}

const received: StubRequest[] = [];
let server: Server;
let baseUrl = "";

/**
 * Independent adjacency oracle. It re-implements the upstream rule from the
 * Chat contraction of the Responses wire and never calls Token code.
 */
function violatesToolCallAdjacency(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const input = (parsed as Record<string, unknown>).input;
  if (!Array.isArray(input)) return false;
  const pending = new Set<string>();
  let sawOutput = false;
  for (const entry of input) {
    const item = entry as Record<string, unknown>;
    const type = item?.type;
    const callId = item?.call_id;
    if (type === "function_call" || type === "custom_tool_call") {
      if (pending.size > 0 && sawOutput) return true;
      if (typeof callId === "string") pending.add(callId);
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (pending.size === 0) continue;
      sawOutput = true;
      if (typeof callId === "string") pending.delete(callId);
      if (pending.size === 0) sawOutput = false;
      continue;
    }
    if (pending.size > 0) return true;
  }
  return pending.size > 0;
}

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const adjacent = violatesToolCallAdjacency(body);
      const status = adjacent ? 400 : 200;
      received.push({ path: incoming.url ?? "", body, status });
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(
        adjacent
          ? JSON.stringify({ error: { message: UPSTREAM_REJECTION, type: "invalid_request_error" } })
          : JSON.stringify({ id: "resp_stub", object: "response", status: "completed", model: "gpt-native", output: [] }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub upstream did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

function stubModel(): Model<string> {
  return {
    id: "gpt-native",
    name: "GPT Native",
    api: "openai-responses",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function request(body: string): Request {
  return new Request("http://Token.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function models(): Models {
  return {
    getModels: () => [stubModel()],
    getAuth: async () => ({ auth: { apiKey: "sk-stub" } }),
  } as unknown as Models;
}

function dependencies(
  fetch: FetchFunction,
  diagnostics?: RequestJourneyObservationAuthority,
): HttpBoundaryDependencies {
  const source = models();
  const handler = createOpenAIResponsesHandler({
    models: source,
    providerNativeLane: createProviderNativeResponses({
      models: source,
      bindings: ambientProfileBindings,
      fetch,
    }),
    stateFile: "provider-native-adjacency-state.json",
    maxRequestBytes: 1_000_000,
    createResponseId: () => "resp_test",
    now: () => 1,
    publicModels,
  });
  return {
    clientProtocols: [handler],
    requestTimeoutMs: undefined,
    shutdownSignal: undefined,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function recordingJourney(): {
  readonly authority: RequestJourneyObservationAuthority;
  readonly observations: RequestJourneyObservationInput[];
} {
  const observations: RequestJourneyObservationInput[] = [];
  const authority: RequestJourneyObservationAuthority = {
    begin: (input) => ({
      requestId: input.requestId,
      observe: (observation) => observations.push(observation),
      close: () => undefined,
    }),
    observeRuntime: () => undefined,
  };
  return { authority, observations };
}

function interleavedItems(role = "developer"): unknown[] {
  return [
    { type: "function_call", call_id: "a", name: "exec_command", arguments: "{}" },
    { type: "function_call", call_id: "b", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: "ok" },
    { type: "message", role, content: [{ type: "input_text", text: "resize notice" }] },
    { type: "function_call_output", call_id: "b", output: "ok" },
  ];
}

describe("Provider Native adjacency stub-upstream seam", () => {
  it("rejects the exact pre-change body at the upstream oracle", async () => {
    const raw = JSON.stringify({ model: "gpt-native", input: interleavedItems() });
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("insufficient tool messages");
  });

  it("turns the same body into an accepted request and records the deferral notice", async () => {
    const raw = JSON.stringify({ model: ALIAS, input: interleavedItems() });
    const recorded = recordingJourney();
    const response = await handleHttpRequest(
      dependencies(async (input, init) => fetch(new Request(input, init)), recorded.authority),
      request(raw),
    );

    expect(response.status).toBe(200);
    const last = received[received.length - 1]!;
    expect(last.status).toBe(200);
    expect(violatesToolCallAdjacency(last.body)).toBe(false);
    expect(last.body).toBe(
      JSON.stringify({
        model: "gpt-native",
        input: [
          { type: "function_call", call_id: "a", name: "exec_command", arguments: "{}" },
          { type: "function_call", call_id: "b", name: "exec_command", arguments: "{}" },
          { type: "function_call_output", call_id: "a", output: "ok" },
          { type: "function_call_output", call_id: "b", output: "ok" },
          { type: "message", role: "developer", content: [{ type: "input_text", text: "resize notice" }] },
        ],
      }),
    );
    expect(recorded.observations).toContainEqual(
      expect.objectContaining({
        kind: "conversion_notice_observed",
        code: "provider_native_tool_call_adjacency_deferred",
        severity: "info",
      }),
    );
  });

  it("keeps the baseline outcome for a shape the contract does not qualify", async () => {
    const raw = JSON.stringify({ model: ALIAS, input: interleavedItems("user") });
    const recorded = recordingJourney();
    const response = await handleHttpRequest(
      dependencies(async (input, init) => fetch(new Request(input, init)), recorded.authority),
      request(raw),
    );

    expect(response.status).toBe(502);
    const last = received[received.length - 1]!;
    expect(last.status).toBe(400);
    expect(last.body).toBe(
      JSON.stringify({ model: "gpt-native", input: interleavedItems("user") }),
    );
    expect(recorded.observations).toContainEqual(
      expect.objectContaining({
        kind: "conversion_notice_observed",
        code: "provider_native_tool_call_group_unsupported_item",
        severity: "warning",
      }),
    );
  });
});
