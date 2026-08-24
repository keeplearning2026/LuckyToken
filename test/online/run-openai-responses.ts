/**
 * Shared direct-Provider OpenAI Responses semantic-certification harness.
 *
 * It constructs protocol requests itself and drives a real Provider through
 * LuckyToken's local `/v1/responses` endpoint. Provider-specific entrypoints
 * select the fixed Provider/model/key tuple. This harness certifies only
 * complete-history semantic conversion and never claims Codex client state or
 * lifecycle behavior.
 *
 * Real Agent/client behavior belongs in separate runners such as
 * `run-codex-cli.ts`; only those runners may certify `previous_response_id`,
 * restart recovery, and other client-owned stateful behavior.
 *
 * API key files are git-ignored and read into memory only.
 */
import {
  type AuthInteraction,
  type AuthPrompt,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";
import {
  createOnlinePublicModelAuthority,
  reconcileOnlinePublicModels,
} from "./public-model-fixture.js";
import {
  createConfiguredLuckyTokenDataPlane,
  createConfiguredPiModels,
  type ConfiguredLuckyTokenDataPlane,
} from "../support/configured-data-plane.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";
import { loginOnlineProvider } from "./provider-login.js";
import {
  expectsForcedToolChoiceOmission,
  readOnlineProviderMessages,
  requireOnlineOpenAICompletionsProjection,
  requireOnlineReasoningReplay,
} from "./provider-wire.js";

const DEFAULT_MODEL = "commandcode-private/deepseek/deepseek-v4-flash";
const DEFAULT_CONCURRENCY = 5;
const SUCCESS_MAX_TOKENS = 512;
const REQUEST_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_PROVIDER_ID = "commandcode-private";
const DEFAULT_API_KEY_FILE = "CommandcodeAPIKey.txt";

interface OnlineArguments {
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyFile: string;
  readonly alias: string | undefined;
  readonly concurrency: number;
}

/**
 * Programmatic login interaction for the online suites: the Provider-owned
 * api-key login flow prompts for the key (secret), and the runner answers
 * with the key read from the git-ignored key file. This exercises the REAL
 * `Models.login` path (provider registration -> provider-owned prompt ->
 * persisted credential) instead of bypassing it by writing the store
 * directly.
 */
function keyFileLoginInteraction(apiKey: string): AuthInteraction {
  return Object.freeze({
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type !== "secret" && prompt.type !== "text") {
        throw new Error(
          `Online login does not support ${prompt.type} prompts`,
        );
      }
      return apiKey;
    },
    notify: () => undefined,
  });
}

/**
 * The alias registry target for one online run. The user mapping file
 * accepts `{ provider, model }` object form (the only form that can name a
 * model id containing "/", e.g. CommandCode's `deepseek/deepseek-v4-flash`);
 * the string form rejects model ids with a separator. `model` may be the
 * full `provider/model` selector (the DEFAULT_MODEL shape) or a bare model
 * id; either way the provider comes from the explicit `--provider` flag.
 */
function aliasTargetFor(
  providerId: string,
  model: string,
): { readonly provider: string; readonly model: string } {
  const prefix = `${providerId}/`;
  const modelId = model.startsWith(prefix)
    ? model.slice(prefix.length)
    : model;
  return { provider: providerId, model: modelId };
}

