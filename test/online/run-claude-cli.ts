/**
 * Real Claude Code client -> Anthropic Messages -> Pi AI IR -> CommandCode.
 *
 * Run from `onlinetest/claude` with `npm test`. The suite self-hosts the
 * current Token code and generates an isolated project settings file.
 */
import {
  InMemoryCredentialStore,
  type AuthInteraction,
  type AuthPrompt,
} from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "../../src/data-plane-limits.js";
import {
  createOnlinePublicModelAuthority,
  reconcileOnlinePublicModels,
} from "./public-model-fixture.js";
import {
  createConfiguredTokenDataPlane,
  createConfiguredPiModels,
} from "../support/configured-data-plane.js";
import type { TokenRuntime } from "../../src/runtime.js";
import { startTokenHttpServer } from "../../src/server.js";

const DEFAULT_MODEL = "commandcode-private/deepseek/deepseek-v4-flash";
const DEFAULT_PROVIDER_ID = "commandcode-private";
const DEFAULT_API_KEY_FILE = "CommandcodeAPIKey.txt";
const REQUEST_TIMEOUT_MS = 240_000;
const CLAUDE_EXE = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe",
);
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ONLINE_ROOT = join(REPOSITORY_ROOT, "onlinetest", "claude");
const SETTINGS_PATH = join(ONLINE_ROOT, ".claude", "settings.json");

