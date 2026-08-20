import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import {
  InMemoryCredentialStore,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredLuckyTokenDataPlane } from "../../src/composition.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";
import {
  createCapturingCommandCodeFetch,
  runOnlineConformance,
  writeOnlineConformanceArtifact,
} from "./conformance.js";
import { createOnlineTestPlan, type OnlineTestJob } from "./plan.js";

const DEFAULT_MODEL = "commandcode-private/deepseek/deepseek-v4-flash";
const DEFAULT_CONCURRENCY = 5;
const SUCCESS_MAX_TOKENS = 512;
const REQUEST_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SAMPLES_PATH =
  ".online-artifacts/commandcode-conformance-samples.json";

interface OnlineArguments {
  readonly modelId: string;
  readonly samplesPath: string;
}

interface OnlineSummary {
  attemptedRequests: number;
  successfulJson: number;
  successfulSse: number;
  successfulRecoveries: number;
  confirmedCancellations: number;
  failures: Record<string, number>;
  latenciesMs: number[];
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
    const request = new Request(input, init);
    const sessionId = request.headers.get("x-session-id");
    if (sessionId === null) throw new Error("online_missing_upstream_session");
    const probe = mutableProbe(sessionId);
    probe.markDispatched();
    const markAborted = () => probe.markAborted();
    request.signal.addEventListener("abort", markAborted, { once: true });
    try {
      return await upstream(request);
    } finally {
      request.signal.removeEventListener("abort", markAborted);
      if (request.signal.aborted) probe.markAborted();
    }
  };
  return {
    fetch,
    forSession: (sessionId) => mutableProbe(sessionId),
  };
}

async function waitForProbe(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function isAbortFailure(error: unknown, reason: unknown): boolean {
  if (error === reason) return true;
  if (!(error instanceof Error)) return false;
  return /abort|cancel/iu.test(`${error.name} ${error.message}`);
}

function parseArguments(args: readonly string[]): OnlineArguments {
  let modelId = DEFAULT_MODEL;
  let samplesPath = DEFAULT_SAMPLES_PATH;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--model" && argument !== "--samples") {
      throw new Error(`Unknown online option: ${argument}`);
    }
    const value = args[index + 1]?.trim();
    if (!value) throw new Error(`${argument} requires a non-empty value`);
    if (argument === "--model") modelId = value;
    else samplesPath = value;
    index += 1;
  }
  return { modelId, samplesPath };
}

function requestSignal(totalSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([totalSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

function promptFor(marker: string): string {
  return `Reply with the exact token ${marker} and no other text.`;
}

function validateMessage(message: Message, modelId: string, marker: string): void {
  if (message.model !== modelId) throw new Error("online_model_identity");
  if (message.stop_reason !== "end_turn" && message.stop_reason !== "max_tokens") {
    throw new Error("online_terminal_status");
  }
  if (
    message.content.length === 0 ||
    message.content.some(
      (block) => block.type !== "text" && block.type !== "thinking",
    )
  ) {
    throw new Error("online_unsupported_content");
  }
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  if (text.length === 0) throw new Error("online_empty_content");
  if (!text.includes(marker)) throw new Error("online_request_isolation");
}

function failureCategory(error: unknown, totalSignal: AbortSignal): string {
  if (totalSignal.aborted) return "suite_timeout";
  if (
    error instanceof Error &&
    /^online_[a-z0-9_]+$/u.test(error.message)
  ) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    if ("status" in error && typeof error.status === "number") {
      return `http_${error.status}`;
    }
    if ("name" in error && typeof error.name === "string") {
      const safeName = error.name.replace(/[^A-Za-z0-9_-]/gu, "");
      if (safeName.length > 0) return safeName;
    }
  }
  return "unknown_failure";
}

function recordFailure(summary: OnlineSummary, category: string): void {
  summary.failures[category] = (summary.failures[category] ?? 0) + 1;
}

async function createJsonMessage(
  client: Anthropic,
  modelId: string,
  marker: string,
  signal: AbortSignal,
  maxTokens = SUCCESS_MAX_TOKENS,
  sessionId?: string,
): Promise<Message> {
  return client.messages.create(
    {
      model: modelId,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: promptFor(marker) }],
    },
    {
      signal,
      ...(sessionId === undefined
        ? {}
        : { headers: { "x-session-id": sessionId } }),
    },
  );
}

