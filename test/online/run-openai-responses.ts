/**
 * Online OpenAI Responses suite.
 *
 * Drives the REAL CommandCode provider through the local LuckyToken
 * `/v1/responses` endpoint with genuine Codex-style incremental requests:
 * `previous_response_id` chaining, durable snapshot recovery across a
 * simulated process restart, atomic SSE, tool round-trips, auth isolation,
 * cancellation, and concurrent isolation.
 *
 * Reads the API key file (git-ignored) into memory only. Defaults to the
 * CommandCode provider (`CommandcodeAPIKey.txt`); pass `--provider
 * opencode-go --api-key-file <path> --model deepseek-v4-flash` to certify
 * the built-in OpenCode Go provider through the same Responses client
 * protocol and LuckyToken stack.
 */
import {
  InMemoryCredentialStore,
  type AuthInteraction,
  type AuthPrompt,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import type { AliasCatalogFacts } from "../../src/aliases/authority.js";
import { createAliasRegistryAuthority } from "../../src/aliases/authority.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import {
  createConfiguredLuckyTokenComposition,
  createConfiguredPiModels,
} from "../../src/composition.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";

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
  successfulChain: number;
  successfulRestartRecovery: number;
  confirmedCancellations: number;
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
}

interface ResponsesResult {
  readonly id: string;
  readonly status: string;
  readonly previous_response_id?: string;
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

function validateResponsesResult(
  result: ResponsesResult,
  marker: string,
): void {
  if (result.status !== "completed" && result.status !== "incomplete") {
    throw new Error("online_terminal_status");
  }
  const text = responsesText(result);
  if (text.length === 0) throw new Error("online_empty_content");
  if (!text.includes(marker)) throw new Error("online_request_isolation");
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

interface DispatchProbe {
  readonly dispatched: Promise<void>;
  readonly aborted: Promise<void>;
}

interface MutableDispatchProbe extends DispatchProbe {
  markDispatched(): void;
  markAborted(): void;
}

function createDispatchObserver(upstream: FetchFunction): {
  readonly fetch: FetchFunction;
  forSession(sessionId: string): DispatchProbe;
} {
  const probes = new Map<string, MutableDispatchProbe>();
  const mutableProbe = (sessionId: string): MutableDispatchProbe => {
    const existing = probes.get(sessionId);
    if (existing !== undefined) return existing;
    let markDispatched: (() => void) | undefined;
    let markAborted: (() => void) | undefined;
    const dispatched = new Promise<void>((resolvePromise) => {
      markDispatched = resolvePromise;
    });
    const aborted = new Promise<void>((resolvePromise) => {
      markAborted = resolvePromise;
    });
    const probe: MutableDispatchProbe = {
      dispatched,
      aborted,
      markDispatched: () => markDispatched?.(),
      markAborted: () => markAborted?.(),
    };
    probes.set(sessionId, probe);
    return probe;
  };
  const fetch: FetchFunction = async (input, init) => {
    // Do NOT rebuild the Request: `new Request(input, {signal})` creates a
    // fresh AbortSignal that does not reliably follow the provider's signal
    // in Node. Read the signal from the original input/init directly.
    const signal =
      input instanceof Request ? input.signal : init?.signal;
    const request = input instanceof Request ? input : new Request(input as RequestInfo, init);
    const sessionId = request.headers.get("x-session-id");
    if (sessionId === null) throw new Error("online_missing_upstream_session");
    const probe = mutableProbe(sessionId);
    probe.markDispatched();
    const markAborted = () => probe.markAborted();
    signal?.addEventListener("abort", markAborted, { once: true });
    try {
      return await upstream(request);
    } finally {
      signal?.removeEventListener("abort", markAborted);
      if (signal?.aborted === true) probe.markAborted();
    }
  };
  return { fetch, forSession: (sessionId) => mutableProbe(sessionId) };
}

/**
 * Wrap a fetch so each request hangs (until aborted or timeout) before
 * forwarding. Gives cancellation tests a reliable window to abort upstream.
 */
function createHangingFetch(
  upstream: FetchFunction,
  hangMs: number,
): FetchFunction {
  return async (input, init) => {
    const signal =
      input instanceof Request ? input.signal : init?.signal;
    const request =
      input instanceof Request ? input : new Request(input as RequestInfo, init);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeoutId = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolvePromise();
      }, hangMs);
      const onAbort = (): void => {
        clearTimeout(timeoutId);
        rejectPromise(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted === true) {
        clearTimeout(timeoutId);
        rejectPromise(signal.reason ?? new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return upstream(request);
  };
}

function isAbortFailure(error: unknown, reason: unknown): boolean {
  if (error === reason) return true;
  if (!(error instanceof Error)) return false;
  return /abort|cancel/iu.test(`${error.name} ${error.message}`);
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
    const result = await postResponses(
      origin,
      token,
      {
        model: model,
        input: promptFor(marker),
        max_output_tokens: SUCCESS_MAX_TOKENS,
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(result, marker);
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

async function runCancellationJob(
  cancellationOrigin: string,
  recoveryOrigin: string,
  token: string,
  model: string,
  marker: string,
  totalSignal: AbortSignal,
  summary: OnlineSummary,
): Promise<void> {
  const controller = new AbortController();
  const cancellationReason = new Error("authorized online cancellation");
  // Client-side abort: cancel the request after a short delay. The abort
  // propagates into LuckyToken and upstream; we verify the client sees the
  // cancellation and the server stays healthy for the recovery turn.
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(cancellationReason);
  }, 300);
  const cancellationSignal = AbortSignal.any([
    controller.signal,
    requestSignal(totalSignal),
  ]);
  summary.attemptedRequests += 1;
  const pendingOutcome = postResponses(
    cancellationOrigin,
    token,
    {
      model: model,
      input: promptFor(`${marker}_CANCEL`),
      max_output_tokens: 4_096,
    },
    cancellationSignal,
  ).then(
    (result) => ({ status: "fulfilled" as const, result }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  try {
    const outcome = await pendingOutcome;
    clearTimeout(timer);
    if (outcome.status === "fulfilled") {
      recordFailure(summary, "cancellation_completed_as_success");
    } else if (isAbortFailure(outcome.error, cancellationReason)) {
      summary.confirmedCancellations += 1;
    } else {
      recordFailure(summary, failureCategory(outcome.error, totalSignal));
    }
  } catch (error) {
    clearTimeout(timer);
    controller.abort(cancellationReason);
    await pendingOutcome;
    recordFailure(summary, failureCategory(error, totalSignal));
  }

  const recoveryStartedAt = performance.now();
  summary.attemptedRequests += 1;
  try {
    const recoveryMarker = `${marker}_RECOVERY`;
    let result: ResponsesResult | undefined;
    for (let attempt = 1; attempt <= 2 && result === undefined; attempt += 1) {
      try {
        const candidate = await postResponses(
          recoveryOrigin,
          token,
          {
            model: model,
            input: promptFor(recoveryMarker),
            max_output_tokens: SUCCESS_MAX_TOKENS,
          },
          requestSignal(totalSignal),
        );
        validateResponsesResult(candidate, recoveryMarker);
        result = candidate;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    if (result === undefined) {
      throw new Error("online_recovery_retries_exhausted");
    }
    summary.latenciesMs.push(performance.now() - recoveryStartedAt);
  } catch (error) {
    const category = `recovery_${failureCategory(error, totalSignal)}`;
    process.stderr.write(
      `[recovery job ${marker}] error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    recordFailure(summary, category);
  }
}

interface OnlineTestJob {
  readonly kind: "json" | "sse" | "cancel-recovery";
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
    ...jobs("cancel-recovery", 5),
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

interface CapturedUpstreamRequest {
  readonly url: string;
  readonly body: string;
  readonly signal: AbortSignal;
}

function createCapturingFetch(base: FetchFunction): {
  readonly fetch: FetchFunction;
  readonly exchanges: CapturedUpstreamRequest[];
} {
  const exchanges: CapturedUpstreamRequest[] = [];
  return {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      exchanges.push({
        url: request.url,
        body: await request.clone().text(),
        signal: request.signal,
      });
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
  try {
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const responsesAuthFile = join(
      stateDirectory,
      "client-auth",
      "openai-responses.json",
    );
    const anthropicAuthFile = join(
      stateDirectory,
      "client-auth",
      "anthropic-messages.json",
    );
    const responsesToken = randomUUID();
    const anthropicToken = randomUUID();
    await createFileClientTokenStore({
      path: responsesAuthFile,
    }).create({ type: "global" }, responsesToken);
    await createFileClientTokenStore({
      path: anthropicAuthFile,
    }).create({ type: "global" }, anthropicToken);
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { host: "127.0.0.1", port: 0 },
        clientProtocols: {
          "anthropic-messages": {
            authFile: "client-auth/anthropic-messages.json",
          },
          "openai-responses": {
            authFile: "client-auth/openai-responses.json",
            stateFile: "state/openai-responses.json",
          },
        },
        providerPackages:
          providerId === "commandcode-private"
            ? { "@luckytoken/provider-commandcode-private": {} }
            : {},
        pi: { directory: "pi" },
        limits: {
          maxRequestBytes: 1_048_576,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
        },
      }),
      "utf8",
    );
    const config = await loadLuckyTokenCliConfig(configPath);
    const dispatchObserver = createDispatchObserver(globalThis.fetch);
    // Real login first: the composition's served catalog owns the provider
    // registration, so login runs through the served Models and persists into
    // the same store the composition will use for request-time auth.
    const credentials = new InMemoryCredentialStore();
    const preLogin = await createConfiguredPiModels({
      piDirectory: config.pi.directory,
      ...(config.pi.modelsJson === undefined
        ? {}
        : { modelsJsonPath: config.pi.modelsJson }),
      providerPackages: config.providerPackages,
      fetch: globalThis.fetch,
      credentials,
    });
    try {
      await preLogin.models.login(
        providerId,
        "api_key",
        keyFileLoginInteraction(apiKey),
      );
    } catch (error) {
      throw new Error(
        `Provider login failed for ${providerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const stored = await credentials.read(providerId);
    if (stored?.type !== "api_key" || stored.key !== apiKey) {
      throw new Error(`Provider login did not persist a credential for ${providerId}`);
    }
    // Alias-only data plane (Ticket 15): a built-in Provider target is
    // selected through its alias; the authority validates against the live
    // served catalog once the first composition exists.
    let catalogFacts: AliasCatalogFacts = Object.freeze({
      catalogVersion: 0,
      knownTargets: Object.freeze(new Set<string>()),
    });
    const aliasAuthority =
      alias === undefined
        ? undefined
        : createAliasRegistryAuthority({
            path: join(stateDirectory, "model-aliases.json"),
            catalogFacts: () => catalogFacts,
          });
    if (alias !== undefined) {
      await writeFile(
        join(stateDirectory, "model-aliases.json"),
        `${JSON.stringify(
          { aliases: { [alias]: aliasTargetFor(providerId, model) } },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    const composition = await createConfiguredLuckyTokenComposition({
      config,
      credentials,
      fetch: dispatchObserver.fetch,
      ...(aliasAuthority === undefined ? {} : { aliasAuthority }),
    });
    if (alias !== undefined) {
      const models = composition.catalog.models.getModels();
      const knownTargets = new Set<string>();
      for (const candidate of models) {
        knownTargets.add(`${candidate.provider}\u0000${candidate.id}`);
      }
      catalogFacts = Object.freeze({ catalogVersion: 1, knownTargets });
      await aliasAuthority!.query();
    }
    server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: config.server.host,
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
      successfulChain: 0,
      successfulRestartRecovery: 0,
      confirmedCancellations: 0,
      failures: {},
      latenciesMs: [],
    };
    // Cancellation needs a hanging upstream so the abort lands mid-flight.
    const hangingFetch = createHangingFetch(globalThis.fetch, 60_000);
    const hangingComposition = await createConfiguredLuckyTokenComposition({
      config,
      credentials,
      fetch: hangingFetch,
      ...(aliasAuthority === undefined ? {} : { aliasAuthority }),
    });
    const hangingServer = await startLuckyTokenHttpServer({
      runtime: hangingComposition.runtime,
      host: config.server.host,
      port: config.server.port,
    });
    const hangingOrigin = hangingServer.origin;
    const cancellationJobs = createOnlineTestPlan().filter(
      (job) => job.kind === "cancel-recovery",
    );
    await runPool(
      cancellationJobs,
      (job) =>
        runCancellationJob(
          hangingOrigin,
          origin,
          responsesToken,
          selector,
          job.marker,
          totalSignal,
          summary,
        ),
      concurrency,
    );
    await hangingServer.close();

    const pressureJobs = createOnlineTestPlan().filter(
      (job) => job.kind !== "cancel-recovery",
    );
    await runPool(
      pressureJobs,
      (job) => {
        switch (job.kind) {
          case "json":
            return runJsonJob(origin, responsesToken, selector, job.marker, totalSignal, summary);
          case "sse":
            return runSseJob(origin, responsesToken, selector, job.marker, totalSignal, summary);
          case "cancel-recovery":
            return Promise.resolve();
        }
      },
      concurrency,
    );

    // ---- Conformance: capture upstream requests ----
    const capture = createCapturingFetch(globalThis.fetch);
    const conformanceComposition = await createConfiguredLuckyTokenComposition({
      config,
      credentials,
      fetch: capture.fetch,
      ...(aliasAuthority === undefined ? {} : { aliasAuthority }),
    });
    await server.close();
    server = await startLuckyTokenHttpServer({
      runtime: conformanceComposition.runtime,
      host: config.server.host,
      port: config.server.port,
    });
    const conformanceOrigin = server.origin;

    // Incremental chain: turn 1 then turn 2 with previous_response_id.
    const chainMarker1 = "LT_RESP_CHAIN_01";
    const chainMarker2 = "LT_RESP_CHAIN_02";
    const turn1 = await postResponses(
      conformanceOrigin,
      responsesToken,
      {
        model: selector,
        input: promptFor(chainMarker1),
        max_output_tokens: SUCCESS_MAX_TOKENS,
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(turn1, chainMarker1);
    const turn2 = await postResponses(
      conformanceOrigin,
      responsesToken,
      {
        model: selector,
        input: promptFor(chainMarker2),
        previous_response_id: turn1.id,
        max_output_tokens: SUCCESS_MAX_TOKENS,
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(turn2, chainMarker2);
    if (turn2.previous_response_id !== turn1.id) {
      throw new Error("online_chain_echo_missing");
    }
    const chainUpstream = capture.exchanges.filter((exchange) =>
      exchange.body.includes(chainMarker2),
    );
    if (chainUpstream.length === 0) {
      throw new Error("online_chain_upstream_missing");
    }
    const chainBody = JSON.parse(chainUpstream[0]?.body ?? "{}") as {
      params?: { messages?: Array<{ role: string }> };
    };
    const chainRoles = chainBody.params?.messages?.map((entry) => entry.role) ?? [];
    if (
      !chainRoles.includes("assistant") ||
      !JSON.stringify(chainBody).includes(chainMarker1)
    ) {
      throw new Error("online_chain_expansion_missing");
    }
    summary.successfulChain += 1;

    // Auth isolation: the Anthropic token must be rejected on /v1/responses.
    const authProbe = await fetch(`${conformanceOrigin}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${anthropicToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: selector,
        input: "auth isolation probe",
      }),
      signal: requestSignal(totalSignal),
    });
    if (authProbe.status !== 401) {
      throw new Error(`online_auth_isolation_${authProbe.status}`);
    }

    // Tool round-trip: provider emits a function_call; we reply with a
    // function_call_output and verify the model consumes it.
    const toolMarker = "LT_RESP_TOOL_01";
    const toolResultMarker = "LT_RESP_TOOL_RESULT_01";
    let toolTurn: ResponsesResult | undefined;
    let toolCall: ResponsesOutputItem | undefined;
    for (let attempt = 1; attempt <= 3 && toolCall === undefined; attempt += 1) {
      const probe = await postResponses(
        conformanceOrigin,
        responsesToken,
        {
          model: selector,
          input: `Call online_lookup exactly once with value ${toolMarker}_${attempt}. Do not answer in text.`,
          max_output_tokens: SUCCESS_MAX_TOKENS,
          tools: [
            {
              type: "function",
              name: "online_lookup",
              description:
                "Call this tool when explicitly requested. Return the exact marker in value.",
              parameters: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        },
        requestSignal(totalSignal),
      );
      toolTurn = probe;
      toolCall = probe.output.find((item) => item.type === "function_call");
    }
    if (toolTurn === undefined || toolCall === undefined) {
      throw new Error("online_provider_tool_call_not_observed");
    }
    const callId = toolCall.call_id;
    if (callId === undefined || callId.length === 0) {
      throw new Error("online_tool_call_identity");
    }
    const toolResultTurn = await postResponses(
      conformanceOrigin,
      responsesToken,
      {
        model: selector,
        input: [
          {
            type: "function_call_output",
            call_id: callId,
            output: `result for ${toolResultMarker}`,
          },
          {
            type: "message",
            role: "user",
            content: `Reply with exactly ${toolResultMarker}.`,
          },
        ],
        previous_response_id: toolTurn.id,
        max_output_tokens: SUCCESS_MAX_TOKENS,
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(toolResultTurn, toolResultMarker);
    const toolResultUpstream = capture.exchanges.filter((exchange) =>
      exchange.body.includes(callId),
    );
    if (
      toolResultUpstream.length === 0 ||
      !JSON.stringify(toolResultUpstream.at(-1)?.body).includes(
        `result for ${toolResultMarker}`,
      )
    ) {
      throw new Error("online_tool_result_round_trip");
    }

    // The default `honor` policy obeys store:false: the response remains
    // usable for the current call, but its id cannot seed a later chain.
    const storeFalseTurn = await postResponses(
      conformanceOrigin,
      responsesToken,
      {
        model: selector,
        input: promptFor("LT_RESP_STORE_FALSE"),
        store: false,
        max_output_tokens: SUCCESS_MAX_TOKENS,
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(storeFalseTurn, "LT_RESP_STORE_FALSE");
    const dispatchedBeforeStoreFalseFollowUp = capture.exchanges.length;
    const storeFalseFollowUp = await fetch(`${conformanceOrigin}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${responsesToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: selector,
        input: promptFor("LT_RESP_STORE_FALSE_NEXT"),
        previous_response_id: storeFalseTurn.id,
        max_output_tokens: SUCCESS_MAX_TOKENS,
      }),
      signal: requestSignal(totalSignal),
    });
    const storeFalseError = (await storeFalseFollowUp.json()) as {
      error?: { type?: string; message?: string };
    };
    if (
      storeFalseFollowUp.status !== 400 ||
      storeFalseError.error?.type !== "invalid_request_error" ||
      !storeFalseError.error.message?.includes("not a known local response")
    ) {
      throw new Error("online_store_false_was_saved");
    }
    if (capture.exchanges.length !== dispatchedBeforeStoreFalseFollowUp) {
      throw new Error("online_store_false_follow_up_dispatched");
    }

    // Restart recovery: close server, create a fresh composition on the SAME
    // state file, and reference turn1's response id.
    await server.close();
    server = undefined;
    const restartComposition = await createConfiguredLuckyTokenComposition({
      config,
      credentials,
      fetch: dispatchObserver.fetch,
      ...(aliasAuthority === undefined ? {} : { aliasAuthority }),
    });
    server = await startLuckyTokenHttpServer({
      runtime: restartComposition.runtime,
      host: config.server.host,
      port: config.server.port,
    });
    const restartMarker = "LT_RESP_RESTART_01";
    const restartResult = await postResponses(
      server.origin,
      responsesToken,
      {
        model: selector,
        input: promptFor(restartMarker),
        previous_response_id: turn1.id,
        max_output_tokens: SUCCESS_MAX_TOKENS,
      },
      requestSignal(totalSignal),
    );
    validateResponsesResult(restartResult, restartMarker);
    if (restartResult.previous_response_id !== turn1.id) {
      throw new Error("online_restart_chain_echo_missing");
    }
    summary.successfulRestartRecovery += 1;

    const report = {
      model: selector,
      concurrency,
      attemptedRequests: summary.attemptedRequests,
      successfulJson: summary.successfulJson,
      successfulSse: summary.successfulSse,
      successfulChain: summary.successfulChain,
      successfulRestartRecovery: summary.successfulRestartRecovery,
      confirmedCancellations: summary.confirmedCancellations,
      failures: summary.failures,
      latencyMs: latencySummary(summary.latenciesMs),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (Object.keys(summary.failures).length > 0) process.exitCode = 1;
  } finally {
    await server?.close();
    // A SQLite store may need a moment to release its handle after the
    // server closes; EBUSY here is a cleanup race, never a protocol failure.
    await new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, 500),
    );
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runOpenAIResponsesOnlineSuite(process.argv.slice(2)).catch((error: unknown) => {
    const category = failureCategory(error, new AbortController().signal);
    const detail =
      error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`Online suite failed: ${category}\n${detail}\n`);
    process.exitCode = 1;
  });
}


