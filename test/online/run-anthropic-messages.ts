/**
 * Direct Anthropic Messages semantic-conversion certification.
 *
 * This harness constructs `/v1/messages` requests itself. It is intentionally
 * separate from the Claude Code real-agent suite and does not invoke Codex CLI.
 * Each Provider entry point supplies one fixed Provider/model/key tuple.
 * Diagnostics are not an oracle: the suite captures the actual upstream wire,
 * validates client JSON/SSE, and emits its own bounded report.
 */
import type {
  AuthInteraction,
  AuthPrompt,
  FetchFunction,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";
import {
  createConfiguredLuckyTokenDataPlane,
  createConfiguredPiModels,
  type ConfiguredLuckyTokenDataPlane,
} from "../support/configured-data-plane.js";
import {
  createOnlinePublicModelAuthority,
  reconcileOnlinePublicModels,
} from "./public-model-fixture.js";
import { loginOnlineProvider } from "./provider-login.js";
import { readOnlineProviderMessages } from "./provider-wire.js";

const REQUEST_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 20 * 60_000;
const MAX_TOKENS = 512;

interface OnlineArguments {
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyFile: string;
  readonly alias?: string;
}

interface CapturedExchange {
  readonly url: string;
  readonly body: string;
}

interface AnthropicContentBlock extends Readonly<Record<string, unknown>> {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly luckytoken_continuity?: unknown;
}

interface AnthropicResult {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason: string;
  readonly usage: Readonly<Record<string, unknown>>;
}

interface CaseResult {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly ms: number;
  readonly error?: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(args: readonly string[]): OnlineArguments {
  let providerId: string | undefined;
  let model: string | undefined;
  let apiKeyFile: string | undefined;
  let alias: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1]?.trim();
    if (argument === "--provider") providerId = value;
    else if (argument === "--model") model = value;
    else if (argument === "--api-key-file") apiKeyFile = value;
    else if (argument === "--alias") alias = value;
    else throw new Error(`Unknown Anthropic online option: ${String(argument)}`);
    if (!value) throw new Error(`${String(argument)} requires a non-empty value`);
    index += 1;
  }
  if (!providerId || !model || !apiKeyFile) {
    throw new Error("--provider, --model, and --api-key-file are required");
  }
  return Object.freeze({
    providerId,
    model,
    apiKeyFile,
    ...(alias === undefined ? {} : { alias }),
  });
}

function aliasTargetFor(
  providerId: string,
  model: string,
): { readonly provider: string; readonly model: string } {
  const prefix = `${providerId}/`;
  return Object.freeze({
    provider: providerId,
    model: model.startsWith(prefix) ? model.slice(prefix.length) : model,
  });
}

function keyFileLoginInteraction(apiKey: string): AuthInteraction {
  return Object.freeze({
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type !== "secret" && prompt.type !== "text") {
        throw new Error(`Online login cannot answer ${prompt.type}`);
      }
      return apiKey;
    },
    notify: () => undefined,
  });
}

function createCapturingFetch(base: FetchFunction): {
  readonly fetch: FetchFunction;
  readonly exchanges: CapturedExchange[];
} {
  const exchanges: CapturedExchange[] = [];
  return Object.freeze({
    exchanges,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const host = new URL(request.url).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") {
        exchanges.push(Object.freeze({
          url: request.url,
          body: await request.clone().text(),
        }));
      }
      return base(request);
    },
  });
}

function requestSignal(total: AbortSignal): AbortSignal {
  return AbortSignal.any([total, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

function promptFor(marker: string): string {
  return `Reply with the exact token ${marker} and no other text.`;
}

async function postMessages(input: {
  readonly origin: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}): Promise<AnthropicResult> {
  const response = await fetch(`${input.origin}/v1/messages`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "unused-local-client-key",
    },
    body: JSON.stringify(input.body),
    signal: input.signal,
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`online_http_${response.status}: ${text.slice(0, 512)}`);
  }
  const result = JSON.parse(text) as AnthropicResult;
  if (
    result.type !== "message" ||
    result.role !== "assistant" ||
    !Array.isArray(result.content) ||
    !isRecord(result.usage)
  ) {
    throw new Error("online_anthropic_json_shape");
  }
  return result;
}

async function postMessagesExpectFailure(input: {
  readonly origin: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(`${input.origin}/v1/messages`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "unused-local-client-key",
    },
    body: JSON.stringify(input.body),
    signal: input.signal,
  });
  const text = await response.text();
  if (response.status === 200) {
    throw new Error("online_expected_predispatch_failure_missing");
  }
  return Object.freeze({ status: response.status, text });
}