async function runJsonJob(
  client: Anthropic,
  modelId: string,
  job: Extract<OnlineTestJob, { kind: "json" }>,
  totalSignal: AbortSignal,
  summary: OnlineSummary,
): Promise<void> {
  const startedAt = performance.now();
  summary.attemptedRequests += 1;
  try {
    const message = await createJsonMessage(
      client,
      modelId,
      job.marker,
      requestSignal(totalSignal),
    );
    validateMessage(message, modelId, job.marker);
    summary.successfulJson += 1;
    summary.latenciesMs.push(performance.now() - startedAt);
  } catch (error) {
    recordFailure(summary, failureCategory(error, totalSignal));
  }
}

async function runSseJob(
  client: Anthropic,
  modelId: string,
  job: Extract<OnlineTestJob, { kind: "sse" }>,
  totalSignal: AbortSignal,
  summary: OnlineSummary,
): Promise<void> {
  const startedAt = performance.now();
  summary.attemptedRequests += 1;
  try {
    const stream = client.messages.stream(
      {
        model: modelId,
        max_tokens: SUCCESS_MAX_TOKENS,
        messages: [{ role: "user", content: promptFor(job.marker) }],
      },
      { signal: requestSignal(totalSignal) },
    );
    const message = await stream.finalMessage();
    validateMessage(message, modelId, job.marker);
    summary.successfulSse += 1;
    summary.latenciesMs.push(performance.now() - startedAt);
  } catch (error) {
    recordFailure(summary, failureCategory(error, totalSignal));
  }
}