function parseArguments(args: readonly string[]): OnlineArguments {
  let providerId = DEFAULT_PROVIDER_ID;
  let model = DEFAULT_MODEL;
  let apiKeyFile = DEFAULT_API_KEY_FILE;
  let alias: string | undefined;
  let concurrency = DEFAULT_CONCURRENCY;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--concurrency") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
        throw new Error("--concurrency must be an integer from 1 to 20");
      }
      concurrency = value;
      index += 1;
      continue;
    }
    if (argument === "--provider") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--provider requires a non-empty id");
      providerId = value;
      index += 1;
      continue;
    }
    if (argument === "--model") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--model requires a non-empty id");
      model = value;
      index += 1;
      continue;
    }
    if (argument === "--api-key-file") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--api-key-file requires a path");
      apiKeyFile = value;
      index += 1;
      continue;
    }
    if (argument === "--alias") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--alias requires a non-empty name");
      alias = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown online option: ${argument}`);
  }
  return { providerId, model, apiKeyFile, alias, concurrency };
}

interface OnlineSummary {
  attemptedRequests: number;
  successfulJson: number;
  successfulSse: number;
  successfulFullHistory: number;
  successfulProjectionProbes: number;
  markerRetries: number;
  failures: Record<string, number>;
  latenciesMs: number[];
}

function recordFailure(summary: OnlineSummary, category: string): void {
  summary.failures[category] = (summary.failures[category] ?? 0) + 1;
}

function failureCategory(error: unknown, totalSignal: AbortSignal): string {
  if (totalSignal.aborted) return "suite_timeout";
  if (error instanceof Error) {
    const onlineCategory = /^(online_[a-z0-9_]+)(?::|$)/u.exec(error.message)?.[1];
    if (onlineCategory !== undefined) return onlineCategory;
    const safeName = error.name.replace(/[^A-Za-z0-9_-]/gu, "");
    if (safeName.length > 0 && safeName !== "Error") return safeName;
  }
  if (typeof error === "object" && error !== null) {
    if ("status" in error && typeof error.status === "number") {
      return `http_${error.status}`;
    }
  }
  return "unknown_failure";
}

function requestSignal(totalSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([totalSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

function promptFor(marker: string): string {
  return `Reply with the exact token ${marker} and no other text.`;
}

interface ResponsesOutputItem {
  readonly type: string;
  readonly text?: string;
  readonly content?: Array<{ readonly type: string; readonly text?: string }>;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly output?: unknown;
  readonly summary?: Array<{ readonly type: string; readonly text?: string }>;
  readonly luckytoken_continuity?: unknown;
}

interface ResponsesResult {
  readonly id: string;
  readonly status: string;
  readonly output: readonly ResponsesOutputItem[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly incomplete_details?: { readonly reason?: string };
}

function responsesText(result: ResponsesResult): string {
  return result.output
    .map((item) => {
      if (item.type === "message") {
        return (item.content ?? [])
          .map((part) => (part.type === "output_text" ? part.text ?? "" : ""))
          .join("");
      }
      return "";
    })
    .join("");
}

function responsesHasReasoning(result: ResponsesResult): boolean {
  return result.output.some((item) => item.type === "reasoning");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responsesReasoningReplay(input: {
  readonly result: ResponsesResult;
  readonly api: string;
}): { readonly summary: string; readonly fieldSelector?: string } {
  const { result } = input;
  const summary = result.output
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => item.summary ?? [])
    .filter((part) => part.type === "summary_text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (summary.length === 0) {
    throw new Error("online_missing_reasoning_summary");
  }
  if (input.api === "commandcode-private") return { summary };
  if (input.api !== "openai-completions") {
    throw new Error(`online_${input.api}_reasoning_shape`);
  }
  const selectors = new Set<string>();
  for (const item of result.output) {
    if (item.type !== "reasoning" || !isRecord(item.luckytoken_continuity)) {
      continue;
    }
    const attachments = item.luckytoken_continuity.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments) {
      if (
        isRecord(attachment) &&
        attachment.target === "thinking" &&
        attachment.kind === "reasoning-field-selector" &&
        (attachment.value === "reasoning_content" ||
          attachment.value === "reasoning" ||
          attachment.value === "reasoning_text")
      ) {
        selectors.add(attachment.value);
      }
    }
  }
  if (selectors.size !== 1) {
    throw new Error("online_reasoning_selector_missing");
  }
  return { summary, fieldSelector: [...selectors][0]! };
}

function validateResponsesResult(
  result: ResponsesResult,
  marker: string,
): void {
  if (result.status !== "completed" && result.status !== "incomplete") {
    throw new Error("online_terminal_status");
  }
  const text = responsesText(result);
  if (text.length === 0) throw new Error("online_empty_content");
  const foreignMarker = (text.match(/\bLT_RESP_[A-Z0-9_]+\b/gu) ?? []).find(
    (candidate) => candidate !== marker,
  );
  if (foreignMarker !== undefined) {
    throw new Error("online_cross_request_isolation");
  }
  if (!text.includes(marker)) throw new Error("online_expected_marker_missing");
}

async function postResponses(
  origin: string,
  token: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ResponsesResult> {
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status !== 200) {
    const error = await response.text();
    throw new Error(`online_http_${response.status}: ${error.slice(0, 200)}`);
  }
  return (await response.json()) as ResponsesResult;
}

interface SseFrame {
  readonly type: string;
  readonly response?: ResponsesResult;
  readonly item?: ResponsesOutputItem;
}

async function postResponsesSse(
  origin: string,
  token: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ frames: SseFrame[]; result: ResponsesResult }> {
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status !== 200) {
    const error = await response.text();
    throw new Error(`online_http_${response.status}: ${error.slice(0, 200)}`);
  }
  const text = await response.text();
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    const dataLine = block
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    const payload = dataLine.slice("data: ".length);
    if (payload === "[DONE]") continue;
    frames.push(JSON.parse(payload) as SseFrame);
  }
  const completed = frames.find((frame) => frame.type === "response.completed");
  if (completed?.response === undefined) {
    throw new Error("online_missing_sse_terminal");
  }
  return { frames, result: completed.response };
}

async function runJsonJob(
  origin: string,
  token: string,
  model: string,
  marker: string,
  totalSignal: AbortSignal,
  summary: OnlineSummary,
): Promise<void> {
  const startedAt = performance.now();
  summary.attemptedRequests += 1;
  try {
    let result: ResponsesResult | undefined;
    for (let attempt = 1; attempt <= 2 && result === undefined; attempt += 1) {
      const candidate = await postResponses(
        origin,
        token,
        {
          model: model,
          input: promptFor(marker),
          max_output_tokens: SUCCESS_MAX_TOKENS,
          reasoning: { effort: "high" },
        },
        requestSignal(totalSignal),
      );
      try {
        validateResponsesResult(candidate, marker);
        result = candidate;
      } catch (error) {
        if (
          attempt === 1 &&
          error instanceof Error &&
          error.message === "online_expected_marker_missing"
        ) {
          summary.markerRetries += 1;
          continue;
        }
        throw error;
      }
    }
    if (result === undefined) throw new Error("online_expected_marker_missing");
    if (!responsesHasReasoning(result)) {
      throw new Error("online_missing_thinking");
    }
    summary.successfulJson += 1;
    summary.latenciesMs.push(performance.now() - startedAt);
  } catch (error) {
    const category = failureCategory(error, totalSignal);
    if (category === "unknown_failure") {
      process.stderr.write(
        `[json job ${marker}] error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
    }
    recordFailure(summary, category);
  }
}

