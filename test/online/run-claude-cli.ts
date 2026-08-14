/**
 * Real Claude Code client -> Anthropic Messages -> Pi AI IR -> CommandCode.
 *
 * Run from `onlinetest/claude` with `npm test`. The suite self-hosts the
 * current LuckyToken code and generates an isolated project settings file.
 */
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLuckyTokenCliConfig } from "../../src/cli-config.js";
import { createFileClientTokenStore } from "../../src/client-auth/file-token-store.js";
import { createConfiguredLuckyTokenComposition } from "../../src/composition.js";
import type { LuckyTokenRuntime } from "../../src/runtime.js";
import { startLuckyTokenHttpServer } from "../../src/server.js";

const DEFAULT_MODEL = "commandcode-private/deepseek/deepseek-v4-flash";
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

interface CapturedRequest {
  readonly marker: string;
  readonly url: string;
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
        `Use the Bash tool to run: echo ${marker}. Then reply with exactly: ${marker}.`,
      expectedTool: "Bash",
    }),
    Object.freeze({
      id: "tool_write",
      prompt: (marker: string) =>
        `Use the Write tool to create claude_probe.txt containing exactly ${marker}. ` +
        `Then reply with exactly: ${marker}.`,
      expectedTool: "Write",
      expectedFile: Object.freeze({ path: "claude_probe.txt", content: "__MARKER__" }),
    }),
    Object.freeze({
      id: "multi_turn",
      prompt: (marker: string) =>
        `Remember the seed ${marker}_SEED. Reply with exactly: ${marker}_TURN1. ` +
        "Do not use tools or explain.",
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
        `Use the Read tool to read read_probe.txt, then reply with exactly its content: ${marker}.`,
      expectedTool: "Read",
      initialFiles: Object.freeze([
        Object.freeze({ path: "read_probe.txt", content: "__MARKER__\n" }),
      ]),
    }),
    Object.freeze({
      id: "tool_edit",
      prompt: (marker: string) =>
        `Use the Edit tool to replace BEFORE in edit_probe.txt with ${marker}. ` +
        `Then reply with exactly: ${marker}.`,
      expectedTool: "Edit",
      initialFiles: Object.freeze([
        Object.freeze({ path: "edit_probe.txt", content: "BEFORE\n" }),
      ]),
      expectedFile: Object.freeze({ path: "edit_probe.txt", content: "__MARKER__" }),
    }),
    Object.freeze({
      id: "tool_grep",
      prompt: (marker: string) =>
        `Use the Grep tool to search for ${marker} in grep_probe.txt. ` +
        `Then reply with exactly: ${marker}. Do not use Bash.`,
      expectedTool: "Grep",
      initialFiles: Object.freeze([
        Object.freeze({ path: "grep_probe.txt", content: "prefix __MARKER__ suffix\n" }),
      ]),
    }),
    Object.freeze({
      id: "tool_glob",
      prompt: (marker: string) =>
        `Use the Glob tool with pattern **/glob_probe.txt. After it finds the file, ` +
        `reply with exactly: ${marker}. Do not use Bash.`,
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
        `The failure is expected; do not retry. Then reply with exactly: ${marker}.`,
      expectedTool: "Bash",
      expectedToolError: true,
    }),
    Object.freeze({
      id: "tool_unicode",
      prompt: (marker: string) =>
        "Use the Bash tool to run `printf 'UNICODE_汉字_🙂_OK\\n'`. " +
        `Then reply with exactly: ${marker}.`,
      expectedTool: "Bash",
      expectedToolResultText: "UNICODE_汉字_🙂_OK",
    }),
    Object.freeze({
      id: "parallel_tools",
      prompt: (marker: string) =>
        "In one assistant response, issue two separate Bash tool calls in parallel. " +
        "The first must run `printf 'PARALLEL_A_OK\\n'`; the second must run " +
        "`printf 'PARALLEL_B_OK\\n'`. Do not combine the commands. After both results, " +
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
  runtime: LuckyTokenRuntime,
  captures: CapturedRequest[],
  marker: () => string,
): LuckyTokenRuntime {
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
      captures.push(Object.freeze({ marker: marker(), url: request.url, body }));
      return runtime.handle(request);
    },
  });
}