async function runCancellationJob(
  client: Anthropic,
  modelId: string,
  job: Extract<OnlineTestJob, { kind: "cancel-recovery" }>,
  totalSignal: AbortSignal,
  summary: OnlineSummary,
  dispatchObserver: ReturnType<typeof createDispatchObserver>,
): Promise<void> {
  const controller = new AbortController();
  const cancellationSignal = AbortSignal.any([
    controller.signal,
    requestSignal(totalSignal),
  ]);
  const sessionId = randomUUID();
  const probe = dispatchObserver.forSession(sessionId);
  const cancellationReason = new Error("authorized online cancellation");
  summary.attemptedRequests += 1;
  const pendingOutcome = createJsonMessage(
    client,
    modelId,
    `${job.marker}_CANCEL`,
    cancellationSignal,
    4_096,
    sessionId,
  ).then(
    (message) => ({ status: "fulfilled" as const, message }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  try {
    await waitForProbe(probe.dispatched, requestSignal(totalSignal));
    controller.abort(cancellationReason);
    await waitForProbe(probe.aborted, requestSignal(totalSignal));
    const outcome = await pendingOutcome;
    if (outcome.status === "fulfilled") {
      recordFailure(summary, "cancellation_completed_as_success");
    } else if (isAbortFailure(outcome.error, cancellationReason)) {
      summary.confirmedCancellations += 1;
    } else {
      recordFailure(summary, failureCategory(outcome.error, totalSignal));
    }
  } catch (error) {
    controller.abort(cancellationReason);
    await pendingOutcome;
    recordFailure(summary, failureCategory(error, totalSignal));
  }

  const recoveryStartedAt = performance.now();
  summary.attemptedRequests += 1;
  try {
    const recoveryMarker = `${job.marker}_RECOVERY`;
    const message = await createJsonMessage(
      client,
      modelId,
      recoveryMarker,
      requestSignal(totalSignal),
      SUCCESS_MAX_TOKENS,
      sessionId,
    );
    validateMessage(message, modelId, recoveryMarker);
    summary.successfulRecoveries += 1;
    summary.latenciesMs.push(performance.now() - recoveryStartedAt);
  } catch (error) {
    recordFailure(summary, `recovery_${failureCategory(error, totalSignal)}`);
  }
}

async function runJob(
  client: Anthropic,
  modelId: string,
  job: OnlineTestJob,
  totalSignal: AbortSignal,
  summary: OnlineSummary,
  dispatchObserver: ReturnType<typeof createDispatchObserver>,
): Promise<void> {
  switch (job.kind) {
    case "json":
      await runJsonJob(client, modelId, job, totalSignal, summary);
      return;
    case "sse":
      await runSseJob(client, modelId, job, totalSignal, summary);
      return;
    case "cancel-recovery":
      await runCancellationJob(
        client,
        modelId,
        job,
        totalSignal,
        summary,
        dispatchObserver,
      );
  }
}

async function runPool(
  jobs: readonly OnlineTestJob[],
  worker: (job: OnlineTestJob) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: DEFAULT_CONCURRENCY }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor];
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

export async function runCommandCodeOnlineSuite(
  args: readonly string[],
): Promise<void> {
  const { modelId, samplesPath } = parseArguments(args);
  const apiKey = (await readFile("CommandcodeAPIKey.txt", "utf8")).trim();
  if (apiKey.length === 0) throw new Error("CommandCode API key file is empty");
  const totalSignal = AbortSignal.timeout(SUITE_TIMEOUT_MS);
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-online-"));
  let server: Awaited<ReturnType<typeof startLuckyTokenHttpServer>> | undefined;
  try {
    const stateDirectory = join(directory, ".luckytoken");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const localSdkCredential = "unused-local-sdk-key";
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "luckytoken-config-v1",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
        },
        providerPackages: {
          "@luckytoken/provider-commandcode-private": {},
        },
        pi: { directory: "pi" },
        limits: {
          maxRequestBytes: 1_048_576,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
        },
      }),
      "utf8",
    );
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(
      "commandcode-private",
      async () => ({ type: "api_key", key: apiKey }),
    );
    const config = await loadLuckyTokenCliConfig(configPath);
    const dispatchObserver = createDispatchObserver(globalThis.fetch);
    const composition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentials,
      fetch: dispatchObserver.fetch,
    });
    server = await startLuckyTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });
    const client = new Anthropic({
      apiKey: localSdkCredential,
      baseURL: server.origin,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const summary: OnlineSummary = {
      attemptedRequests: 0,
      successfulJson: 0,
      successfulSse: 0,
      successfulRecoveries: 0,
      confirmedCancellations: 0,
      failures: {},
      latenciesMs: [],
    };
    await runPool(createOnlineTestPlan(), (job) =>
      runJob(client, modelId, job, totalSignal, summary, dispatchObserver),
    );
    await server.close();
    server = undefined;

    const capture = createCapturingCommandCodeFetch(globalThis.fetch);
    const conformanceComposition = await createConfiguredLuckyTokenDataPlane({
      config,
      credentials,
      fetch: capture.fetch,
    });
    server = await startLuckyTokenHttpServer({
      runtime: conformanceComposition.runtime,
      host: "127.0.0.1",
      port: config.server.port,
    });
    const conformanceClient = new Anthropic({
      apiKey: localSdkCredential,
      baseURL: server.origin,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const conformanceCases = await runOnlineConformance(
      conformanceClient,
      modelId,
      totalSignal,
      capture.exchanges,
    );
    const writtenSamplesPath = await writeOnlineConformanceArtifact(
      samplesPath,
      modelId,
      conformanceCases,
      [apiKey],
    );
    const report = {
      model: modelId,
      concurrency: DEFAULT_CONCURRENCY,
      attemptedRequests: summary.attemptedRequests,
      successfulJson: summary.successfulJson,
      successfulSse: summary.successfulSse,
      successfulRecoveries: summary.successfulRecoveries,
      confirmedCancellations: summary.confirmedCancellations,
      conformanceCases: conformanceCases.length,
      conformanceProviderRequests: capture.exchanges.length,
      samplesPath: writtenSamplesPath,
      failures: summary.failures,
      latencyMs: latencySummary(summary.latenciesMs),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (Object.keys(summary.failures).length > 0) process.exitCode = 1;
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runCommandCodeOnlineSuite(process.argv.slice(2)).catch((error: unknown) => {
    const category = failureCategory(error, new AbortController().signal);
    process.stderr.write(`Online suite failed: ${category}\n`);
    process.exitCode = 1;
  });
}