async function runSseJob(
  origin: string,
  token: string,
  model: string,
  marker: string,
  totalSignal: AbortSignal,
  summary: OnlineSummary,
): Promise<void> {
  const startedAt = performance.now();
  summary.attemptedRequests += 1;
  try {
    const { frames, result } = await postResponsesSse(
      origin,
      token,
      {
        model: model,
        input: promptFor(marker),
        max_output_tokens: SUCCESS_MAX_TOKENS,
        stream: true,
        stream_options: {
          reasoning_summary_delivery: "sequential_cutoff",
        },
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(result, marker);
    const types = frames.map((frame) => frame.type);
    if (
      types[0] !== "response.created" ||
      !types.includes("response.output_item.done") ||
      types.at(-1) !== "response.completed"
    ) {
      throw new Error("online_sse_lifecycle");
    }
    summary.successfulSse += 1;
    summary.latenciesMs.push(performance.now() - startedAt);
  } catch (error) {
    const category = failureCategory(error, totalSignal);
    if (category === "unknown_failure") {
      process.stderr.write(
        `[sse job ${marker}] error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
    }
    recordFailure(summary, category);
  }
}

interface OnlineTestJob {
  readonly kind: "json" | "sse";
  readonly marker: string;
}

function jobs(kind: OnlineTestJob["kind"], count: number): OnlineTestJob[] {
  return Array.from({ length: count }, (_unused, index) =>
    Object.freeze({
      kind,
      marker: `LT_RESP_${kind.replace("-", "_").toUpperCase()}_${String(index + 1).padStart(2, "0")}`,
    }),
  );
}

function createOnlineTestPlan(): readonly OnlineTestJob[] {
  return Object.freeze([
    ...jobs("json", 36),
    ...jobs("sse", 14),
  ]);
}

async function runPool(
  jobsToRun: readonly OnlineTestJob[],
  worker: (job: OnlineTestJob) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < jobsToRun.length) {
        const job = jobsToRun[cursor];
        cursor += 1;
        if (job !== undefined) await worker(job);
      }
    }),
  );
}

function latencySummary(values: readonly number[]): Record<string, number> {
  if (values.length === 0) return {};
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number) =>
    sorted[Math.min(Math.ceil(sorted.length * ratio) - 1, sorted.length - 1)] as number;
  return {
    minimum: Math.round(sorted[0] as number),
    p50: Math.round(percentile(0.5)),
    p95: Math.round(percentile(0.95)),
    maximum: Math.round(sorted.at(-1) as number),
  };
}

function publishOnlineReport(input: {
  readonly model: string;
  readonly concurrency: number;
  readonly summary: OnlineSummary;
}): void {
  const report = {
    model: input.model,
    concurrency: input.concurrency,
    scope: "semantic-complete-history",
    attemptedRequests: input.summary.attemptedRequests,
    successfulJson: input.summary.successfulJson,
    successfulSse: input.summary.successfulSse,
    successfulFullHistory: input.summary.successfulFullHistory,
    successfulProjectionProbes: input.summary.successfulProjectionProbes,
    markerRetries: input.summary.markerRetries,
    failures: input.summary.failures,
    latencyMs: latencySummary(input.summary.latenciesMs),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (Object.keys(input.summary.failures).length > 0) process.exitCode = 1;
}

interface CapturedUpstreamRequest {
  readonly url: string;
  readonly body: string;
  readonly signal: AbortSignal;
}

function describeCapturedExchanges(
  exchanges: readonly CapturedUpstreamRequest[],
  markers: readonly string[],
): string {
  return JSON.stringify(
    exchanges.map((exchange) => {
      let keys: readonly string[] = [];
      let model: unknown;
      try {
        const parsed = JSON.parse(exchange.body) as unknown;
        if (isRecord(parsed)) {
          keys = Object.keys(parsed).sort();
          model = parsed.model;
        }
      } catch {
        // The structural diagnostic below remains useful for non-JSON bodies.
      }
      return {
        pathname: new URL(exchange.url).pathname,
        bodyBytes: Buffer.byteLength(exchange.body),
        keys,
        ...(typeof model === "string" ? { model } : {}),
        markers: Object.fromEntries(
          markers.map((marker) => [marker, exchange.body.includes(marker)]),
        ),
      };
    }),
  );
}

function createCapturingFetch(base: FetchFunction): {
  readonly fetch: FetchFunction;
  readonly exchanges: CapturedUpstreamRequest[];
} {
  const exchanges: CapturedUpstreamRequest[] = [];
  return {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const hostname = new URL(request.url).hostname;
      if (hostname !== "127.0.0.1" && hostname !== "localhost") {
        exchanges.push({
          url: request.url,
          body: await request.clone().text(),
          signal: request.signal,
        });
      }
      return base(request);
    },
    exchanges,
  };
}

export async function runOpenAIResponsesOnlineSuite(
  args: readonly string[] = [],
): Promise<void> {
  const { providerId, model, apiKeyFile, alias, concurrency } = parseArguments(args);
  const selector = alias ?? model;
  const apiKey = (await readFile(apiKeyFile, "utf8")).trim();
  if (apiKey.length === 0) throw new Error(`${apiKeyFile} is empty`);
  const totalSignal = AbortSignal.timeout(SUITE_TIMEOUT_MS);
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-online-"));
  let server: Awaited<ReturnType<typeof startLuckyTokenHttpServer>> | undefined;
  let composition: ConfiguredLuckyTokenDataPlane | undefined;
  let restoreGlobalFetch: (() => void) | undefined;
  try {
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const responsesToken = "unused-local-sdk-key";
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v2",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
          "openai-responses": {
            stateFile: "state/openai-responses.json",
          },
        },
        providerPackages: {},
        pi: { directory: "pi" },
        limits: {
          maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
        },
      }),
      "utf8",
    );
    const config = await loadLuckyTokenCliConfig(configPath);
    // Real login first: the composition's served catalog owns the provider
    // registration, so login runs through the served Models and persists into
    // the same store the composition will use for request-time auth.
    const credentialRecordStore = createInMemoryProviderCredentialRecordStore({
      createRevision: randomUUID,
    });
    const preLogin = await createConfiguredPiModels({
      piDirectory: config.pi.directory,
      ...(config.pi.modelsJson === undefined
        ? {}
        : { modelsJsonPath: config.pi.modelsJson }),
      providerPackages: config.providerPackages,
      fetch: globalThis.fetch,
      credentialRecordStore,
    });
    try {
      await loginOnlineProvider({
        models: preLogin.models,
        providerAuthBindings: preLogin.providerAuthBindings,
        credentialManagement: preLogin.credentialManagement,
        providerId,
        authType: "api_key",
        displayName: "Online test",
        interaction: keyFileLoginInteraction(apiKey),
      });
    } catch (error) {
      throw new Error(
        `Provider login failed for ${providerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const aliasTarget = aliasTargetFor(providerId, model);
    const publicModelAuthority =
      alias === undefined
        ? undefined
        : await createOnlinePublicModelAuthority({
            path: join(stateDirectory, "public-models.json"),
            endpoint: {
              host: "127.0.0.1",
              port: config.server.port > 0 ? config.server.port : 3000,
            },
            alias,
            providerId: aliasTarget.provider,
            modelId: aliasTarget.model,
          });
    composition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentialRecordStore,
      fetch: globalThis.fetch,
      ...(publicModelAuthority === undefined ? {} : { publicModelAuthority }),
    });
    if (publicModelAuthority !== undefined) {
      await reconcileOnlinePublicModels(
        publicModelAuthority,
        composition.catalog.models,
        providerId,
      );
    }
    const resolvedProviderModel = composition.catalog.models.getModel(
      aliasTarget.provider,
      aliasTarget.model,
    );
    if (resolvedProviderModel === undefined) {
      throw new Error("online_resolved_provider_model_missing");
    }
    const providerApi = resolvedProviderModel.api;
    server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });
    const origin = server.origin;

    // Model discovery: GET /v1/models exposes the resolved model selector.
    const modelsResponse = await fetch(`${origin}/v1/models`, {
      headers: { authorization: `Bearer ${responsesToken}` },
      signal: requestSignal(totalSignal),
    });
    if (modelsResponse.status !== 200) {
      throw new Error(`online_models_status_${modelsResponse.status}`);
    }
    const modelsList = (await modelsResponse.json()) as {
      object?: string;
      data?: Array<{ id?: string; object?: string; owned_by?: string }>;
    };
    if (
      modelsList.object !== "list" ||
      !modelsList.data?.some(
        (entry) =>
          entry.id === selector &&
          entry.object === "model" &&
          entry.owned_by === providerId,
      )
    ) {
      throw new Error("online_models_discovery_missing");
    }
    const summary: OnlineSummary = {
      attemptedRequests: 0,
      successfulJson: 0,
      successfulSse: 0,
      successfulFullHistory: 0,
      successfulProjectionProbes: 0,
      markerRetries: 0,
      failures: {},
      latenciesMs: [],
    };
    const pressureJobs = createOnlineTestPlan();
    await runPool(
      pressureJobs,
      (job) => {
        switch (job.kind) {
          case "json":
            return runJsonJob(origin, responsesToken, selector, job.marker, totalSignal, summary);
          case "sse":
            return runSseJob(origin, responsesToken, selector, job.marker, totalSignal, summary);
        }
      },
      concurrency,
    );

    // ---- Conformance: capture upstream requests ----
    await server.close();
    server = undefined;
    await composition.close();
    composition = undefined;
    const originalGlobalFetch = globalThis.fetch;
    const capture = createCapturingFetch(originalGlobalFetch);
    globalThis.fetch = capture.fetch as typeof globalThis.fetch;
    restoreGlobalFetch = () => {
      if (globalThis.fetch === capture.fetch) {
        globalThis.fetch = originalGlobalFetch;
      }
    };
    composition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentialRecordStore,
      fetch: capture.fetch,
      ...(publicModelAuthority === undefined ? {} : { publicModelAuthority }),
    });
    server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });
    const conformanceOrigin = server.origin;

    // Full-history reasoning replay: unlike the incremental chain above, the
    // client sends the complete prior Responses output and no
    // previous_response_id. The final Provider request must restore the
    // visible summary at that Provider's certified reasoning attachment point.
    const fullHistoryMarker1 = "LT_RESP_FULL_HISTORY_01";
    const fullHistoryMarker2 = "LT_RESP_FULL_HISTORY_02";
    const fullHistoryTurn1 = await postResponses(
      conformanceOrigin,
      responsesToken,
      {
        model: selector,
        input: promptFor(fullHistoryMarker1),
        max_output_tokens: SUCCESS_MAX_TOKENS,
        reasoning: { effort: "high", summary: "auto" },
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(fullHistoryTurn1, fullHistoryMarker1);
    const replay = responsesReasoningReplay({
      result: fullHistoryTurn1,
      api: providerApi,
    });
    const fullHistoryTurn2 = await postResponses(
      conformanceOrigin,
      responsesToken,
      {
        model: selector,
        input: [
          ...fullHistoryTurn1.output,
          {
            type: "message",
            role: "user",
            content: promptFor(fullHistoryMarker2),
          },
        ],
        max_output_tokens: SUCCESS_MAX_TOKENS,
        reasoning: { effort: "high", summary: "auto" },
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(fullHistoryTurn2, fullHistoryMarker2);
    const fullHistoryUpstream = capture.exchanges.filter((exchange) =>
      exchange.body.includes(fullHistoryMarker2),
    );
    if (fullHistoryUpstream.length === 0) {
      throw new Error(
        `online_full_history_upstream_missing: ${describeCapturedExchanges(
          capture.exchanges,
          [fullHistoryMarker1, fullHistoryMarker2],
        )}`,
      );
    }
    const fullHistoryBody = JSON.parse(
      fullHistoryUpstream.at(-1)?.body ?? "{}",
    ) as unknown;
    const fullHistoryMessages = readOnlineProviderMessages(
      providerApi,
      fullHistoryBody,
    );
    requireOnlineReasoningReplay(
      providerApi,
      fullHistoryMessages,
      replay.summary,
      replay.fieldSelector,
    );
    summary.successfulFullHistory += 1;

    if (providerApi === "openai-completions") {
      const toolName = "online_projection_lookup";
      const toolMarker = "LT_RESP_PROJECT_TOOL_01";
      const toolRequest = {
        model: selector,
        input: `Call ${toolName} exactly once with value ${toolMarker}.`,
        max_output_tokens: SUCCESS_MAX_TOKENS,
        tools: [
          {
            type: "function",
            name: toolName,
            description: "Return the requested marker through a tool call.",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
            strict: false,
          },
        ],
        tool_choice: { type: "function", name: toolName },
        parallel_tool_calls: false,
      };
      const omitForcedToolChoice = expectsForcedToolChoiceOmission(
        providerId,
        resolvedProviderModel.id,
      );
      const toolResult = await postResponses(
        conformanceOrigin,
        responsesToken,
        toolRequest,
        requestSignal(totalSignal),
      );
      const toolExchange = capture.exchanges.findLast((exchange) =>
        exchange.body.includes(toolMarker),
      );
      if (toolExchange === undefined) {
        throw new Error("online_projection_tool_upstream_missing");
      }
      if (omitForcedToolChoice) {
        if (
          toolResult.status !== "completed" &&
          toolResult.status !== "incomplete"
        ) {
          throw new Error("online_projection_omission_behavior_missing");
        }
        requireOnlineOpenAICompletionsProjection(
          JSON.parse(toolExchange.body) as unknown,
          {
            omitToolChoice: true,
            parallelToolCalls: false,
            maxOutputTokens: SUCCESS_MAX_TOKENS,
          },
        );
      } else {
        const toolCall = toolResult.output.find(
          (item) => item.type === "function_call" && item.name === toolName,
        );
        if (
          (toolResult.status !== "completed" &&
            toolResult.status !== "incomplete") ||
          toolCall === undefined ||
          typeof toolCall.call_id !== "string" ||
          toolCall.call_id.length === 0
        ) {
          throw new Error("online_projection_tool_behavior_missing");
        }
        requireOnlineOpenAICompletionsProjection(
          JSON.parse(toolExchange.body) as unknown,
          {
            toolName,
            parallelToolCalls: false,
            maxOutputTokens: SUCCESS_MAX_TOKENS,
          },
        );
      }
      summary.successfulProjectionProbes += 1;

      const schemaName = "online_projection_answer";
      const formatMarker = "LT_RESP_PROJECT_FORMAT_01";
      const formatResult = await postResponses(
        conformanceOrigin,
        responsesToken,
        {
          model: selector,
          input: `Return a JSON object whose marker property is exactly ${formatMarker}.`,
          max_output_tokens: SUCCESS_MAX_TOKENS,
          text: {
            format: {
              type: "json_schema",
              name: schemaName,
              schema: {
                type: "object",
                properties: { marker: { type: "string" } },
                required: ["marker"],
                additionalProperties: false,
              },
              strict: true,
            },
          },
        },
        requestSignal(totalSignal),
      );
      const formatted = responsesText(formatResult);
      let parsedFormat: unknown;
      try {
        parsedFormat = JSON.parse(formatted) as unknown;
      } catch {
        throw new Error("online_projection_format_behavior_invalid");
      }
      if (!isRecord(parsedFormat) || parsedFormat.marker !== formatMarker) {
        throw new Error("online_projection_format_behavior_mismatch");
      }
      const formatExchange = capture.exchanges.findLast((exchange) =>
        exchange.body.includes(formatMarker),
      );
      if (formatExchange === undefined) {
        throw new Error("online_projection_format_upstream_missing");
      }
      requireOnlineOpenAICompletionsProjection(
        JSON.parse(formatExchange.body) as unknown,
        { schemaName, maxOutputTokens: SUCCESS_MAX_TOKENS },
      );
      summary.successfulProjectionProbes += 1;
    }

    publishOnlineReport({
      model: selector,
      concurrency,
      summary,
    });
  } finally {
    await server?.close();
    await composition?.close();
    restoreGlobalFetch?.();
    await rm(directory, { recursive: true, force: true });
  }
}