async function writeClaudeSettings(origin: string, token: string): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(
    SETTINGS_PATH,
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: origin,
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_MODEL: DEFAULT_MODEL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_MODEL,
          ANTHROPIC_DEFAULT_SONNET_MODEL: DEFAULT_MODEL,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_MODEL,
          CLAUDE_CODE_SUBAGENT_MODEL: DEFAULT_MODEL,
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        model: DEFAULT_MODEL,
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
    DEFAULT_MODEL,
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
  if (record.model !== DEFAULT_MODEL) throw new Error("claude_model_mismatch");
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
  const batches = args.length === 0 ? 1 : Number(args[0]);
  if (!Number.isSafeInteger(batches) || batches < 1) {
    throw new Error("batches must be a positive integer");
  }
  const requestedScenarios = new Set(args.slice(1));
  const scenarioPlan = scenarios().filter(
    (scenario) => requestedScenarios.size === 0 || requestedScenarios.has(scenario.id),
  );
  if (scenarioPlan.length === 0) throw new Error("no matching Claude scenarios");
  const apiKey = (
    await readFile(join(REPOSITORY_ROOT, "CommandcodeAPIKey.txt"), "utf8")
  ).trim();
  if (apiKey.length === 0) throw new Error("CommandCode API key file is empty");

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runRoot = join(ONLINE_ROOT, ".runs", runId);
  const stateDirectory = join(runRoot, ".luckytoken");
  const configDirectory = join(runRoot, "claude-home");
  const workspace = join(runRoot, "workspace");
  await mkdir(join(stateDirectory, "pi"), { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const clientToken = randomUUID();
  const authFile = join(stateDirectory, "client-auth", "anthropic-messages.json");
  await createFileClientTokenStore({ path: authFile }).create(
    { type: "global" },
    clientToken,
  );
  const configPath = join(stateDirectory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0 },
      clientProtocols: {
        "anthropic-messages": { authFile: "client-auth/anthropic-messages.json" },
      },
      providerPackages: {
        "@luckytoken/provider-commandcode-private": {},
      },
      pi: { directory: "pi" },
      limits: { maxRequestBytes: 1_048_576, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    }),
    "utf8",
  );
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("commandcode-private", async () => ({
    type: "api_key",
    key: apiKey,
  }));
  const config = await loadLuckyTokenCliConfig(configPath);
  const composition = await createConfiguredLuckyTokenComposition({
    config,
    credentials,
    fetch: globalThis.fetch,
  });
  const captures: CapturedRequest[] = [];
  let marker = "bootstrap";
  const runtime = captureRuntime(composition.runtime, captures, () => marker);
  const server = await startLuckyTokenHttpServer({
    runtime,
    host: config.server.host,
    port: config.server.port,
  });
  try {
    await writeClaudeSettings(server.origin, clientToken);
    const matrix: Array<{
      id: string;
      status: "pass" | "fail";
      ms: number;
      error?: string;
    }> = [];
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
              scenarioWorkspace,
              configDirectory,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            );
            assertClaudeResult(
              followup,
              followupMarker,
              captures.filter((capture) => capture.marker === followupMarker),
              scenario,
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
          );
          if (scenario.special === "multi_turn") {
            const resumed = await runClaude(
              `Recall the seed from the previous turn and reply with exactly: ${marker}_SEED. ` +
                "Do not use tools or explain.",
              sessionId,
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
    process.stdout.write(
      `${JSON.stringify({ model: DEFAULT_MODEL, runRoot, batches, matrix }, null, 2)}\n`,
    );
    if (matrix.some((entry) => entry.status === "fail")) process.exitCode = 1;
  } finally {
    await server.close();
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
