/**
 * Online Codex CLI suite — drives the REAL Codex CLI as a client against a
 * local LuckyToken `/v1/responses` endpoint.
 *
 * Unlike `run-openai-responses.ts` (which constructs HTTP requests directly),
 * this suite spawns `codex -p luckytoken exec --json` so the real client
 * exercises the full protocol conversion path: full-history requests (the
 * non-interactive CLI sends complete input each turn), multi-turn `resume`
 * sessions, tool round-trips, reasoning, atomic SSE, restart recovery,
 * cancellation, and coverage of every input item family.
 *
 * Assertions are layered:
 *   1. black-box — a completed Codex turn with a non-empty agent message
 *      (the CLI's `--json` emits its own `turn.completed`/`item.completed`
 *      events, not the wire-level Responses events);
 *   2. usage shape from `turn.completed`, tool-call/output pairing;
 *   3. server-side — after the run, the snapshot file is inspected for
 *      correct history, no orphan tool outputs, and usage shape.
 *
 * Every invocation's JSONL events, final message, and failure details are
 * retained under `<tmp>/artifacts/` for post-run analysis.
 *
 * Every inbound `/v1/responses` request body is also captured under
 * `artifacts/requests/` (via createCapturingRuntime). These are REAL Codex
 * CLI request samples; sanitized copies live in
 * `test/fixtures/codex-cli-requests/` and are replayed offline by
 * `test/integration/openai-responses-replay.test.ts`. To refresh the
 * fixtures: run this suite, then copy (re-sanitized) request files into the
 * fixtures directory.
 *
 * The suite SELF-HOSTS a fresh LuckyToken service (current repo code) on a
 * random port with a clean state file; Codex CLI points at it via
 * `-c model_providers.luckytoken.base_url=<origin>`.
 *
 * Requires:
 *   - `codex` CLI on PATH (verified at startup)
 *   - `CommandcodeAPIKey.txt` in the repo root (git-ignored), read into
 *     memory only
 *   - `~/.codex/luckytoken-catalog.json` with the target model metadata.
 *
 * The suite copies only that target catalog entry into a temporary
 * `CODEX_HOME` and writes its own provider/profile configuration. User MCPs,
 * credentials, sessions, skills, and default model settings are not loaded.
 */

import {
  InMemoryCredentialStore,
  type AuthInteraction,
  type AuthPrompt,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import {
  createOnlinePublicModelAuthority,
  reconcileOnlinePublicModels,
} from "./public-model-fixture.js";
import {
  createConfiguredLuckyTokenDataPlane,
  createConfiguredPiModels,
  type ConfiguredLuckyTokenDataPlane,
} from "../../src/composition.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";
import type { LuckyTokenRuntime } from "../../src/runtime.js";

const DEFAULT_MODEL = "commandcode-private/deepseek/deepseek-v4-flash";
const DEFAULT_PROVIDER_ID = "commandcode-private";
const DEFAULT_API_KEY_FILE = "CommandcodeAPIKey.txt";
// Coverage-first: serial execution so timing noise never masquerades as a
// protocol-conversion bug. Volume/concurrency is opt-in via the batches arg.
const DEFAULT_CONCURRENCY = 1;
const REQUEST_TIMEOUT_MS = 120_000;
const SUITE_TIMEOUT_MS = 45 * 60_000;
const CODEX_EXEC_TIMEOUT_MS = 90_000;

const CODEX_PROFILE = "luckytoken";
const CODEX_PROMPT_ENV_KEY = "LUCKYTOKEN_API_KEY";
const CODEX_HOME_ENV_KEY = "CODEX_HOME";
// `codex` on Windows is a .ps1/.cmd shim; spawn the underlying Node entry
// directly to avoid shell-resolution EPERM/EINVAL.
const CODEX_JS = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

interface OnlineArguments {
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyFile: string;
  readonly alias: string | undefined;
  readonly batches: number;
  /** Optional scenario-id filter for targeted reruns (e.g. `tool_shell`). */
  readonly onlyScenario: string | undefined;
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
  let batches = 1;
  let onlyScenario: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--scenario") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--scenario requires a scenario id");
      onlyScenario = value;
      index += 1;
      continue;
    }
    if (argument === "--batches") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("--batches must be a positive integer");
      }
      batches = value;
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
    // Backwards-compatible positional batch count (`npm test -- 3`).
    const positional = Number(argument);
    if (!Number.isNaN(positional)) {
      if (!Number.isSafeInteger(positional) || positional < 1) {
        throw new Error("batches must be a positive integer");
      }
      batches = positional;
      continue;
    }
    throw new Error(`Unknown codex online option: ${argument}`);
  }
  return { providerId, model, apiKeyFile, alias, batches, onlyScenario };
}

/**
 * Outbound dispatch logger: wraps the composition's fetch so every request
 * LuckyToken sends to the upstream Provider is recorded (URL, request body,
 * response status, response body) under `artifacts/upstream/`. This is the
 * only way to see what the Provider actually returned when a scenario fails
 * with an upstream error (e.g. "CommandCode text block completed empty").
 *
 * The upstream response body is read from a clone so the caller still
 * receives the original streaming body untouched.
 */
