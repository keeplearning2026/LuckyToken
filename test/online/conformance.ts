import type Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  MessageStreamEvent,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ONLINE_CONFORMANCE_CASES } from "./plan.js";

const KNOWN_COMMANDCODE_EVENTS = new Set([
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
  "finish",
  "error",
  "abort",
  "start",
  "start-step",
  "provider-metadata",
  "finish-step",
  "tool-result",
]);

export interface CapturedCommandCodeExchange {
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly rawJsonl: readonly string[];
    readonly events: readonly unknown[];
    readonly physicalEof: true;
  };
}

interface CapturedClientExchange {
  readonly request: unknown;
  readonly response: Message;
  readonly streamEvents?: readonly MessageStreamEvent[];
}

export interface OnlineConformanceSample {
  readonly scenario: string;
  readonly transport: "json" | "sse";
  readonly client: { readonly exchanges: readonly CapturedClientExchange[] };
  readonly commandCode: {
    readonly exchanges: readonly CapturedCommandCodeExchange[];
  };
}

export interface OnlineConformanceArtifact {
  readonly schemaVersion: "luckytoken-online-conformance-samples-v1";
  readonly generatedAt: string;
  readonly model: string;
  readonly cases: readonly OnlineConformanceSample[];
}

function fail(category: string): never {
  throw new Error(`online_conformance_${category}`);
}

function failScenario(scenario: string, error: unknown): never {
  if (
    error instanceof Error &&
    /^online_conformance_[a-z0-9_]+$/u.test(error.message)
  ) {
    throw error;
  }
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? `http_${error.status}`
      : "error";
  throw new Error(`online_conformance_${scenario}_${status}`, { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, category: string): Record<string, unknown> {
  if (!isRecord(value)) fail(category);
  return value;
}

function array(value: unknown, category: string): unknown[] {
  if (!Array.isArray(value)) fail(category);
  return value;
}

function safeHeaders(headers: Headers): Readonly<Record<string, string>> {
  const result = Object.fromEntries(headers);
  if (headers.has("authorization")) result.authorization = "Bearer <redacted>";
  return Object.freeze(result);
}

function parseJsonLines(body: string): { lines: string[]; events: unknown[] } {
  const lines = body.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) fail("empty_upstream_jsonl");
  const events = lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      fail("invalid_upstream_jsonl");
    }
    const event = record(parsed, "non_object_upstream_event");
    if (
      typeof event.type !== "string" ||
      !KNOWN_COMMANDCODE_EVENTS.has(event.type)
    ) {
      fail("unknown_upstream_event");
    }
    return parsed;
  });
  return { lines, events };
}

export function createCapturingCommandCodeFetch(
  upstream: FetchFunction,
): {
  readonly fetch: FetchFunction;
  readonly exchanges: CapturedCommandCodeExchange[];
} {
  const exchanges: CapturedCommandCodeExchange[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
      fail("missing_upstream_authorization");
    }
    const requestText = await request.clone().text();
    let requestBody: unknown;
    try {
      requestBody = JSON.parse(requestText) as unknown;
    } catch {
      fail("invalid_upstream_request_json");
    }
    const response = await upstream(request);
    const responseText = await response.text();
    const parsed = parseJsonLines(responseText);
    exchanges.push(
      Object.freeze({
        request: Object.freeze({
          method: request.method,
          url: request.url,
          headers: safeHeaders(request.headers),
          body: requestBody,
        }),
        response: Object.freeze({
          status: response.status,
          headers: safeHeaders(response.headers),
          rawJsonl: Object.freeze(parsed.lines),
          events: Object.freeze(parsed.events),
          physicalEof: true as const,
        }),
      }),
    );
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch, exchanges };
}

function validateProviderEnvelope(
  exchange: CapturedCommandCodeExchange,
  modelId: string,
): Record<string, unknown> {
  if (
    exchange.request.method !== "POST" ||
    new URL(exchange.request.url).pathname !== "/alpha/generate" ||
    exchange.request.headers.authorization !== "Bearer <redacted>"
  ) {
    fail("upstream_envelope");
  }
  const body = record(exchange.request.body, "upstream_body");
  const params = record(body.params, "upstream_params");
  if (
    params.model !== modelId ||
    params.stream !== true ||
    !Number.isSafeInteger(params.max_tokens) ||
    (params.max_tokens as number) <= 0 ||
    !Array.isArray(params.messages) ||
    !Array.isArray(params.tools)
  ) {
    fail("upstream_params_shape");
  }
  const threadId = body.threadId;
  if (
    typeof threadId !== "string" ||
    exchange.request.headers["x-session-id"] !== threadId
  ) {
    fail("session_correlation");
  }
  const events = exchange.response.events.map((event) =>
    record(event, "upstream_event"),
  );
  const finishEvents = events.filter((event) => event.type === "finish");
  if (exchange.response.status !== 200 || finishEvents.length !== 1) {
    fail("upstream_terminal");
  }
  if (events.some((event) => event.type === "error" || event.type === "abort")) {
    fail("upstream_failure_event");
  }
  return params;
}