function visibleText(result: AnthropicResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function reasoningSummary(result: AnthropicResult): string {
  const summary = result.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? "")
    .join("\n");
  if (summary.length === 0) throw new Error("online_anthropic_thinking_missing");
  return summary;
}

function assertMarker(result: AnthropicResult, marker: string): void {
  const text = visibleText(result);
  if (text.length === 0) throw new Error("online_anthropic_text_missing");
  if (!text.includes(marker)) throw new Error("online_anthropic_marker_missing");
  if (!new Set(["end_turn", "max_tokens", "tool_use"]).has(result.stop_reason)) {
    throw new Error(`online_anthropic_stop_reason_${result.stop_reason}`);
  }
}

async function postMessagesSse(input: {
  readonly origin: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}): Promise<{ readonly eventTypes: readonly string[]; readonly text: string }> {
  const response = await fetch(`${input.origin}/v1/messages`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "unused-local-client-key",
    },
    body: JSON.stringify({ ...input.body, stream: true }),
    signal: input.signal,
  });
  const wire = await response.text();
  if (response.status !== 200) {
    throw new Error(`online_sse_http_${response.status}: ${wire.slice(0, 512)}`);
  }
  const eventTypes: string[] = [];
  let text = "";
  for (const frame of wire.split("\n\n")) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    const event = JSON.parse(dataLine.slice(6)) as Readonly<Record<string, unknown>>;
    if (typeof event.type === "string") eventTypes.push(event.type);
    if (event.type === "content_block_delta" && isRecord(event.delta) &&
      event.delta.type === "text_delta" && typeof event.delta.text === "string") {
      text += event.delta.text;
    }
  }
  if (
    eventTypes[0] !== "message_start" ||
    !eventTypes.includes("message_delta") ||
    eventTypes.at(-1) !== "message_stop"
  ) {
    throw new Error(`online_anthropic_sse_lifecycle: ${eventTypes.join(",")}`);
  }
  return Object.freeze({ eventTypes: Object.freeze(eventTypes), text });
}

function exchangeFor(
  exchanges: readonly CapturedExchange[],
  marker: string,
): CapturedExchange {
  const exchange = exchanges.findLast((candidate) => candidate.body.includes(marker));
  if (exchange === undefined) {
    const summary = exchanges.map((candidate) => ({
      pathname: new URL(candidate.url).pathname,
      bytes: Buffer.byteLength(candidate.body),
      hasMarker: candidate.body.includes(marker),
    }));
    throw new Error(`online_upstream_capture_missing: ${JSON.stringify(summary)}`);
  }
  return exchange;
}

function providerPayload(exchange: CapturedExchange): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(exchange.body) as unknown;
  if (!isRecord(parsed)) throw new Error("online_provider_payload_shape");
  return parsed;
}

function requireReasoningReplay(input: {
  readonly api: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly summary: string;
}): void {
  const messages = readOnlineProviderMessages(input.api, input.payload);
  const replayed = messages.some((message) => {
    if (message.role !== "assistant") return false;
    if (input.api === "commandcode-private") {
      return Array.isArray(message.content) && message.content.some(
        (block) => isRecord(block) && block.type === "reasoning" && block.text === input.summary,
      );
    }
    return ["reasoning_content", "reasoning", "reasoning_text"].some(
      (field) => message[field] === input.summary,
    );
  });
  if (!replayed) throw new Error("online_anthropic_full_history_reasoning_replay_missing");
}