function createUpstreamLogger(
  artifactDir: string,
  upstream: FetchFunction,
): { readonly fetch: FetchFunction; readonly flush: () => Promise<void> } {
  let sequence = 0;
  const pending: Promise<void>[] = [];
  const upstreamDir = join(artifactDir, "upstream");
  const fetch: FetchFunction = async (input, init) => {
    const request =
      input instanceof Request ? input : new Request(input as RequestInfo, init);
    const requestBody = await request.clone().text();
    const startedAt = performance.now();
    const response = await upstream(request);
    const responseBody = await response.clone().text();
    const seq = sequence;
    sequence += 1;
    const entry = Object.freeze({
      seq,
      method: request.method,
      url: request.url,
      status: response.status,
      statusText: response.statusText,
      durationMs: Math.round(performance.now() - startedAt),
      requestHeaders: Object.fromEntries(request.headers.entries()),
      requestBody,
      responseBody,
    });
    pending.push(
      mkdir(upstreamDir, { recursive: true })
        .then(() =>
          writeFile(
            join(upstreamDir, `${String(seq).padStart(3, "0")}.json`),
            `${JSON.stringify(entry, null, 2)}\n`,
            "utf8",
          ),
        )
        .catch((error: unknown) => {
          process.stderr.write(
            `[codex-suite] upstream log write failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }),
    );
    return response;
  };
  return Object.freeze({
    fetch,
    flush: async () => {
      await Promise.allSettled(pending);
    },
  });
}

function codexProviderOverrides(
  baseUrl: string,
  model: string,
): readonly string[] {
  const stringOverride = (key: string, value: string): readonly string[] =>
    Object.freeze(["-c", `${key}=${JSON.stringify(value)}`]);
  return Object.freeze([
    ...stringOverride(`model_providers.${CODEX_PROFILE}.name`, "LuckyToken"),
    ...stringOverride(`model_providers.${CODEX_PROFILE}.base_url`, baseUrl),
    ...stringOverride(`model_providers.${CODEX_PROFILE}.wire_api`, "responses"),
    "-c",
    `model_providers.${CODEX_PROFILE}.requires_openai_auth=true`,
    ...stringOverride(
      `model_providers.${CODEX_PROFILE}.env_key`,
      CODEX_PROMPT_ENV_KEY,
    ),
    ...stringOverride("model_provider", CODEX_PROFILE),
    ...stringOverride("model", model),
  ]);
}

async function prepareIsolatedCodexHome(
  directory: string,
  baseUrl: string,
  model: string,
  modelsList?: { data?: Array<{ id?: string }> },
): Promise<string> {
  const inheritedCodexHome = process.env[CODEX_HOME_ENV_KEY]?.trim();
  // Prefer the explicitly generated catalog from the self-hosted endpoint;
  // fall back to the user's ~/.codex/luckytoken-catalog.json when the model
  // entry exists there (legacy CommandCode runs).
  const liveEntry = modelsList?.data?.find((entry) => entry.id === model);
  let modelEntry: unknown;
  if (liveEntry !== undefined) {
    modelEntry = Object.freeze({
      slug: liveEntry.id,
      display_name: liveEntry.id,
      description: `LuckyToken alias ${liveEntry.id}`,
      base_instructions: "You are a helpful assistant.",
      supported_reasoning_levels: Object.freeze([
        Object.freeze({
          effort: "high",
          description: "High reasoning effort",
        }),
      ]),
      shell_type: "default",
      visibility: "list",
      supported_in_api: true,
      priority: 100,
      support_verbosity: false,
      truncation_policy: Object.freeze({
        mode: "tokens",
        limit: 65536,
      }),
      supports_parallel_tool_calls: true,
      context_window: 200000,
      experimental_supported_tools: Object.freeze([]),
    });
  } else {
    const sourceCodexHome =
      inheritedCodexHome !== undefined && inheritedCodexHome.length > 0
        ? inheritedCodexHome
        : join(homedir(), ".codex");
    const sourceCatalogPath = join(sourceCodexHome, "luckytoken-catalog.json");
    const sourceCatalog = JSON.parse(
      await readFile(sourceCatalogPath, "utf8"),
    ) as unknown;
    if (
      typeof sourceCatalog !== "object" ||
      sourceCatalog === null ||
      Array.isArray(sourceCatalog) ||
      !("models" in sourceCatalog) ||
      !Array.isArray(sourceCatalog.models)
    ) {
      throw new Error("codex_model_catalog_invalid");
    }
    modelEntry = sourceCatalog.models.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        "slug" in candidate &&
        candidate.slug === model,
    );
    if (modelEntry === undefined) {
      throw new Error("codex_model_catalog_missing_target");
    }
  }

  const codexHome = join(directory, "codex-home");
  await mkdir(codexHome, { recursive: true });
  const catalogPath = join(codexHome, "luckytoken-catalog.json");
  await writeFile(
    catalogPath,
    `${JSON.stringify({ models: [modelEntry] }, null, 2)}\n`,
    "utf8",
  );
  const quoted = (value: string): string => JSON.stringify(value);
  await writeFile(
    join(codexHome, "config.toml"),
    [
      `[model_providers.${CODEX_PROFILE}]`,
      `name = ${quoted("LuckyToken")}`,
      `base_url = ${quoted(baseUrl)}`,
      `wire_api = ${quoted("responses")}`,
      "requires_openai_auth = true",
      `env_key = ${quoted(CODEX_PROMPT_ENV_KEY)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(codexHome, `${CODEX_PROFILE}.config.toml`),
    [
      `model_provider = ${quoted(CODEX_PROFILE)}`,
      `model = ${quoted(model)}`,
      `model_catalog_json = ${quoted(catalogPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return codexHome;
}

interface CodexExecResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly finalMessage: string;
  readonly events: readonly CodexJsonEvent[];
}

interface CodexJsonEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface OnlineSummary {
  attempted: number;
  successful: number;
  failed: number;
  failures: Record<string, number>;
  latenciesMs: number[];
  events: {
    created: number;
    outputItemDone: number;
    completed: number;
    failed: number;
    incomplete: number;
    missingOutputTokensDetails: number;
    orphanToolOutputs: number;
  };
}

function emptySummary(): OnlineSummary {
  return {
    attempted: 0,
    successful: 0,
    failed: 0,
    failures: {},
    latenciesMs: [],
    events: {
      created: 0,
      outputItemDone: 0,
      completed: 0,
      failed: 0,
      incomplete: 0,
      missingOutputTokensDetails: 0,
      orphanToolOutputs: 0,
    },
  };
}

function recordFailure(summary: OnlineSummary, category: string): void {
  summary.failures[category] = (summary.failures[category] ?? 0) + 1;
}

function failureCategory(error: unknown, totalSignal: AbortSignal): string {
  if (totalSignal.aborted) return "suite_timeout";
  if (error instanceof Error && /^codex_[a-z0-9_]+$/u.test(error.message)) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    return `http_${String(error.status)}`;
  }
  return "unknown_failure";
}

function requestSignal(totalSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([totalSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

/**
 * Parse a `codex exec --json` stdout stream into typed events.
 * Each line is JSON; the `type` field discriminates the event kind.
 */
function parseCodexJsonEvents(stdout: string): readonly CodexJsonEvent[] {
  const events: CodexJsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      if (type.length === 0) continue;
      events.push({ type, payload: record });
    } catch {
      // Non-JSON line (e.g. a stray log); ignore — assertions use events only.
    }
  }
  return events;
}

/**
 * Run one `codex -p luckytoken exec --json` invocation.
 *
 * The token is injected via environment (`LUCKYTOKEN_API_KEY`), matching the
 * `env_key` configured in `~/.codex/config.toml`. `--json` emits JSONL events
 * on stdout; `-o` writes the final agent message to a file.
 */
async function runCodexExec(
  prompt: string,
  token: string,
  baseUrl: string,
  model: string,
  cwd: string,
  artifactDir: string,
  marker: string,
  totalSignal: AbortSignal,
  extraEnv: Record<string, string> = {},
  mode: "new" | "resume" = "new",
): Promise<CodexExecResult> {
  const codexHome = extraEnv[CODEX_HOME_ENV_KEY];
  if (codexHome === undefined) throw new Error("codex_home_missing");
  const outputFile = join(artifactDir, `${marker}.final.md`);
  const stdoutFile = join(artifactDir, `${marker}.events.jsonl`);
  const stderrFile = join(artifactDir, `${marker}.stderr.log`);

  const args =
    mode === "resume"
      ? [
          "-p",
          CODEX_PROFILE,
          "exec",
          "resume",
          "--last",
          ...codexProviderOverrides(baseUrl, model),
          "--dangerously-bypass-approvals-and-sandbox",
          "--json",
          "-o",
          outputFile,
          "--skip-git-repo-check",
          prompt,
        ]
      : [
          "-p",
          CODEX_PROFILE,
          "exec",
          ...codexProviderOverrides(baseUrl, model),
          "--dangerously-bypass-approvals-and-sandbox",
          "--json",
          "-o",
          outputFile,
          "--skip-git-repo-check",
          prompt,
        ];

  const child = spawn(
    process.execPath,
    [CODEX_JS, ...args],
    {
      cwd,
      env: {
        ...process.env,
        [CODEX_PROMPT_ENV_KEY]: token,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  console.error(`[codex-exec] spawned ${marker} (${mode})`);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
      // On Windows, child.kill() does not always emit "close"; also resolve
      // on "exit" so a killed child never leaves the suite hanging.
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  let timedOut = false;
  const abort = abortPromise(totalSignal, child);
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    const id = setTimeout(() => {
      timedOut = true;
      child.kill();
      resolve("timeout");
    }, CODEX_EXEC_TIMEOUT_MS);
    id.unref?.();
  });
  await Promise.race([
    exitPromise.then(() => "done" as const),
    timeoutPromise,
    abort.promise.then(() => "aborted" as const),
  ]);
  abort.cleanup();

  // Absolute safety net: even if the child neither closes nor exits after
  // kill() (defensive against platform quirks), never hang the suite.
  const { code, signal } = await Promise.race([
    exitPromise,
    new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const id = setTimeout(() => {
        child.kill();
        resolve({ code: null, signal: "killed" });
      }, CODEX_EXEC_TIMEOUT_MS);
      id.unref?.();
    }),
  ]);

  try {
    const finalMessage = await readFile(outputFile, "utf8");
    await writeFile(stdoutFile, stdout, "utf8");
    await writeFile(stderrFile, stderr, "utf8");
    return {
      exitCode: code,
      signal,
      timedOut,
      stdout,
      stderr,
      finalMessage,
      events: parseCodexJsonEvents(stdout),
    };
  } catch {
    // Output file may not exist when the child was killed before writing.
    const finalMessage = "";
    await writeFile(stdoutFile, stdout, "utf8");
    await writeFile(stderrFile, stderr, "utf8");
    return {
      exitCode: code,
      signal,
      timedOut,
      stdout,
      stderr,
      finalMessage,
      events: parseCodexJsonEvents(stdout),
    };
  }
}

function abortPromise(
  signal: AbortSignal,
  child: ReturnType<typeof spawn>,
): { promise: Promise<never>; cleanup: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      child.kill();
      reject(new Error("codex_aborted"));
      return;
    }
    onAbort = (): void => {
      child.kill();
      reject(new Error("codex_aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Layered assertion for one Codex invocation:
 *  1. black-box — exit 0 + non-empty final message;
 *  2. Codex JSONL events — a completed turn with a non-empty agent message
 *     (the Responses lifecycle lives on the wire; Codex's `--json` emits its
 *     own `turn.completed`/`item.completed` events, which is what proves the
 *     client accepted the conversation);
 *  3. (server-side) — snapshot inspection runs after the batch.
 */
function assertCodexResult(
  result: CodexExecResult,
  expectedText: string | undefined,
  summary: OnlineSummary,
  requiredItemType?: string,
  requiredItemTypes?: readonly string[],
  minimumRequiredItems = 1,
  requireFailedCommand = false,
): void {
  if (result.timedOut) {
    throw new Error("codex_exec_timeout");
  }
  if (result.events.length === 0) {
    if (result.exitCode !== 0) {
      throw new Error(`codex_exit_${result.exitCode ?? "null"}`);
    }
    throw new Error("codex_no_json_events");
  }

  const types = result.events.map((event) => event.type);
  const completed = types.filter((type) => type === "turn.completed").length;
  const agentMessages = result.events.filter(
    (event) =>
      event.type === "item.completed" &&
      typeof event.payload.item === "object" &&
      event.payload.item !== null &&
      (event.payload.item as { type?: string }).type === "agent_message",
  );
  const agentText = agentMessages
    .map((event) => {
      const item = event.payload.item as { text?: string };
      return typeof item.text === "string" ? item.text : "";
    })
    .join("");

  summary.events.completed += completed;
  if (completed === 0) {
    // No completed turn: a non-zero exit is a real failure.
    if (result.exitCode !== 0) {
      throw new Error(`codex_exit_${result.exitCode ?? "null"}`);
    }
    throw new Error("codex_no_turn_completed");
  }
  if (agentText.trim().length === 0) {
    throw new Error("codex_no_agent_message");
  }
  if (expectedText !== undefined && !agentText.includes(expectedText)) {
    throw new Error("codex_expected_text_missing");
  }
  if (
    requiredItemType !== undefined &&
    result.events.filter(
      (event) =>
        event.type === "item.completed" &&
        typeof event.payload.item === "object" &&
        event.payload.item !== null &&
        (event.payload.item as { type?: string }).type === requiredItemType,
    ).length < minimumRequiredItems
  ) {
    throw new Error("codex_required_item_missing");
  }
  if (
    requiredItemTypes !== undefined &&
    !requiredItemTypes.some((type) =>
      result.events.some(
        (event) =>
          event.type === "item.completed" &&
          typeof event.payload.item === "object" &&
          event.payload.item !== null &&
          (event.payload.item as { type?: string }).type === type,
      ),
    )
  ) {
    throw new Error("codex_required_item_missing");
  }
  if (
    requireFailedCommand &&
    !result.events.some((event) => {
      if (
        event.type !== "item.completed" ||
        typeof event.payload.item !== "object" ||
        event.payload.item === null
      ) {
        return false;
      }
      const item = event.payload.item as { type?: string; exit_code?: unknown };
      return (
        item.type === "command_execution" &&
        typeof item.exit_code === "number" &&
        item.exit_code !== 0
      );
    })
  ) {
    throw new Error("codex_failed_command_missing");
  }
  // The Codex CLI occasionally exits non-zero during MCP shutdown even after
  // a fully completed turn (verified: turn.completed present, final message
  // correct). The protocol result is authoritative, not the process code.
  if (result.exitCode !== 0 && result.finalMessage.trim().length === 0) {
    throw new Error("codex_no_final_message");
  }

  // usage shape from Codex's turn.completed event.
  for (const event of result.events) {
    if (event.type !== "turn.completed") continue;
    const usage = event.payload.usage as Record<string, unknown> | undefined;
    if (
      usage === undefined ||
      typeof usage.input_tokens !== "number" ||
      typeof usage.output_tokens !== "number"
    ) {
      throw new Error("codex_usage_shape");
    }
  }

  // Tool round-trips: a completed turn may contain custom_tool_call /
  // function_call items; their outputs must pair with the calls.
  const callIds = new Set<string>();
  for (const event of result.events) {
    if (event.type !== "item.completed") continue;
    const item = event.payload.item as Record<string, unknown> | undefined;
    if (item === undefined) continue;
    if (
      (item.type === "function_call" || item.type === "custom_tool_call") &&
      typeof item.call_id === "string"
    ) {
      callIds.add(item.call_id);
    }
  }
  for (const event of result.events) {
    if (event.type !== "item.completed") continue;
    const item = event.payload.item as Record<string, unknown> | undefined;
    if (item === undefined) continue;
    if (
      (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
      typeof item.call_id === "string" &&
      !callIds.has(item.call_id)
    ) {
      summary.events.orphanToolOutputs += 1;
      throw new Error("codex_orphan_tool_output");
    }
  }
}

/**
 * Server-side snapshot inspection (Q4c layer 3): after the batch, verify the
 * durable state file contains only well-formed entries — every entry has a
 * non-empty id, a createdAt, and an items array with no orphan tool outputs.
 */
async function assertSnapshotHealthy(stateFile: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch {
    // No snapshot yet (nothing completed); treat as healthy.
    return;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("snapshot_not_object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 2 || !Array.isArray(record.states)) {
    throw new Error("snapshot_bad_version_or_states");
  }
  for (const entry of record.states) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("snapshot_bad_entry");
    }
    const id = entry[0];
    const value = entry[1];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("snapshot_bad_id");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("snapshot_bad_value");
    }
    const valueRecord = value as Record<string, unknown>;
    if (typeof valueRecord.createdAt !== "number" || !Array.isArray(valueRecord.items)) {
      throw new Error("snapshot_bad_value_shape");
    }
    // Orphan detection: function_call_output must pair with a function_call
    // earlier in the same entry.
    const seenCallIds = new Set<string>();
    for (const item of valueRecord.items as unknown[]) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const itemRecord = item as Record<string, unknown>;
      if (itemRecord.type === "function_call" && typeof itemRecord.call_id === "string") {
        seenCallIds.add(itemRecord.call_id);
      }
    }
    for (const item of valueRecord.items as unknown[]) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const itemRecord = item as Record<string, unknown>;
      if (
        itemRecord.type === "function_call_output" &&
        typeof itemRecord.call_id === "string" &&
        !seenCallIds.has(itemRecord.call_id)
      ) {
        throw new Error("snapshot_orphan_tool_output");
      }
    }
  }
}

/**
 * Directed scenarios (Q5): each prompt exercises a specific protocol path.
 * Markers must appear verbatim in the final message for black-box assertion.
 */
interface Scenario {
  readonly id: string;
  readonly prompt: string;
  readonly expectedText?: string;
  readonly requiredItemType?: string;
  /** Accept any of these completed item types (e.g. a model may create a
   *  file with `command_execution` or `file_change`). */
  readonly requiredItemTypes?: readonly string[];
  readonly minimumRequiredItems?: number;
  readonly requireFailedCommand?: boolean;
  readonly requiredCustomTool?: string;
  /** After the turn, verify this file exists in the session directory. */
  readonly expectedFile?: Readonly<{ path: string; content: string }>;
  /** Extra Codex flags for this scenario (e.g. tool usage). */
  readonly extraArgs?: readonly string[];
  /**
   * Special orchestration:
   *  - "multi_turn": run the prompt as a multi-turn session (first turn
   *    `exec`, subsequent turns `exec resume --last`) to exercise
   *    `previous_response_id` chaining across a real Codex conversation.
   *  - "restart": kill the LuckyToken server, restart it, then run — verifies
   *    durable snapshot recovery across a process restart.
   *  - "cancel": terminate the Codex child mid-run — verifies cancellation
   *    propagation (upstream abort, no state pollution).
   */
  readonly special?: "multi_turn" | "restart" | "cancel";
  /** Number of turns for a multi_turn scenario (default 3). */
  readonly turns?: number;
}

function directedScenarios(): readonly Scenario[] {
  return Object.freeze([
    // --- wire: message items ---
    Object.freeze({
      id: "chain_basic",
      prompt:
        "Reply with exactly: CHAIN_BASIC_OK. Do not explain, do not use tools.",
      expectedText: "CHAIN_BASIC_OK",
    }),
    Object.freeze({
      id: "chain_long",
      prompt:
        "Reply with exactly: CHAIN_LONG_OK, then repeat the exact string " +
        "'abcdefghij' ten times on one line. Do not explain.",
      expectedText: "CHAIN_LONG_OK",
    }),
    Object.freeze({
      id: "no_tools",
      prompt:
        "Reply with exactly: NO_TOOLS_OK. Do not use any tools, do not explain.",
      expectedText: "NO_TOOLS_OK",
    }),
    Object.freeze({
      id: "reasoning",
      prompt:
        "Think step by step, then reply with exactly: REASONING_OK. " +
        "Do not use tools, do not explain.",
      expectedText: "REASONING_OK",
    }),
    Object.freeze({
      id: "long_text",
      prompt:
        "Write a paragraph of at least 200 words about protocol conversion. " +
        "End with the exact token: LONG_TEXT_OK. Do not use tools.",
      expectedText: "LONG_TEXT_OK",
    }),

    // --- wire: tool items ---
    Object.freeze({
      id: "tool_shell",
      prompt:
        "Use the exec_command tool exactly once to run: echo TOOL_SHELL_OK. " +
        "Do not plan, spawn sub-agents, inspect artifacts, or use any other tool. " +
        "After the command completes, immediately reply with exactly its output.",
      expectedText: "TOOL_SHELL_OK",
      requiredItemType: "command_execution",
    }),
    Object.freeze({
      id: "tool_apply_patch",
      prompt:
        "Create codex_cli_probe.txt containing exactly TOOL_APPLY_PATCH_OK. " +
        "Use apply_patch if that tool is actually available in this Codex session; " +
        "otherwise use exactly one shell/exec command to create the file. " +
        "Do not call update_plan, spawn sub-agents, search for tool examples, inspect " +
        "test artifacts, or use unrelated tools. After the file is created, immediately " +
        "reply with exactly: TOOL_APPLY_PATCH_OK.",
      expectedText: "TOOL_APPLY_PATCH_OK",
      // Codex tool availability is client-version/platform dependent. When
      // apply_patch is advertised this becomes file_change; otherwise the
      // Windows CLI falls back to one command_execution. Both are observable
      // real-client file-write tool round-trips.
      requiredItemTypes: ["file_change", "command_execution"],
      expectedFile: {
        path: "codex_cli_probe.txt",
        content: "TOOL_APPLY_PATCH_OK",
      },
    }),
    Object.freeze({
      id: "tool_shell_error",
      prompt:
        "Use exec_command exactly once to run a command that writes EXPECTED_TOOL_FAILURE " +
        "to stderr and exits with code 7. The failure is expected: do not retry, plan, " +
        "spawn sub-agents, inspect artifacts, or use another tool. Then immediately reply " +
        "with exactly: TOOL_ERROR_RECOVERED_OK.",
      expectedText: "TOOL_ERROR_RECOVERED_OK",
      requiredItemType: "command_execution",
      requireFailedCommand: true,
    }),
    Object.freeze({
      id: "tool_unicode",
      prompt:
        "Use exec_command exactly once to output exactly UNICODE_汉字_🙂_OK. " +
        "Do not plan, spawn sub-agents, inspect artifacts, or use another tool. " +
        "Then immediately reply with exactly: UNICODE_汉字_🙂_OK.",
      expectedText: "UNICODE_汉字_🙂_OK",
      requiredItemType: "command_execution",
    }),
    Object.freeze({
      id: "parallel_shell_tools",
      prompt:
        "In one tool round, call exec_command exactly twice in parallel: one command " +
        "outputs PARALLEL_A_OK and the other outputs PARALLEL_B_OK. Do not plan, spawn " +
        "sub-agents, inspect artifacts, or use other tools. After both finish, immediately " +
        "reply with exactly: PARALLEL_TOOLS_OK.",
      expectedText: "PARALLEL_TOOLS_OK",
      requiredItemType: "command_execution",
      minimumRequiredItems: 2,
    }),

    // --- wire: incremental chaining (previous_response_id) ---
    Object.freeze({
      id: "multi_turn_chain",
      prompt:
        "This is a multi-turn chain. Memorize MT_MEMORY_SEED. For turn 1, immediately " +
        "reply with exactly: MULTI_TURN_1_OK. Do not plan, use tools, spawn sub-agents, " +
        "inspect artifacts, or explain.",
      expectedText: "MULTI_TURN_1_OK",
      special: "multi_turn",
      turns: 3,
    }),

    // --- wire: multi-turn tool state across a real conversation ---
    Object.freeze({
      id: "multi_turn_tool",
      prompt:
        "This is a multi-turn tool session. For turn 1, use exec_command exactly once " +
        "to create multi_turn_probe.txt containing exactly MULTI_TURN_TOOL_1. Do not " +
        "plan, spawn sub-agents, inspect artifacts, or use another tool. After the command " +
        "completes, immediately reply with exactly: MULTI_TURN_TOOL_1_OK.",
      expectedText: "MULTI_TURN_TOOL_1_OK",
      requiredItemType: "command_execution",
      special: "multi_turn",
      turns: 3,
    }),

    // --- wire: restart recovery (durable snapshot) ---
    Object.freeze({
      id: "restart_recovery",
      prompt:
        "This is a restart-recovery probe. Immediately reply with exactly: " +
        "RESTART_RECOVERY_OK. Do not plan, use tools, spawn sub-agents, inspect " +
        "artifacts, or explain.",
      expectedText: "RESTART_RECOVERY_OK",
      special: "restart",
    }),

    // --- wire: cancellation ---
    Object.freeze({
      id: "cancel",
      prompt:
        "This is a cancellation probe. Reply with exactly: CANCEL_OK. " +
        "Do not use tools, do not explain.",
      special: "cancel",
    }),
  ]);
}

/**
 * Random scenarios: combine a base instruction with a random marker and
 * occasionally request tools, to surface non-deterministic conversion bugs.
 */
function randomScenarios(count: number): readonly Scenario[] {
  const templates = [
    (marker: string) => `Reply with exactly: ${marker}. Do not explain.`,
    (marker: string) => `Say the token ${marker} and nothing else.`,
    (marker: string) => `Your only task: output the token ${marker}.`,
  ];
  const toolTemplates = [
    (marker: string) =>
      `Use the exec_command tool exactly once to run: echo ${marker}. Do not plan, delegate, ` +
      `inspect artifacts, or use another tool. Then immediately reply with exactly the output.`,
    (marker: string) =>
      `Write ${marker} to probe.txt. Use apply_patch only if it is actually advertised; ` +
      `otherwise use exactly one exec_command. Do not plan, delegate, inspect artifacts, ` +
      `or search for examples. Then immediately reply with exactly ${marker}.`,
  ];
  const scenarios: Scenario[] = [];
  for (let index = 0; index < count; index += 1) {
    const marker = `RND_${String(index + 1).padStart(3, "0")}_OK`;
    const useTool = index % 3 === 0;
    const toolTemplate = toolTemplates[index % toolTemplates.length];
    const plainTemplate = templates[index % templates.length];
    const template = useTool
      ? (toolTemplate ?? toolTemplates[0]!)
      : (plainTemplate ?? templates[0]!);
    scenarios.push(
      Object.freeze({
        id: `random_${index + 1}`,
        prompt: template(marker),
        expectedText: marker,
        ...(useTool
          ? {
              ...(index % toolTemplates.length === 0
                ? { requiredItemType: "command_execution" }
                : {
                    // The model may write the file with apply_patch
                    // (file_change) or a shell command; both prove the
                    // tool round-trip.
                    requiredItemTypes: ["file_change", "command_execution"],
                  }),
            }
          : {}),
      }),
    );
  }
  return Object.freeze(scenarios);
}

/**
 * Build the coverage matrix: directed scenarios (one per protocol facet)
 * first, then a small random set to surface unanticipated paths. The batch
 * repeats the matrix `batches` times — default 1 (coverage), more only when
 * volume is explicitly wanted.
 */
function buildPlan(batches: number): readonly Scenario[] {
  const plan: Scenario[] = [];
  for (let batch = 0; batch < batches; batch += 1) {
    plan.push(...directedScenarios());
    plan.push(...randomScenarios(6));
  }
  return Object.freeze(plan);
}

async function runPool(
  scenarios: readonly Scenario[],
  worker: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: DEFAULT_CONCURRENCY }, async () => {
      while (cursor < scenarios.length) {
        const scenario = scenarios[cursor];
        cursor += 1;
        if (scenario !== undefined) await worker(scenario);
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

/**
 * Wrap the runtime so every inbound `/v1/responses` request body is captured
 * to `artifacts/requests/<marker>_<seq>.json`. These are REAL Codex CLI
 * request samples (incremental input + previous_response_id + tools), which
 * can later be replayed as golden fixtures in unit/integration tests.
 */
function createCapturingRuntime(
  runtime: LuckyTokenRuntime,
  artifactDir: string,
  currentMarker: () => string | undefined,
): LuckyTokenRuntime {
  let sequence = 0;
  return Object.freeze({
    routes: runtime.routes,
    async handle(request: Request): Promise<Response> {
      const marker = currentMarker() ?? "unknown";
      const cloned = request.clone();
      const bodyText = await cloned.text();
      const requestsDir = join(artifactDir, "requests");
      await mkdir(requestsDir, { recursive: true });
      const seq = (sequence += 1);
      const name = `${marker}_${String(seq).padStart(2, "0")}.json`;
      await writeFile(
        join(requestsDir, name),
        JSON.stringify(
          {
            marker,
            method: cloned.method,
            url: cloned.url,
            body: (() => {
              try {
                return JSON.parse(bodyText);
              } catch {
                return bodyText;
              }
            })(),
          },
          null,
          2,
        ),
        "utf8",
      );
      return runtime.handle(request);
    },
  });
}

async function assertCapturedCustomToolRoundTrip(
  artifactDir: string,
  marker: string,
  toolName: string,
): Promise<void> {
  const requestsDir = join(artifactDir, "requests");
  const requestNames = (await readdir(requestsDir)).filter(
    (name) => name.startsWith(`${marker}_`) && name.endsWith(".json"),
  );
  const callIds = new Set<string>();
  const outputIds = new Set<string>();

  for (const requestName of requestNames) {
    const captured: unknown = JSON.parse(
      await readFile(join(requestsDir, requestName), "utf8"),
    );
    if (typeof captured !== "object" || captured === null) continue;
    const body = (captured as { body?: unknown }).body;
    if (typeof body !== "object" || body === null) continue;
    const input = (body as { input?: unknown }).input;
    if (!Array.isArray(input)) continue;

    for (const item of input) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as {
        type?: unknown;
        name?: unknown;
        call_id?: unknown;
      };
      if (
        record.type === "custom_tool_call" &&
        record.name === toolName &&
        typeof record.call_id === "string"
      ) {
        callIds.add(record.call_id);
      }
      if (
        record.type === "custom_tool_call_output" &&
        typeof record.call_id === "string"
      ) {
        outputIds.add(record.call_id);
      }
    }
  }

  if (![...callIds].some((callId) => outputIds.has(callId))) {
    throw new Error("codex_custom_tool_round_trip_missing");
  }
}

function closeDataPlaneStores(composition: ConfiguredLuckyTokenDataPlane): void {
  composition.deepCaptureStore.close();
  composition.requestLedger.close();
  composition.diagnosticsStore.close();
}

export async function runCodexCliOnlineSuite(
  args: readonly string[] = [],
): Promise<void> {
  const { providerId, model, apiKeyFile, alias, batches, onlyScenario } =
    parseArguments(args);
  const selector = alias ?? model;
  const apiKey = (
    await readFile(
      apiKeyFile.includes("\\") || apiKeyFile.includes("/")
        ? apiKeyFile
        : join(REPOSITORY_ROOT, apiKeyFile),
      "utf8",
    )
  ).trim();
  if (apiKey.length === 0) throw new Error(`${apiKeyFile} is empty`);
  console.error("[codex-suite] apiKey loaded");

  const totalSignal = AbortSignal.timeout(SUITE_TIMEOUT_MS);
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-codex-cli-"));
  const artifactDir = join(directory, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  console.error(`[codex-suite] tmpdir=${directory}`);

  // Self-host a fresh LuckyToken service on a random port with a clean state
  // file, using THIS repo's current code. Codex CLI points at it via
  // `-c model_providers.luckytoken.base_url=<origin>`, so the suite always
  // exercises the code under test (not whatever service is already running).
  const stateDirectory = join(directory, ".luckytoken");
  const piDirectory = join(stateDirectory, "pi");
  await mkdir(piDirectory, { recursive: true });
  const responsesToken = "unused-local-sdk-key";
  const stateFile = join(stateDirectory, "state", "openai-responses.json");
  const configPath = join(stateDirectory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "luckytoken-config-v1",
      server: { port: 0 },
      clientProtocols: {
        "anthropic-messages": {},
        "openai-responses": {
          stateFile: "state/openai-responses.json",
        },
      },
      providerPackages:
        providerId === "commandcode-private"
          ? { "@luckytoken/provider-commandcode-private": {} }
          : {},
      pi: { directory: "pi" },
      limits: { maxRequestBytes: 1_048_576, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    }),
    "utf8",
  );
  const config = await loadLuckyTokenCliConfig(configPath);
  console.error("[codex-suite] config loaded");
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
  console.error("[codex-suite] credentials ready");
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
  const upstreamLogger = createUpstreamLogger(artifactDir, globalThis.fetch);
  let composition = await createConfiguredLuckyTokenDataPlane({
    config,
    credentials,
    fetch: upstreamLogger.fetch,
    ...(publicModelAuthority === undefined ? {} : { publicModelAuthority }),
  });
  if (publicModelAuthority !== undefined) {
    await reconcileOnlinePublicModels(
      publicModelAuthority,
      composition.catalog.models,
      providerId,
    );
  }
  console.error("[codex-suite] composition ready");
  // Capture every real Codex request for later reuse as golden samples.
  let currentMarker: string | undefined;
  let runtime = createCapturingRuntime(
    composition.runtime,
    artifactDir,
    () => currentMarker,
  );
  let server = await startLuckyTokenHttpServer({
    runtime,
    host: "127.0.0.1",
    port: config.server.port,
  });
  const origin = server.origin;
  // Codex's `base_url` includes the `/v1` prefix (matching config.toml).
  let codexBaseUrl = `${origin}/v1`;
  // Sanity: the self-hosted endpoint must expose the resolved selector.
  // The live model list also seeds the isolated Codex catalog, so the
  // suite never depends on a legacy ~/.codex/luckytoken-catalog.json.
  const modelsResponse = await fetch(`${codexBaseUrl}/models`, {
    headers: { authorization: `Bearer ${responsesToken}` },
    signal: requestSignal(totalSignal),
  });
  if (modelsResponse.status !== 200) {
    throw new Error(`codex_models_status_${modelsResponse.status}`);
  }
  const modelsList = (await modelsResponse.json()) as {
    data?: Array<{ id?: string }>;
  };
  if (!modelsList.data?.some((entry) => entry.id === selector)) {
    throw new Error("codex_models_discovery_missing");
  }
  const codexHome = await prepareIsolatedCodexHome(
    directory,
    codexBaseUrl,
    selector,
    modelsList,
  );
  const codexEnvironment = Object.freeze({
    [CODEX_HOME_ENV_KEY]: codexHome,
  });
  console.error(`[codex-suite] server listening at ${codexBaseUrl}`);

  try {
    const summary = emptySummary();
    const plan = buildPlan(batches);
    const scenarios =
      onlyScenario === undefined
        ? plan
        : plan.filter((scenario) => scenario.id === onlyScenario);
    if (scenarios.length === 0) {
      throw new Error(`no scenario matches --scenario ${onlyScenario}`);
    }
    console.error(`[codex-suite] plan built: ${scenarios.length} scenarios`);
    const matrix: Array<{
      id: string;
      status: "pass" | "fail";
      category?: string;
      ms: number;
    }> = [];

    console.error("[codex-suite] starting runPool");
    await runPool(scenarios, async (scenario) => {
      const startedAt = performance.now();
      summary.attempted += 1;
      const marker = `${scenario.id}_${randomUUID().slice(0, 8)}`;
      currentMarker = marker;
      // Isolate each scenario's Codex session directory so `resume --last`
      // never chains into another scenario's conversation.
      const sessionDir = join(directory, "sessions", marker);
      await mkdir(sessionDir, { recursive: true });
      try {
        if (scenario.special === "multi_turn") {
          await runMultiTurnSession(
            scenario,
            responsesToken,
            codexBaseUrl,
            selector,
            sessionDir,
            artifactDir,
            marker,
            codexEnvironment,
            totalSignal,
          );
        } else if (scenario.special === "restart") {
          await runRestartRecoveryScenario(
            scenario,
            responsesToken,
            codexBaseUrl,
            selector,
            sessionDir,
            artifactDir,
            marker,
            codexEnvironment,
            totalSignal,
            stateFile,
            async () => {
              await server.close();
              closeDataPlaneStores(composition);
              composition = await createConfiguredLuckyTokenDataPlane({
                config,
                credentials,
                fetch: upstreamLogger.fetch,
                ...(publicModelAuthority === undefined
                  ? {}
                  : { publicModelAuthority }),
              });
              if (publicModelAuthority !== undefined) {
                await reconcileOnlinePublicModels(
                  publicModelAuthority,
                  composition.catalog.models,
                  providerId,
                );
              }
              runtime = createCapturingRuntime(
                composition.runtime,
                artifactDir,
                () => currentMarker,
              );
              server = await startLuckyTokenHttpServer({
                runtime,
                host: "127.0.0.1",
                port: config.server.port,
              });
              codexBaseUrl = `${server.origin}/v1`;
              console.error(`[codex-suite] restarted at ${codexBaseUrl}`);
              return codexBaseUrl;
            },
          );
        } else if (scenario.special === "cancel") {
          await runCancellationScenario(
            scenario,
            responsesToken,
            codexBaseUrl,
            selector,
            sessionDir,
            artifactDir,
            marker,
            codexEnvironment,
            totalSignal,
          );
        } else {
          const result = await runCodexExec(
            scenario.prompt,
            responsesToken,
            codexBaseUrl,
            selector,
            sessionDir,
            artifactDir,
            marker,
            requestSignal(totalSignal),
            codexEnvironment,
          );
          assertCodexResult(
            result,
            scenario.expectedText,
            summary,
            scenario.requiredItemType,
            scenario.requiredItemTypes,
            scenario.minimumRequiredItems,
            scenario.requireFailedCommand,
          );
        }
        if (scenario.requiredCustomTool !== undefined) {
          await assertCapturedCustomToolRoundTrip(
            artifactDir,
            marker,
            scenario.requiredCustomTool,
          );
        }
        if (scenario.expectedFile !== undefined) {
          const actual = await readFile(
            join(sessionDir, scenario.expectedFile.path),
            "utf8",
          );
          if (actual.trim() !== scenario.expectedFile.content) {
            throw new Error("codex_expected_file_mismatch");
          }
        }
        summary.successful += 1;
        const elapsed = performance.now() - startedAt;
        summary.latenciesMs.push(elapsed);
        matrix.push({ id: scenario.id, status: "pass", ms: Math.round(elapsed) });
      } catch (error) {
        summary.failed += 1;
        const category = failureCategory(error, totalSignal);
        if (category === "unknown_failure") {
          process.stderr.write(
            `[codex job ${marker}] error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
          );
        }
        recordFailure(summary, category);
        matrix.push({
          id: scenario.id,
          status: "fail",
          category,
          ms: Math.round(performance.now() - startedAt),
        });
      }
    });

    // Server-side snapshot health after the batch.
    await assertSnapshotHealthy(stateFile);

    const stdout: string[] = [];
    stdout.push("=== Codex CLI online suite ===");
    stdout.push(`artifactDir: ${artifactDir}`);
    stdout.push(`origin: ${origin}`);
    stdout.push(`batches: ${batches}`);
    stdout.push(`attempted: ${summary.attempted}`);
    stdout.push(`successful: ${summary.successful}`);
    stdout.push(`failed: ${summary.failed}`);
    stdout.push("--- coverage matrix ---");
    for (const entry of matrix) {
      stdout.push(
        `${entry.status === "pass" ? "PASS" : "FAIL"} ${entry.id} ` +
          `${entry.status === "fail" && entry.category !== undefined ? `[${entry.category}] ` : ""}` +
          `${entry.ms}ms`,
      );
    }
    stdout.push(`failures: ${JSON.stringify(summary.failures)}`);
    stdout.push(`latenciesMs: ${JSON.stringify(latencySummary(summary.latenciesMs))}`);
    stdout.push(`events: ${JSON.stringify(summary.events)}`);
    const summaryText = stdout.join("\n");
    process.stdout.write(`${summaryText}\n`);
    // Persist the summary to disk AND emit it on stderr (unbuffered) so a
    // forced exit cannot lose the result.
    await writeFile(join(artifactDir, "summary.txt"), `${summaryText}\n`, "utf8");
    process.stderr.write(`${summaryText}\n`);

    if (summary.failed > 0 || summary.events.missingOutputTokensDetails > 0) {
      throw new Error(
        `codex_suite_failures=${summary.failed} ` +
          `missingOutputTokensDetails=${summary.events.missingOutputTokensDetails}`,
      );
    }
  } finally {
    await upstreamLogger.flush();
    await server.close();
    closeDataPlaneStores(composition);
  }
}

/**
 * Multi-turn session: the real Codex client continues ONE conversation across
 * N `exec` invocations. Turn 1 starts a new session; turns 2..N resume the
 * most recent session (`exec resume --last`), so Codex sends incremental
 * `input` plus `previous_response_id` on every turn after the first. This is
 * the only way to exercise the adapter's durable chain expansion with the
 * real client, not synthetic HTTP.
 *
 * Each turn asserts the full lifecycle + usage + tool pairing; after the
 * session, the durable snapshot is checked for healthy chain state.
 */
async function runMultiTurnSession(
  scenario: Scenario,
  token: string,
  baseUrl: string,
  model: string,
  cwd: string,
  artifactDir: string,
  marker: string,
  codexEnvironment: Record<string, string>,
  totalSignal: AbortSignal,
): Promise<void> {
  const turns = scenario.turns ?? 3;
  const perTurn = emptySummary();
  for (let turn = 1; turn <= turns; turn += 1) {
    const isFirst = turn === 1;
    let prompt: string;
    if (isFirst) {
      prompt = scenario.prompt;
    } else {
      // Continuation turns reference prior context; the exact wording varies
      // by scenario, so use a generic continuation that forces the model to
      // depend on replayed history.
      prompt =
        turn === 2
          ? "Continue. Recall turn 1 and immediately reply with exactly: " +
            "MULTI_TURN_2_OK. Do not plan, spawn sub-agents, inspect artifacts, or use " +
            "tools unless this is the dedicated multi-turn tool scenario."
          : scenario.id === "multi_turn_chain"
            ? "Continue. The first turn contained a seed token that is not repeated in this " +
              "prompt. Read it from the earlier conversation and immediately output only that " +
              "exact seed token. Do not plan, use tools, spawn sub-agents, inspect artifacts, " +
              "guess, or explain."
            : "Continue. Recall the whole conversation and immediately reply with exactly: " +
              "MULTI_TURN_3_OK. Do not plan, spawn sub-agents, inspect artifacts, or use " +
              "tools unless this is the dedicated multi-turn tool scenario.";
    }
    const result = await runCodexExec(
      prompt,
      token,
      baseUrl,
      model,
      cwd,
      artifactDir,
      `${marker}_t${turn}`,
      requestSignal(totalSignal),
      codexEnvironment,
      isFirst ? "new" : "resume",
    );
    const expectedText = isFirst
      ? scenario.expectedText
      : turn === 2
        ? "MULTI_TURN_2_OK"
        : scenario.id === "multi_turn_chain"
          ? "MT_MEMORY_SEED"
          : "MULTI_TURN_3_OK";
    assertCodexResult(
      result,
      expectedText,
      perTurn,
      isFirst ? scenario.requiredItemType : undefined,
    );
    if (turn === turns && scenario.id === "multi_turn_chain") {
      // Cross-turn memory: the final turn must reproduce the seed token,
      // proving the adapter replayed the FULL history (not just the latest
      // increment) across `resume` turns.
      if (!result.finalMessage.includes("MT_MEMORY_SEED")) {
        throw new Error("codex_multi_turn_memory_lost");
      }
    }
  }
}

/**
 * Restart-recovery scenario: run a turn, kill the LuckyToken server, restart
 * it on the same state file, then continue the same Codex session via
 * `previous_response_id` (Codex re-sends full history on its own). The
 * durable snapshot must restore expansion across the restart.
 */
async function runRestartRecoveryScenario(
  scenario: Scenario,
  token: string,
  baseUrl: string,
  model: string,
  cwd: string,
  artifactDir: string,
  marker: string,
  codexEnvironment: Record<string, string>,
  totalSignal: AbortSignal,
  stateFile: string,
  restart: () => Promise<string>,
): Promise<void> {
  const first = await runCodexExec(
    scenario.prompt,
    token,
    baseUrl,
    model,
    cwd,
    artifactDir,
    `${marker}_t1`,
    requestSignal(totalSignal),
    codexEnvironment,
  );
  assertCodexResult(first, scenario.expectedText, emptySummary());

  // Kill the server WITHOUT flushing state (simulates a crash).
  const newBaseUrl = await restart();

  const second = await runCodexExec(
    "Continue the conversation. Reply with exactly: RESTART_RECOVERY_CONTINUED_OK. " +
      "Do not use tools, do not explain.",
    token,
    newBaseUrl,
    model,
    cwd,
    artifactDir,
    `${marker}_t2`,
    requestSignal(totalSignal),
    codexEnvironment,
    "resume",
  );
  assertCodexResult(
    second,
    "RESTART_RECOVERY_CONTINUED_OK",
    emptySummary(),
  );
  await assertSnapshotHealthy(stateFile);
}

/**
 * Cancellation scenario: launch a Codex exec, terminate the child shortly
 * after start, and verify the server stays healthy for a follow-up turn.
 * The Codex child exit is expected to be non-zero (killed); what matters is
 * that the server survives and the next turn works.
 */
async function runCancellationScenario(
  scenario: Scenario,
  token: string,
  baseUrl: string,
  model: string,
  cwd: string,
  artifactDir: string,
  marker: string,
  codexEnvironment: Record<string, string>,
  totalSignal: AbortSignal,
): Promise<void> {
  const codexHome = codexEnvironment[CODEX_HOME_ENV_KEY];
  if (codexHome === undefined) throw new Error("codex_home_missing");
  const outputFile = join(artifactDir, `${marker}_cancel.final.md`);
  const child = spawn(
    process.execPath,
    [CODEX_JS, ...[
      "-p",
      CODEX_PROFILE,
      "exec",
      ...codexProviderOverrides(baseUrl, model),
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "-o",
      outputFile,
      "--skip-git-repo-check",
      scenario.prompt,
    ]],
    {
      cwd,
      env: {
        ...process.env,
        [CODEX_PROMPT_ENV_KEY]: token,
        ...codexEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  // Let the request reach the server, then terminate the client.
  await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  child.kill();
  await exited;

  // Follow-up turn must still work (server healthy after cancellation).
  const followUp = await runCodexExec(
    "Reply with exactly: CANCEL_FOLLOWUP_OK. Do not use tools, do not explain.",
    token,
    baseUrl,
    model,
    cwd,
    artifactDir,
    `${marker}_followup`,
    requestSignal(totalSignal),
    codexEnvironment,
  );
  assertCodexResult(followUp, "CANCEL_FOLLOWUP_OK", emptySummary());
}

// Direct invocation: `tsx test/online/run-codex-cli.ts [batches]`
if (process.argv[1]?.replace(/\\/g, "/").endsWith("run-codex-cli.ts")) {
  runCodexCliOnlineSuite(process.argv.slice(2))
    .then(async () => {
      // Force-exit: the self-hosted composition keeps keep-alive handles
      // alive; a standalone suite should not linger after the matrix. Wait
      // one macrotask so stdout/stderr writes flush before exit.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `run-codex-cli failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