function validateMessage(
  message: Message,
  modelId: string,
  allowedStops: readonly Message["stop_reason"][],
): void {
  if (
    message.model !== modelId ||
    message.role !== "assistant" ||
    !allowedStops.includes(message.stop_reason) ||
    message.content.length === 0 ||
    !Number.isSafeInteger(message.usage.input_tokens) ||
    message.usage.input_tokens < 0 ||
    !Number.isSafeInteger(message.usage.output_tokens) ||
    message.usage.output_tokens < 0
  ) {
    fail("anthropic_message_envelope");
  }
}

function requireMarker(message: Message, marker: string): void {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text.includes(marker)) fail("marker_isolation");
}

function requireThinking(message: Message): void {
  if (
    !message.content.some(
      (block) =>
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        typeof block.signature === "string",
    )
  ) {
    fail("missing_thinking");
  }
}

function eventsContain(
  exchange: CapturedCommandCodeExchange,
  type: string,
): boolean {
  return exchange.response.events.some(
    (event) => isRecord(event) && event.type === type,
  );
}

function requestSignal(totalSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([totalSignal, AbortSignal.timeout(120_000)]);
}

function sample(
  scenario: string,
  transport: "json" | "sse",
  clientExchanges: CapturedClientExchange[],
  commandCodeExchanges: CapturedCommandCodeExchange[],
): OnlineConformanceSample {
  return Object.freeze({
    scenario,
    transport,
    client: Object.freeze({ exchanges: Object.freeze(clientExchanges) }),
    commandCode: Object.freeze({
      exchanges: Object.freeze(commandCodeExchanges),
    }),
  });
}

function requireOneCapture(
  captures: CapturedCommandCodeExchange[],
  start: number,
): CapturedCommandCodeExchange {
  if (captures.length !== start + 1) fail("capture_correlation");
  return captures[start] as CapturedCommandCodeExchange;
}

async function jsonExchange(
  scenario: string,
  client: Anthropic,
  modelId: string,
  request: MessageCreateParamsNonStreaming,
  totalSignal: AbortSignal,
  captures: CapturedCommandCodeExchange[],
): Promise<{
  readonly client: CapturedClientExchange;
  readonly commandCode: CapturedCommandCodeExchange;
}> {
  try {
    const start = captures.length;
    const response = await client.messages.create(request, {
      signal: requestSignal(totalSignal),
    });
    const commandCode = requireOneCapture(captures, start);
    validateProviderEnvelope(commandCode, modelId);
    return {
      client: Object.freeze({ request, response }),
      commandCode,
    };
  } catch (error) {
    failScenario(scenario, error);
  }
}

const ONLINE_TOOLS: readonly Tool[] = Object.freeze([
  Object.freeze({
    name: "online_lookup",
    description:
      "Call this tool when explicitly requested. Return the exact marker in value.",
    input_schema: {
      type: "object" as const,
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    strict: false,
  }),
]);

function seededToolMessages(
  id: string,
  result: { content?: string; isError?: boolean },
): MessageParam[] {
  const resultBlock: ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: id,
    ...(result.content === undefined
      ? {}
      : { content: [{ type: "text", text: result.content }] }),
    ...(result.isError === undefined ? {} : { is_error: result.isError }),
  };
  return [
    { role: "user", content: "Use the supplied historical tool result." },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "online_lookup",
          input: { value: id },
        },
      ],
    },
    { role: "user", content: [resultBlock] },
  ];
}