interface ClaudeOnlineArguments {
  readonly providerId: string;
  readonly model: string;
  readonly apiKeyFile: string;
  readonly alias: string | undefined;
  readonly batches: number;
  readonly requestedScenarios: readonly string[];
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

function parseClaudeArguments(
  args: readonly string[],
): ClaudeOnlineArguments {
  let providerId = DEFAULT_PROVIDER_ID;
  let model = DEFAULT_MODEL;
  let apiKeyFile = DEFAULT_API_KEY_FILE;
  let alias: string | undefined;
  let batches = 1;
  const requestedScenarios: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
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
    if (argument === "--batches") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("--batches must be a positive integer");
      }
      batches = value;
      index += 1;
      continue;
    }
    const positional = Number(argument);
    if (!Number.isNaN(positional)) {
      if (!Number.isSafeInteger(positional) || positional < 1) {
        throw new Error("batches must be a positive integer");
      }
      batches = positional;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown claude online option: ${argument}`);
    }
    requestedScenarios.push(argument);
  }
  return { providerId, model, apiKeyFile, alias, batches, requestedScenarios };
}

interface CapturedRequest {
  readonly marker: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface ClaudeResult {
  readonly exitCode: number | null;
  readonly events: readonly Record<string, unknown>[];
  readonly stderr: string;
}

async function writeScenarioArtifact(
  runRoot: string,
  marker: string,
  result: ClaudeResult,
  captures: readonly CapturedRequest[],
): Promise<void> {
  const artifactDirectory = join(runRoot, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    join(artifactDirectory, `${marker}.json`),
    JSON.stringify({ result, requests: captures }, null, 2),
    "utf8",
  );
}

interface ClaudeScenario {
  readonly id: string;
  readonly prompt: (marker: string) => string;
  readonly expectedTool?: string;
  readonly expectedFile?: Readonly<{ path: string; content: string }>;
  readonly special?: "multi_turn" | "cancel";
  readonly initialFiles?: readonly Readonly<{ path: string; content: string }>[];
  readonly expectedToolError?: boolean;
  readonly expectedToolResultText?: string;
  readonly minimumParallelToolUses?: number;
  readonly minimumResultChars?: number;
  readonly extraArgs?: (marker: string) => readonly string[];
  readonly expectedSystemText?: (marker: string) => string;
  readonly expectedEffort?: string;
  readonly expectedStructuredOutput?: boolean;
  readonly forbidToolUse?: boolean;
}

type ClaudeContinuityCarrierCapability =
  | "native-fields-only"
  | "item-extension-v1";

const CONTINUITY_CAPABILITY_SCENARIO = "continuity_carrier";

function continuityProbeEnvelope(marker: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: 1,
    source: Object.freeze({
      provider: "claude-cli-capability-probe",
      api: "pi-messages",
      model: "probe",
    }),
    attachments: Object.freeze([
      Object.freeze({
        target: "text",
        kind: "opaque-signature",
        value: `CLAUDE_CONTINUITY_${marker}`,
      }),
    ]),
  });
}

export async function injectClaudeContinuityProbe(
  response: Response,
  marker: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const source = await response.text();
  let injected = false;
  let body = source;
  if (contentType.includes("text/event-stream")) {
    body = source
      .split(/(?<=\n)/u)
      .map((line) => {
        const match = /^(data:\s*)([^\r\n]+)(\r?\n)?$/u.exec(line);
        if (injected || match === null || match[2] === "[DONE]") return line;
        let event: unknown;
        try {
          event = JSON.parse(match[2] as string);
        } catch {
          return line;
        }
        if (
          typeof event !== "object" ||
          event === null ||
          (event as { type?: unknown }).type !== "content_block_start"
        ) {
          return line;
        }
        const contentBlock = (event as { content_block?: unknown }).content_block;
        if (
          typeof contentBlock !== "object" ||
          contentBlock === null ||
          (contentBlock as { type?: unknown }).type !== "text"
        ) {
          return line;
        }
        injected = true;
        const projected = {
          ...(event as Record<string, unknown>),
          content_block: {
            ...(contentBlock as Record<string, unknown>),
            token_continuity: continuityProbeEnvelope(marker),
          },
        };
        return `${match[1]}${JSON.stringify(projected)}${match[3] ?? ""}`;
      })
      .join("");
  } else if (contentType.includes("application/json")) {
    const message = JSON.parse(source) as Record<string, unknown>;
    if (Array.isArray(message.content)) {
      message.content = message.content.map((block) => {
        if (
          injected ||
          typeof block !== "object" ||
          block === null ||
          (block as { type?: unknown }).type !== "text"
        ) {
          return block;
        }
        injected = true;
        return {
          ...(block as Record<string, unknown>),
          token_continuity: continuityProbeEnvelope(marker),
        };
      });
    }
    body = JSON.stringify(message);
  }
  if (!injected) {
    throw new Error("claude_continuity_probe_response_has_no_text_block");
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function scenarios(): readonly ClaudeScenario[] {
  return Object.freeze([
    Object.freeze({
      id: "basic",
      prompt: (marker: string) =>
        `Reply with exactly: ${marker}. Do not use tools or explain.`,
      forbidToolUse: true,
    }),
    Object.freeze({
      id: "tool_bash",
      prompt: (marker: string) =>
        `Use the Bash tool exactly once to run: echo ${marker}. Do not plan, delegate, ` +
        `inspect unrelated files, or use another tool. Then immediately reply with exactly: ${marker}.`,
      expectedTool: "Bash",
    }),
    Object.freeze({
      id: "tool_write",
      prompt: (marker: string) =>
        `Use only the Write tool to create claude_probe.txt containing exactly ${marker}. ` +
        `Do not plan, delegate, inspect unrelated files, or use another tool. ` +
        `Then immediately reply with exactly: ${marker}.`,
      expectedTool: "Write",
      expectedFile: Object.freeze({ path: "claude_probe.txt", content: "__MARKER__" }),
    }),
    Object.freeze({
      id: "multi_turn",
      prompt: (marker: string) =>
        `Remember the seed ${marker}_SEED. Immediately reply with exactly: ${marker}_TURN1. ` +
        "Do not plan, delegate, use tools, inspect unrelated files, or explain.",
      special: "multi_turn",
    }),
    Object.freeze({
      id: CONTINUITY_CAPABILITY_SCENARIO,
      prompt: (marker: string) =>
        `Remember the seed ${marker}_SEED. Immediately reply with exactly: ${marker}_TURN1. ` +
        "Do not plan, delegate, use tools, inspect unrelated files, or explain.",
      special: "multi_turn",
    }),
    Object.freeze({
      id: "multi_turn_tool",
      prompt: (marker: string) =>
        `Remember the seed ${marker}_SEED. Use the Write tool to create ` +
        `multi_turn_probe.txt containing exactly ${marker}. Then reply with exactly: ` +
        `${marker}_TURN1.`,
      expectedTool: "Write",
      expectedFile: Object.freeze({
        path: "multi_turn_probe.txt",
        content: "__MARKER__",
      }),
      special: "multi_turn",
    }),
    Object.freeze({
      id: "tool_read",
      prompt: (marker: string) =>
        `Use only the Read tool to read read_probe.txt. Do not plan, delegate, inspect ` +
        `anything else, or use another tool. Then immediately reply with exactly: ${marker}.`,
      expectedTool: "Read",
      initialFiles: Object.freeze([
        Object.freeze({ path: "read_probe.txt", content: "__MARKER__\n" }),
      ]),
    }),
    Object.freeze({
      id: "tool_edit",
      prompt: (marker: string) =>
        `Use only the Edit tool to replace BEFORE in edit_probe.txt with ${marker}. ` +
        `Do not plan, delegate, inspect unrelated files, or use another tool. ` +
        `Then immediately reply with exactly: ${marker}.`,
      expectedTool: "Edit",
      initialFiles: Object.freeze([
        Object.freeze({ path: "edit_probe.txt", content: "BEFORE\n" }),
      ]),
      expectedFile: Object.freeze({ path: "edit_probe.txt", content: "__MARKER__" }),
    }),
    Object.freeze({
      id: "tool_grep",
      prompt: (marker: string) =>
        `Use only the Grep tool to search for ${marker} in grep_probe.txt. ` +
        `Do not plan, delegate, inspect unrelated files, or use Bash/another tool. ` +
        `Then immediately reply with exactly: ${marker}.`,
      expectedTool: "Grep",
      initialFiles: Object.freeze([
        Object.freeze({ path: "grep_probe.txt", content: "prefix __MARKER__ suffix\n" }),
      ]),
    }),
    Object.freeze({
      id: "tool_glob",
      prompt: (marker: string) =>
        `Use only the Glob tool with pattern **/glob_probe.txt. Do not plan, delegate, ` +
        `inspect unrelated files, or use Bash/another tool. After it finds the file, ` +
        `immediately reply with exactly: ${marker}.`,
      expectedTool: "Glob",
      initialFiles: Object.freeze([
        Object.freeze({ path: "glob_probe.txt", content: "__MARKER__\n" }),
      ]),
    }),
    Object.freeze({
      id: "tool_error",
      prompt: (marker: string) =>
        "Use the Bash tool once to run " +
        '`powershell -NoProfile -Command "Write-Error EXPECTED_TOOL_FAILURE; exit 7"`. ' +
        `The failure is expected; do not retry, plan, delegate, inspect unrelated files, ` +
        `or use another tool. Then immediately reply with exactly: ${marker}.`,
      expectedTool: "Bash",
      expectedToolError: true,
    }),
    Object.freeze({
      id: "tool_unicode",
      prompt: (marker: string) =>
        "Use the Bash tool exactly once to run `printf 'UNICODE_汉字_🙂_OK\\n'`. " +
        `Do not plan, delegate, inspect unrelated files, or use another tool. ` +
        `Then immediately reply with exactly: ${marker}.`,
      expectedTool: "Bash",
      expectedToolResultText: "UNICODE_汉字_🙂_OK",
    }),
    Object.freeze({
      id: "parallel_tools",
      prompt: (marker: string) =>
        "In one assistant response, issue two separate Bash tool calls in parallel. " +
        "The first must run `printf 'PARALLEL_A_OK\\n'`; the second must run " +
        "`printf 'PARALLEL_B_OK\\n'`. Do not combine the commands, plan, delegate, inspect " +
        "unrelated files, or use another tool. After both results, immediately " +
        `reply with exactly: ${marker}.`,
      expectedTool: "Bash",
      minimumParallelToolUses: 2,
    }),
    Object.freeze({
      id: "long_text",
      prompt: (marker: string) =>
        "Write at least 180 English words about protocol conversion, without tools. " +
        `End with the exact token ${marker}.`,
      minimumResultChars: 900,
    }),
    Object.freeze({
      id: "append_system",
      prompt: (marker: string) =>
        `Follow the appended system instruction and reply with exactly: ${marker}.`,
      extraArgs: (marker: string) =>
        Object.freeze([
          "--append-system-prompt",
          `SYSTEM_PROBE_${marker}`,
        ]),
      expectedSystemText: (marker: string) => `SYSTEM_PROBE_${marker}`,
    }),
    Object.freeze({
      id: "thinking_effort",
      prompt: (marker: string) =>
        `Think carefully, then reply with exactly: ${marker}. Do not use tools.`,
      extraArgs: () => Object.freeze(["--effort", "max"]),
      expectedEffort: "max",
    }),
    Object.freeze({
      id: "json_schema",
      prompt: (marker: string) =>
        `Return an object whose marker property is exactly ${marker}. Do not use tools.`,
      extraArgs: () =>
        Object.freeze([
          "--json-schema",
          JSON.stringify({
            type: "object",
            properties: { marker: { type: "string" } },
            required: ["marker"],
            additionalProperties: false,
          }),
        ]),
      expectedStructuredOutput: true,
    }),
    Object.freeze({
      id: "cancel",
      prompt: () =>
        "Write at least 5000 words about transport protocols. Do not use tools.",
      special: "cancel",
    }),
  ]);
}

function captureRuntime(
  runtime: TokenRuntime,
  captures: CapturedRequest[],
  marker: () => string,
): TokenRuntime {
  const continuityInjected = new Set<string>();
  return Object.freeze({
    routes: runtime.routes,
    async handle(request: Request): Promise<Response> {
      const bodyText = await request.clone().text();
      let body: unknown = bodyText;
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Keep the raw body so a malformed real-client request remains visible.
      }
      const requestHeaders = Object.fromEntries(
        [...request.headers.entries()].map(([name, value]) => [
          name,
          /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/iu.test(
            name,
          ) || /(?:^|-)account-id$|(?:^|-)api-key$|(?:^|-)auth-token$/iu.test(name)
            ? "[REDACTED]"
            : value,
        ]),
      );
      captures.push(
        Object.freeze({ marker: marker(), url: request.url, requestHeaders, body }),
      );
      const response = await runtime.handle(request);
      const currentMarker = marker();
      if (
        currentMarker.startsWith("CLAUDE_CONTINUITY_CARRIER_") &&
        !continuityInjected.has(currentMarker) &&
        new URL(request.url).pathname.endsWith("/v1/messages") &&
        response.ok
      ) {
        continuityInjected.add(currentMarker);
        return injectClaudeContinuityProbe(response, currentMarker);
      }
      return response;
    },
  });
}

async function writeClaudeSettings(
  origin: string,
  token: string,
  model: string,
): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(
    SETTINGS_PATH,
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: origin,
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          CLAUDE_CODE_SUBAGENT_MODEL: model,
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        model,
        permissions: { defaultMode: "bypassPermissions" },
        enabledPlugins: {},
        skipDangerousModePermissionPrompt: true,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function runClaude(
  prompt: string,
  sessionId: string,
  model: string,
  cwd: string,
  configDirectory: string,
  signal: AbortSignal,
  mode: "new" | "resume" = "new",
  extraArgs: readonly string[] = [],
): Promise<ClaudeResult> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    ...(mode === "new" ? ["--session-id", sessionId] : ["--resume", sessionId]),
    "--settings",
    SETTINGS_PATH,
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-chrome",
    "--dangerously-skip-permissions",
    ...extraArgs,
  ];
  const child = spawn(CLAUDE_EXE, args, {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", resolvePromise);
  }).finally(() => signal.removeEventListener("abort", abort));
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/gu)) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A killed child may leave one partial trailing JSONL record.
    }
  }
  return Object.freeze({ exitCode, events: Object.freeze(events), stderr });
}

async function waitForCapturedMessagesRequest(
  captures: readonly CapturedRequest[],
  marker: string,
  signal: AbortSignal,
): Promise<void> {
  while (
    !captures.some(
      (capture) =>
        capture.marker === marker &&
        new URL(capture.url).pathname.endsWith("/v1/messages"),
    )
  ) {
    signal.throwIfAborted();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function assertClaudeResult(
  result: ClaudeResult,
  marker: string,
  captures: readonly CapturedRequest[],
  scenario: ClaudeScenario,
  model: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`claude_exit_${result.exitCode ?? "null"}: ${result.stderr}`);
  }
  const terminal = result.events.find((event) => event.type === "result");
  if (terminal?.subtype !== "success") throw new Error("claude_no_success_result");
  if (typeof terminal.result !== "string" || !terminal.result.includes(marker)) {
    throw new Error("claude_expected_text_missing");
  }
  if (
    scenario.minimumResultChars !== undefined &&
    terminal.result.length < scenario.minimumResultChars
  ) {
    throw new Error("claude_result_too_short");
  }
  const messagesRequests = captures.filter((capture) =>
    new URL(capture.url).pathname.endsWith("/v1/messages"),
  );
  if (messagesRequests.length === 0) throw new Error("claude_no_messages_request");
  const body = messagesRequests.at(-1)?.body;
  if (typeof body !== "object" || body === null) {
    throw new Error("claude_invalid_messages_body");
  }
  const record = body as {
    model?: unknown;
    stream?: unknown;
    system?: unknown;
    messages?: unknown;
  };
  if (record.model !== model) throw new Error("claude_model_mismatch");
  if (record.stream !== true) throw new Error("claude_not_streaming");
  if (!Array.isArray(record.system) || record.system.length === 0) {
    throw new Error("claude_system_missing");
  }
  const expectedSystemText = scenario.expectedSystemText?.(marker);
  if (
    expectedSystemText !== undefined &&
    !JSON.stringify(record.system).includes(expectedSystemText)
  ) {
    throw new Error("claude_appended_system_missing");
  }
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    throw new Error("claude_messages_missing");
  }
  if (
    scenario.forbidToolUse === true &&
    JSON.stringify(record.messages).includes('"type":"tool_use"')
  ) {
    throw new Error("claude_unexpected_tool_use");
  }
  if (scenario.expectedEffort !== undefined) {
    const thinking = (body as { thinking?: unknown }).thinking;
    const outputConfig = (body as { output_config?: unknown }).output_config;
    if (
      typeof thinking !== "object" ||
      thinking === null ||
      (thinking as { type?: unknown }).type !== "adaptive"
    ) {
      throw new Error("claude_adaptive_thinking_missing");
    }
    if (
      typeof outputConfig !== "object" ||
      outputConfig === null ||
      (outputConfig as { effort?: unknown }).effort !== scenario.expectedEffort
    ) {
      throw new Error("claude_effort_mismatch");
    }
  }
  if (scenario.expectedStructuredOutput === true) {
    const tools = (body as { tools?: unknown }).tools;
    const structuredOutput = Array.isArray(tools)
      ? tools.find(
          (tool) =>
            typeof tool === "object" &&
            tool !== null &&
            (tool as { name?: unknown }).name === "StructuredOutput",
        )
      : undefined;
    const inputSchema =
      typeof structuredOutput === "object" && structuredOutput !== null
        ? (structuredOutput as { input_schema?: unknown }).input_schema
        : undefined;
    if (
      typeof inputSchema !== "object" ||
      inputSchema === null ||
      (inputSchema as { additionalProperties?: unknown }).additionalProperties !== false
    ) {
      throw new Error("claude_structured_output_tool_missing");
    }
    const structuredResult = terminal.structured_output;
    if (
      typeof structuredResult !== "object" ||
      structuredResult === null ||
      (structuredResult as { marker?: unknown }).marker !== marker
    ) {
      throw new Error("claude_structured_output_result_missing");
    }
  }
  if (scenario.expectedTool !== undefined) {
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    const errorResultIds = new Set<string>();
    const toolResultBodies: string[] = [];
    let maximumParallelToolUses = 0;
    for (const request of messagesRequests) {
      if (typeof request.body !== "object" || request.body === null) continue;
      const messages = (request.body as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (typeof message !== "object" || message === null) continue;
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        let matchingToolUses = 0;
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const item = block as {
            type?: unknown;
            name?: unknown;
            id?: unknown;
            tool_use_id?: unknown;
            is_error?: unknown;
          };
          if (
            item.type === "tool_use" &&
            item.name === scenario.expectedTool &&
            typeof item.id === "string"
          ) {
            toolUseIds.add(item.id);
            matchingToolUses += 1;
          }
          if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
            toolResultIds.add(item.tool_use_id);
            if (item.is_error === true) errorResultIds.add(item.tool_use_id);
            toolResultBodies.push(JSON.stringify(item));
          }
        }
        maximumParallelToolUses = Math.max(
          maximumParallelToolUses,
          matchingToolUses,
        );
      }
    }
    if (![...toolUseIds].some((id) => toolResultIds.has(id))) {
      throw new Error("claude_tool_round_trip_missing");
    }
    if (
      scenario.expectedToolError === true &&
      ![...toolUseIds].some((id) => errorResultIds.has(id))
    ) {
      throw new Error("claude_error_tool_result_missing");
    }
    if (
      scenario.expectedToolResultText !== undefined &&
      !toolResultBodies.some((body) => body.includes(scenario.expectedToolResultText!))
    ) {
      throw new Error("claude_tool_result_text_missing");
    }
    if (
      scenario.minimumParallelToolUses !== undefined &&
      maximumParallelToolUses < scenario.minimumParallelToolUses
    ) {
      throw new Error("claude_parallel_tool_uses_missing");
    }
  }
}

export async function runClaudeCliOnlineSuite(args: readonly string[]): Promise<void> {
  const {
    providerId,
    model,
    apiKeyFile,
    alias,
    batches,
    requestedScenarios: requestedList,
  } = parseClaudeArguments(args);
  const selector = alias ?? model;
  const requestedScenarios = new Set(requestedList);
  const selectedScenarios = scenarios().filter(
    (scenario) => requestedScenarios.size === 0 || requestedScenarios.has(scenario.id),
  );
  if (selectedScenarios.length === 0) throw new Error("no matching Claude scenarios");
  const continuityScenario = scenarios().find(
    (scenario) => scenario.id === CONTINUITY_CAPABILITY_SCENARIO,
  );
  if (continuityScenario === undefined) {
    throw new Error("Claude continuity capability scenario is not registered");
  }
  const scenarioPlan = selectedScenarios.some(
    (scenario) => scenario.id === CONTINUITY_CAPABILITY_SCENARIO,
  )
    ? selectedScenarios
    : [...selectedScenarios, continuityScenario];
  const apiKey = (
    await readFile(
      apiKeyFile.includes("\\") || apiKeyFile.includes("/")
        ? apiKeyFile
        : join(REPOSITORY_ROOT, apiKeyFile),
      "utf8",
    )
  ).trim();
  if (apiKey.length === 0) throw new Error(`${apiKeyFile} is empty`);

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runRoot = join(ONLINE_ROOT, ".runs", runId);
  const stateDirectory = join(runRoot, ".Token");
  const configDirectory = join(runRoot, "claude-home");
  const workspace = join(runRoot, "workspace");
  await mkdir(join(stateDirectory, "pi"), { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const localSdkCredential = "unused-local-client-key";
  const configPath = join(stateDirectory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "token-config-v2",
      server: { port: 0 },
      clientProtocols: {
        "anthropic-messages": {},
      },
      providerPackages: {},
      pi: { directory: "pi" },
      limits: { maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    }),
    "utf8",
  );
  const config = await loadTokenCliConfig(configPath);
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
    credentialSeedStore: credentials,
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
  const composition = await createConfiguredTokenDataPlane({
    config,
    credentialSeedStore: credentials,
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
  const captures: CapturedRequest[] = [];
  let marker = "bootstrap";
  const runtime = captureRuntime(composition.runtime, captures, () => marker);
  const server = await startTokenHttpServer({
    runtime,
    host: "127.0.0.1",
    port: config.server.port,
  });
  try {
    await writeClaudeSettings(server.origin, localSdkCredential, selector);
    const matrix: Array<{
      id: string;
      status: "pass" | "fail";
      ms: number;
      error?: string;
    }> = [];
    let continuityCarrierCapability: ClaudeContinuityCarrierCapability | undefined;
    for (let batch = 1; batch <= batches; batch += 1) {
      for (const scenario of scenarioPlan) {
        marker = `CLAUDE_${scenario.id.toUpperCase()}_${batch}_OK`;
        const scenarioWorkspace = join(workspace, marker);
        await mkdir(scenarioWorkspace, { recursive: true });
        for (const initialFile of scenario.initialFiles ?? []) {
          await writeFile(
            join(scenarioWorkspace, initialFile.path),
            initialFile.content.replace("__MARKER__", marker),
            "utf8",
          );
        }
        const startedAt = performance.now();
        process.stderr.write(`[claude-suite] start ${marker}\n`);
        try {
          const sessionId = randomUUID();
          if (scenario.special === "cancel") {
            const cancellation = new AbortController();
            const cancelledResult = runClaude(
              scenario.prompt(marker),
              sessionId,
              selector,
              scenarioWorkspace,
              configDirectory,
              cancellation.signal,
            );
            await waitForCapturedMessagesRequest(
              captures,
              marker,
              AbortSignal.timeout(30_000),
            );
            cancellation.abort(new Error("intentional Claude online cancellation"));
            const cancelled = await cancelledResult;
            await writeScenarioArtifact(
              runRoot,
              marker,
              cancelled,
              captures.filter((capture) => capture.marker === marker),
            );
            if (
              cancelled.events.some(
                (event) => event.type === "result" && event.subtype === "success",
              )
            ) {
              throw new Error("claude_cancel_unexpected_success");
            }
            const followupMarker = `${marker}_FOLLOWUP`;
            marker = followupMarker;
            const followup = await runClaude(
              `Reply with exactly: ${followupMarker}. Do not use tools.`,
              randomUUID(),
              selector,
              scenarioWorkspace,
              configDirectory,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            );
            assertClaudeResult(
              followup,
              followupMarker,
              captures.filter((capture) => capture.marker === followupMarker),
              scenario,
              selector,
            );
            matrix.push({
              id: scenario.id,
              status: "pass",
              ms: Math.round(performance.now() - startedAt),
            });
            continue;
          }
          const result = await runClaude(
            scenario.prompt(marker),
            sessionId,
            selector,
            scenarioWorkspace,
            configDirectory,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            "new",
            scenario.extraArgs?.(marker) ?? [],
          );
          await writeScenarioArtifact(
            runRoot,
            marker,
            result,
            captures.filter((capture) => capture.marker === marker),
          );
          assertClaudeResult(
            result,
            marker,
            captures.filter((capture) => capture.marker === marker),
            scenario,
            selector,
          );
          if (scenario.special === "multi_turn") {
            const resumed = await runClaude(
              `Recall the seed from the previous turn and reply with exactly: ${marker}_SEED. ` +
                "Do not use tools or explain.",
              sessionId,
              selector,
              scenarioWorkspace,
              configDirectory,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              "resume",
              scenario.extraArgs?.(marker) ?? [],
            );
            await writeScenarioArtifact(
              runRoot,
              `${marker}_RESUME`,
              resumed,
              captures.filter((capture) => capture.marker === marker),
            );
            assertClaudeResult(
              resumed,
              `${marker}_SEED`,
              captures.filter((capture) => capture.marker === marker),
              scenario,
              selector,
            );
            const latestBody = captures
              .filter(
                (capture) =>
                  capture.marker === marker &&
                  new URL(capture.url).pathname.endsWith("/v1/messages"),
              )
              .at(-1)?.body;
            const serialized = JSON.stringify(latestBody);
            if (
              !serialized.includes(`${marker}_TURN1`) ||
              !serialized.includes(`${marker}_SEED`)
            ) {
              throw new Error("claude_resume_history_missing");
            }
            if (scenario.id === CONTINUITY_CAPABILITY_SCENARIO) {
              const observed: ClaudeContinuityCarrierCapability = serialized.includes(
                `CLAUDE_CONTINUITY_${marker}`,
              )
                ? "item-extension-v1"
                : "native-fields-only";
              if (
                continuityCarrierCapability !== undefined &&
                continuityCarrierCapability !== observed
              ) {
                throw new Error("claude_continuity_capability_changed_within_run");
              }
              continuityCarrierCapability = observed;
            }
          }
          if (scenario.expectedFile !== undefined) {
            const actual = await readFile(
              join(scenarioWorkspace, scenario.expectedFile.path),
              "utf8",
            );
            const expected = scenario.expectedFile.content.replace("__MARKER__", marker);
            if (actual.trim() !== expected) {
              throw new Error("claude_file_content_mismatch");
            }
          }
          matrix.push({
            id: scenario.id,
            status: "pass",
            ms: Math.round(performance.now() - startedAt),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[claude-suite] fail ${marker}: ${message}\n`);
          matrix.push({
            id: scenario.id,
            status: "fail",
            ms: Math.round(performance.now() - startedAt),
            error: message.slice(0, 512),
          });
        }
      }
    }
    if (continuityCarrierCapability === undefined) {
      throw new Error("claude_continuity_capability_not_observed");
    }
    process.stdout.write(
      `${JSON.stringify({
        model: DEFAULT_MODEL,
        runRoot,
        batches,
        continuityCarrierCapability,
        matrix,
      }, null, 2)}\n`,
    );
    if (matrix.some((entry) => entry.status === "fail")) process.exitCode = 1;
  } finally {
    await server.close();
    await composition.close();
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void runClaudeCliOnlineSuite(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `run-claude-cli failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