function requireSupportedWireControls(input: {
  readonly api: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): void {
  const target = input.api === "commandcode-private"
    ? input.payload.params
    : input.payload;
  if (!isRecord(target)) throw new Error("online_anthropic_projection_payload_shape");
  const tokenLimit = target.max_completion_tokens ?? target.max_tokens;
  if (tokenLimit !== MAX_TOKENS || target.temperature !== 0.4) {
    throw new Error("online_anthropic_basic_projection_mismatch");
  }
  if (target.reasoning_effort !== "high") {
    throw new Error("online_anthropic_reasoning_effort_mismatch");
  }
  if (input.api === "commandcode-private") {
    if (Object.hasOwn(target, "top_p") || Object.hasOwn(target, "top_k")) {
      throw new Error("online_anthropic_private_unsupported_sampling_leaked");
    }
    return;
  }
  if (target.top_p !== 0.8 || target.top_k !== 12) {
    throw new Error("online_anthropic_sampling_projection_mismatch");
  }
}

async function runCase(
  results: CaseResult[],
  id: string,
  operation: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  try {
    await operation();
    results.push(Object.freeze({ id, status: "pass", ms: Math.round(performance.now() - started) }));
  } catch (error) {
    results.push(Object.freeze({
      id,
      status: "fail",
      ms: Math.round(performance.now() - started),
      error: (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 1_024),
    }));
  }
}

export async function runAnthropicMessagesOnlineSuite(
  args: readonly string[],
): Promise<void> {
  const parsed = parseArguments(args);
  const selector = parsed.alias ?? parsed.model;
  const aliasTarget = aliasTargetFor(parsed.providerId, parsed.model);
  const apiKey = (await readFile(parsed.apiKeyFile, "utf8")).trim();
  if (apiKey.length === 0) throw new Error(`${parsed.apiKeyFile} is empty`);
  const totalSignal = AbortSignal.timeout(SUITE_TIMEOUT_MS);
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-anthropic-online-"));
  const originalFetch = globalThis.fetch;
  const capture = createCapturingFetch(originalFetch);
  globalThis.fetch = capture.fetch as typeof globalThis.fetch;
  let composition: ConfiguredLuckyTokenDataPlane | undefined;
  let server: Awaited<ReturnType<typeof startLuckyTokenHttpServer>> | undefined;
  try {
    const stateDirectory = join(directory, ".luckytoken");
    await mkdir(join(stateDirectory, "pi"), { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: "luckytoken-config-v2",
      server: { port: 0 },
      clientProtocols: { "anthropic-messages": {} },
      providerPackages: {},
      pi: { directory: "pi" },
      limits: {
        maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      },
    }), "utf8");
    const config = await loadLuckyTokenCliConfig(configPath);
    const credentialRecordStore = createInMemoryProviderCredentialRecordStore({
      createRevision: randomUUID,
    });
    const preLogin = await createConfiguredPiModels({
      piDirectory: config.pi.directory,
      ...(config.pi.modelsJson === undefined ? {} : { modelsJsonPath: config.pi.modelsJson }),
      providerPackages: config.providerPackages,
      fetch: capture.fetch,
      credentialRecordStore,
    });
    await loginOnlineProvider({
      models: preLogin.models,
      providerAuthBindings: preLogin.providerAuthBindings,
      credentialManagement: preLogin.credentialManagement,
      providerId: parsed.providerId,
      authType: "api_key",
      displayName: "Anthropic online test",
      interaction: keyFileLoginInteraction(apiKey),
    });
    const publicModelAuthority = parsed.alias === undefined
      ? undefined
      : await createOnlinePublicModelAuthority({
          path: join(stateDirectory, "public-models.json"),
          endpoint: {
            host: "127.0.0.1",
            port: config.server.port > 0 ? config.server.port : 3000,
          },
          alias: parsed.alias,
          providerId: aliasTarget.provider,
          modelId: aliasTarget.model,
        });
    composition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentialRecordStore,
      fetch: capture.fetch,
      ...(publicModelAuthority === undefined ? {} : { publicModelAuthority }),
    });
    if (publicModelAuthority !== undefined) {
      await reconcileOnlinePublicModels(
        publicModelAuthority,
        composition.catalog.models,
        parsed.providerId,
      );
    }
    const resolvedModel = composition.catalog.models.getModel(aliasTarget.provider, aliasTarget.model);
    if (resolvedModel === undefined) throw new Error("online_resolved_provider_model_missing");
    const providerApi = resolvedModel.api;
    server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });
    const origin = server.origin;
    const results: CaseResult[] = [];

    const basicMarker = "LT_ANTHROPIC_BASIC_01";
    let firstTurn: AnthropicResult | undefined;
    await runCase(results, "json-basic-final-wire", async () => {
      firstTurn = await postMessages({
        origin,
        signal: requestSignal(totalSignal),
        body: {
          model: selector,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: promptFor(basicMarker) }],
          temperature: 0.4,
          top_p: 0.8,
          top_k: 12,
          output_config: { effort: "high" },
        },
      });
      assertMarker(firstTurn, basicMarker);
      reasoningSummary(firstTurn);
      requireSupportedWireControls({
        api: providerApi,
        payload: providerPayload(exchangeFor(capture.exchanges, basicMarker)),
      });
    });

    const sseMarker = "LT_ANTHROPIC_SSE_01";
    await runCase(results, "sse-lifecycle", async () => {
      const result = await postMessagesSse({
        origin,
        signal: requestSignal(totalSignal),
        body: {
          model: selector,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: promptFor(sseMarker) }],
        },
      });
      if (!result.text.includes(sseMarker)) throw new Error("online_anthropic_sse_marker_missing");
    });

    await runCase(results, "complete-history-reasoning-replay", async () => {
      if (firstTurn === undefined) throw new Error("online_anthropic_first_turn_unavailable");
      const summary = reasoningSummary(firstTurn);
      const marker = "LT_ANTHROPIC_HISTORY_02";
      const next = await postMessages({
        origin,
        signal: requestSignal(totalSignal),
        body: {
          model: selector,
          max_tokens: MAX_TOKENS,
          messages: [
            { role: "user", content: promptFor(basicMarker) },
            { role: "assistant", content: firstTurn.content },
            { role: "user", content: promptFor(marker) },
          ],
          output_config: { effort: "high" },
        },
      });
      assertMarker(next, marker);
      requireReasoningReplay({
        api: providerApi,
        payload: providerPayload(exchangeFor(capture.exchanges, marker)),
        summary,
      });
    });

    await runCase(results, "hard-control-disposition", async () => {
      const marker = "LT_ANTHROPIC_HARD_CONTROL_01";
      const before = capture.exchanges.length;
      if (providerApi === "commandcode-private") {
        const failure = await postMessagesExpectFailure({
          origin,
          signal: requestSignal(totalSignal),
          body: {
            model: selector,
            max_tokens: MAX_TOKENS,
            messages: [{ role: "user", content: promptFor(marker) }],
            stop_sequences: ["END"],
          },
        });
        if (!failure.text.includes("stop sequence")) {
          throw new Error(`online_anthropic_wrong_predispatch_failure_${failure.status}`);
        }
        if (capture.exchanges.length !== before) {
          throw new Error("online_anthropic_predispatch_failure_reached_provider");
        }
        return;
      }

      const toolName = "online_anthropic_lookup";
      const forced = parsed.providerId === "commandcode-goat";
      const body = {
        model: selector,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: `Call ${toolName} with marker ${marker}.` }],
        tools: [{
          name: toolName,
          description: "Return the marker",
          input_schema: {
            type: "object",
            properties: { marker: { type: "string" } },
            required: ["marker"],
            additionalProperties: false,
          },
        }],
        tool_choice: {
          type: "tool",
          name: toolName,
          disable_parallel_tool_use: true,
        },
      };
      if (forced) {
        const failure = await postMessagesExpectFailure({
          origin,
          body,
          signal: requestSignal(totalSignal),
        });
        if (!failure.text.includes("thinking mode does not support forced tool_choice")) {
          throw new Error(`online_anthropic_wrong_goat_failure_${failure.status}`);
        }
        if (capture.exchanges.length !== before) {
          throw new Error("online_anthropic_goat_failure_reached_provider");
        }
        return;
      }
      const result = await postMessages({
        origin,
        body,
        signal: requestSignal(totalSignal),
      });
      const tool = result.content.find(
        (block) => block.type === "tool_use" && block.name === toolName,
      );
      if (tool?.id === undefined) throw new Error("online_anthropic_forced_tool_missing");
      const payload = providerPayload(exchangeFor(capture.exchanges, marker));
      if (
        payload.parallel_tool_calls !== false ||
        !isRecord(payload.tool_choice) ||
        !isRecord(payload.tool_choice.function) ||
        payload.tool_choice.function.name !== toolName
      ) {
        throw new Error("online_anthropic_tool_projection_wire_mismatch");
      }
    });

    process.stdout.write(`${JSON.stringify({
      protocol: "anthropic-messages",
      client: "direct-raw-protocol",
      provider: parsed.providerId,
      model: selector,
      providerApi,
      cases: results,
    }, null, 2)}\n`);
    if (results.some((result) => result.status === "fail")) process.exitCode = 1;
  } finally {
    await server?.close();
    await composition?.close();
    if (globalThis.fetch === capture.fetch) globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}