function assertToolResultWire(
  exchange: CapturedCommandCodeExchange,
  modelId: string,
  id: string,
  expectedType: "text" | "error-text",
  expectedValue: string,
): void {
  validateProviderEnvelope(exchange, modelId);
  const body = record(exchange.request.body, "tool_result_body");
  const requestParams = record(body.params, "tool_result_params");
  const messages = array(requestParams.messages, "tool_result_messages").map((entry) =>
    record(entry, "tool_result_message"),
  );
  const assistant = messages.find((entry) => entry.role === "assistant");
  const tool = messages.find((entry) => entry.role === "tool");
  const call = record(
    array(assistant?.content, "tool_call_content")[0],
    "tool_call",
  );
  const result = record(
    array(tool?.content, "tool_result_content")[0],
    "tool_result",
  );
  const output = record(result.output, "tool_result_output");
  if (
    call.type !== "tool-call" ||
    call.toolCallId !== id ||
    result.type !== "tool-result" ||
    result.toolCallId !== id ||
    output.type !== expectedType ||
    output.value !== expectedValue
  ) {
    fail("tool_result_correlation");
  }
}

export async function runOnlineConformance(
  client: Anthropic,
  modelId: string,
  totalSignal: AbortSignal,
  captures: CapturedCommandCodeExchange[],
): Promise<readonly OnlineConformanceSample[]> {
  const expectedCases = new Set(ONLINE_CONFORMANCE_CASES.map((entry) => entry.id));
  const samples: OnlineConformanceSample[] = [];

  const systemMarker = "LT_CONFORMANCE_SYSTEM_JSON";
  const systemRequest: MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: 512,
    temperature: 0,
    metadata: { user_id: "luckytoken-online-conformance" },
    system: "Preserve the user's requested exact marker.",
    messages: [
      { role: "user", content: `Reply with exactly ${systemMarker}.` },
    ],
  };
  const system = await jsonExchange(
    "system_controls_json",
    client,
    modelId,
    systemRequest,
    totalSignal,
    captures,
  );
  const systemParams = validateProviderEnvelope(system.commandCode, modelId);
  if (
    systemParams.system !== systemRequest.system ||
    systemParams.temperature !== 0 ||
    systemParams.max_tokens !== 512 ||
    JSON.stringify(system.commandCode.request.body).includes(
      "luckytoken-online-conformance",
    )
  ) {
    fail("system_controls_mapping");
  }
  validateMessage(system.client.response, modelId, ["end_turn", "max_tokens"]);
  requireMarker(system.client.response, systemMarker);
  requireThinking(system.client.response);
  if (
    !eventsContain(system.commandCode, "reasoning-start") ||
    !eventsContain(system.commandCode, "text-start")
  ) {
    fail("provider_content_lifecycle");
  }
  samples.push(
    sample("system-controls-json", "json", [system.client], [system.commandCode]),
  );

  const sseMarker = "LT_CONFORMANCE_ATOMIC_SSE";
  const sseRequest = {
    model: modelId,
    max_tokens: 512,
    messages: [{ role: "user" as const, content: `Reply with exactly ${sseMarker}.` }],
  };
  const sseStart = captures.length;
  const streamEvents: MessageStreamEvent[] = [];
  const stream = client.messages.stream(sseRequest, {
    signal: requestSignal(totalSignal),
  });
  stream.on("streamEvent", (event) => streamEvents.push(structuredClone(event)));
  const sseResponse = await stream.finalMessage();
  const sseCapture = requireOneCapture(captures, sseStart);
  validateProviderEnvelope(sseCapture, modelId);
  validateMessage(sseResponse, modelId, ["end_turn", "max_tokens"]);
  requireMarker(sseResponse, sseMarker);
  requireThinking(sseResponse);
  const streamTypes = streamEvents.map((event) => event.type);
  if (
    streamTypes[0] !== "message_start" ||
    streamTypes.at(-1) !== "message_stop" ||
    !streamTypes.includes("content_block_start") ||
    !streamTypes.includes("content_block_delta") ||
    !streamTypes.includes("content_block_stop") ||
    !streamTypes.includes("message_delta")
  ) {
    fail("atomic_sse_lifecycle");
  }
  samples.push(
    sample(
      "atomic-sse-events",
      "sse",
      [{ request: sseRequest, response: sseResponse, streamEvents }],
      [sseCapture],
    ),
  );

  const historyMarker = "LT_CONFORMANCE_HISTORY";
  const historyRequest: MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: 512,
    messages: [
      { role: "user", content: "First turn." },
      { role: "assistant", content: "Prior assistant text." },
      { role: "user", content: `Reply with exactly ${historyMarker}.` },
    ],
  };
  const history = await jsonExchange(
    "historical_text",
    client,
    modelId,
    historyRequest,
    totalSignal,
    captures,
  );
  const historicalMessages = array(
    validateProviderEnvelope(history.commandCode, modelId).messages,
    "historical_messages",
  );
  if (
    !historicalMessages.some(
      (entry) =>
        isRecord(entry) &&
        entry.role === "assistant" &&
        JSON.stringify(entry).includes("Prior assistant text."),
    )
  ) {
    fail("historical_text_mapping");
  }
  validateMessage(history.client.response, modelId, ["end_turn", "max_tokens"]);
  requireMarker(history.client.response, historyMarker);
  samples.push(
    sample("historical-text", "json", [history.client], [history.commandCode]),
  );

  const replayMarker = "LT_CONFORMANCE_THINKING_REPLAY";
  const replayRequest: MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: 512,
    messages: [
      ...systemRequest.messages,
      {
        role: "assistant",
        content: system.client.response.content as MessageParam["content"],
      },
      { role: "user", content: `Reply with exactly ${replayMarker}.` },
    ],
  };
  const replay = await jsonExchange(
    "thinking_round_trip",
    client,
    modelId,
    replayRequest,
    totalSignal,
    captures,
  );
  const replayWire = JSON.stringify(replay.commandCode.request.body);
  if (
    !replayWire.includes('"type":"reasoning"') ||
    replayWire.includes('"type":"thinking"') ||
    replayWire.includes('"signature"')
  ) {
    fail("thinking_replay_mapping");
  }
  validateMessage(replay.client.response, modelId, ["end_turn", "max_tokens"]);
  requireMarker(replay.client.response, replayMarker);
  samples.push(
    sample("thinking-round-trip", "json", [replay.client], [replay.commandCode]),
  );

  const lengthRequest: MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: 1,
    messages: [
      {
        role: "user",
        content: "Write a detailed multi-paragraph explanation of protocol conversion.",
      },
    ],
  };
  const length = await jsonExchange(
    "max_tokens_terminal",
    client,
    modelId,
    lengthRequest,
    totalSignal,
    captures,
  );
  validateMessage(length.client.response, modelId, ["end_turn", "max_tokens"]);
  samples.push(
    sample("max-tokens-terminal", "json", [length.client], [length.commandCode]),
  );

  const concurrentRequests: MessageCreateParamsNonStreaming[] = Array.from(
    { length: 5 },
    (_unused, index) => ({
      model: modelId,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `Reply with exactly LT_CONFORMANCE_CONCURRENT_${index + 1}.`,
        },
      ],
    }),
  );
  const concurrentStart = captures.length;
  const concurrentResponses = await Promise.all(
    concurrentRequests.map((request) =>
      client.messages.create(request, { signal: requestSignal(totalSignal) }),
    ),
  );
  const concurrentCaptures = captures.slice(concurrentStart);
  if (concurrentCaptures.length !== concurrentRequests.length) {
    fail("concurrent_capture_count");
  }
  const concurrentClientExchanges = concurrentRequests.map((request, index) => {
    const response = concurrentResponses[index] as Message;
    const marker = `LT_CONFORMANCE_CONCURRENT_${index + 1}`;
    validateMessage(response, modelId, ["end_turn", "max_tokens"]);
    requireMarker(response, marker);
    if (
      !concurrentCaptures.some((capture) =>
        JSON.stringify(capture.request.body).includes(marker),
      )
    ) {
      fail("concurrent_request_isolation");
    }
    return Object.freeze({ request, response });
  });
  concurrentCaptures.forEach((capture) =>
    validateProviderEnvelope(capture, modelId),
  );
  samples.push(
    sample(
      "concurrent-isolation",
      "json",
      concurrentClientExchanges,
      concurrentCaptures,
    ),
  );

  const toolClientExchanges: CapturedClientExchange[] = [];
  const toolCommandCodeExchanges: CapturedCommandCodeExchange[] = [];
  let toolResponse: Message | undefined;
  let toolRequest: MessageCreateParamsNonStreaming | undefined;
  let toolUse:
    | Extract<Message["content"][number], { type: "tool_use" }>
    | undefined;
  for (let attempt = 1; attempt <= 3 && toolUse === undefined; attempt += 1) {
    toolRequest = {
      model: modelId,
      max_tokens: 512,
      tools: [...ONLINE_TOOLS],
      messages: [
        {
          role: "user",
          content: `Call online_lookup exactly once with value LT_TOOL_${attempt}. Do not answer in text.`,
        },
      ],
    };
    const exchange = await jsonExchange(
      "provider_tool_call_probe",
      client,
      modelId,
      toolRequest,
      totalSignal,
      captures,
    );
    toolResponse = exchange.client.response;
    toolClientExchanges.push(exchange.client);
    toolCommandCodeExchanges.push(exchange.commandCode);
    toolUse = toolResponse.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> =>
        block.type === "tool_use",
    );
  }
  if (toolUse === undefined || toolResponse === undefined || toolRequest === undefined) {
    fail("provider_tool_call_not_observed");
  }
  validateMessage(toolResponse, modelId, ["tool_use"]);
  const providerToolEvent = toolCommandCodeExchanges.some((exchange) =>
    exchange.response.events.some(
      (event) =>
        isRecord(event) &&
        event.type === "tool-call" &&
        event.toolCallId === toolUse.id,
    ),
  );
  if (!providerToolEvent) fail("provider_tool_identity");
  const continuationRequest: MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: 512,
    tools: [...ONLINE_TOOLS],
    messages: [
      ...toolRequest.messages,
      {
        role: "assistant",
        content: toolResponse.content as MessageParam["content"],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: [
              {
                type: "text",
                text: `result for ${String(record(toolUse.input, "tool_input").value)}`,
              },
            ],
          },
        ],
      },
    ],
  };
  const continuation = await jsonExchange(
    "provider_tool_call_continuation",
    client,
    modelId,
    continuationRequest,
    totalSignal,
    captures,
  );
  toolClientExchanges.push(continuation.client);
  toolCommandCodeExchanges.push(continuation.commandCode);
  const continuationWire = JSON.stringify(continuation.commandCode.request.body);
  if (
    !continuationWire.includes(toolUse.id) ||
    !continuationWire.includes('"type":"tool-call"') ||
    !continuationWire.includes('"type":"tool-result"')
  ) {
    fail("provider_tool_round_trip");
  }
  samples.push(
    sample(
      "provider-tool-call-round-trip",
      "json",
      toolClientExchanges,
      toolCommandCodeExchanges,
    ),
  );

  for (const seeded of [
    {
      scenario: "tool-result-omitted",
      id: "online_seeded_omitted",
      result: {},
      expectedType: "text" as const,
      expectedValue: "",
    },
    {
      scenario: "tool-result-text",
      id: "online_seeded_text",
      result: { content: "seeded text result" },
      expectedType: "text" as const,
      expectedValue: "seeded text result",
    },
    {
      scenario: "tool-result-error",
      id: "online_seeded_error",
      result: { content: "seeded error result", isError: true },
      expectedType: "error-text" as const,
      expectedValue: "seeded error result",
    },
  ]) {
    const request: MessageCreateParamsNonStreaming = {
      model: modelId,
      max_tokens: 512,
      tools: [...ONLINE_TOOLS],
      messages: seededToolMessages(seeded.id, seeded.result),
    };
    const exchange = await jsonExchange(
      seeded.scenario.replaceAll("-", "_"),
      client,
      modelId,
      request,
      totalSignal,
      captures,
    );
    assertToolResultWire(
      exchange.commandCode,
      modelId,
      seeded.id,
      seeded.expectedType,
      seeded.expectedValue,
    );
    samples.push(
      sample(seeded.scenario, "json", [exchange.client], [exchange.commandCode]),
    );
  }

  const observedCases = new Set(samples.map((entry) => entry.scenario));
  if (
    observedCases.size !== expectedCases.size ||
    [...expectedCases].some((id) => !observedCases.has(id))
  ) {
    fail("coverage_matrix");
  }
  return Object.freeze(samples);
}

export async function writeOnlineConformanceArtifact(
  outputPath: string,
  modelId: string,
  cases: readonly OnlineConformanceSample[],
  forbiddenSecrets: readonly string[],
): Promise<string> {
  const artifact: OnlineConformanceArtifact = {
    schemaVersion: "luckytoken-online-conformance-samples-v1",
    generatedAt: new Date().toISOString(),
    model: modelId,
    cases,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (
    forbiddenSecrets.some(
      (secret) => secret.length > 0 && serialized.includes(secret),
    )
  ) {
    fail("sample_contains_secret");
  }
  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, "utf8");
  return path;
}
