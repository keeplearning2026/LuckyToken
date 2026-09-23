import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { normalizeNativeResponsesSse } from "../../src/protocols/openai-responses/native-sse-lifecycle-normalizer.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const root = await mkdtemp(join(tmpdir(), "Token-next-request-ab-"));
const cli = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);

const FORBIDDEN = [
  "OutputTextDelta without active item",
  "ReasoningSummaryDelta without active item",
  "ReasoningSummaryPartAdded without active item",
  "ReasoningRawContentDelta without active item",
] as const;

const firstCallId = "call_tool_a";
const secondCallId = "call_tool_b";
const firstItemId = "fc_tool_a";
const secondItemId = "fc_tool_b";
const firstArguments = JSON.stringify({ cmd: "Write-Output TOOL_A" });
const secondArguments = JSON.stringify({ cmd: "Write-Output TOOL_B" });

const firstCall = {
  type: "function_call",
  id: firstItemId,
  call_id: firstCallId,
  name: "exec_command",
  arguments: firstArguments,
  status: "completed",
};
const secondCall = {
  type: "function_call",
  id: secondItemId,
  call_id: secondCallId,
  name: "exec_command",
  arguments: secondArguments,
  status: "completed",
};

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map(
      (event, sequence_number) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify({
          ...event,
          sequence_number,
        })}\n\n`,
    )
    .join("");
}

const rawFirstWire = sse([
  {
    type: "response.created",
    response: { id: "resp_tools_1", status: "in_progress", model: "gpt-native" },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...firstCall, arguments: "", status: "in_progress" },
  },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { ...secondCall, arguments: "", status: "in_progress" },
  },
  {
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: secondItemId,
    delta: secondArguments,
  },
  {
    type: "response.function_call_arguments.done",
    output_index: 1,
    item_id: secondItemId,
    arguments: secondArguments,
  },
  {
    type: "response.output_item.done",
    output_index: 1,
    item: secondCall,
  },
  {
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: firstItemId,
    delta: firstArguments,
  },
  {
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: firstItemId,
    arguments: firstArguments,
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: firstCall,
  },
  {
    type: "response.completed",
    response: {
      id: "resp_tools_1",
      object: "response",
      status: "completed",
      model: "gpt-native",
      output: [firstCall, secondCall],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    },
  },
]);

const normalized = normalizeNativeResponsesSse(encoder.encode(rawFirstWire));
assert.equal(normalized.kind, "normalized");
const normalizedFirstWire = decoder.decode(normalized.body);

const finalItem = {
  type: "message",
  id: "msg_tool_final",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "TOOLS_HISTORY_OK", annotations: [] }],
};
const secondWire = sse([
  {
    type: "response.created",
    response: { id: "resp_tools_2", status: "in_progress", model: "gpt-native" },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "message",
      id: "msg_tool_final",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  },
  {
    type: "response.output_text.delta",
    output_index: 0,
    item_id: "msg_tool_final",
    content_index: 0,
    delta: "TOOLS_HISTORY_OK",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: finalItem,
  },
  {
    type: "response.completed",
    response: {
      id: "resp_tools_2",
      object: "response",
      status: "completed",
      model: "gpt-native",
      output: [finalItem],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  },
]);

function runCodex(
  args: readonly string[],
  cwd: string,
  codexHome: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: "local-next-request-ab-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), 45_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

interface CapturedRequest {
  readonly input?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

function summarizeInput(body: CapturedRequest | undefined) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.map((item) => {
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type === "function_call") {
      return {
        type,
        id: item.id,
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      };
    }
    if (type === "function_call_output") {
      return {
        type,
        call_id: item.call_id,
        output: item.output,
      };
    }
    if (type === "message") {
      return {
        type,
        role: item.role,
        content: item.role === "assistant" ? item.content : undefined,
      };
    }
    return { type };
  });
}

function responseHistory(summary: readonly Record<string, unknown>[]) {
  return summary.filter(
    (item) =>
      item.type === "function_call" ||
      item.type === "function_call_output" ||
      (item.type === "message" && item.role === "assistant"),
  );
}

interface JsonDiff {
  readonly path: string;
  readonly left: unknown;
  readonly right: unknown;
}

function canonicalizeRequest(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeRequest(item));
  }
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(record)) {
    if (key === "client_metadata" || key === "prompt_cache_key") {
      continue;
    }
    if (
      key === "id" &&
      typeof fieldValue === "string" &&
      /^(?:msg|fco)_01[0-9a-f-]+$/u.test(fieldValue)
    ) {
      continue;
    }
    if (typeof fieldValue === "string") {
      result[key] = fieldValue.replace(
        /Token-next-request-ab-[^/\\]+[/\\][^/\\]+[/\\]codex-home/g,
        "<CODEX_HOME>",
      );
      continue;
    }
    result[key] = canonicalizeRequest(fieldValue);
  }
  return result;
}

function diffJson(left: unknown, right: unknown, path = "$", out: JsonDiff[] = []): JsonDiff[] {
  if (Object.is(left, right)) return out;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    out.push({ path, left, right });
    return out;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1) {
      diffJson(left[index], right[index], `${path}[${index}]`, out);
    }
    return out;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    diffJson(leftRecord[key], rightRecord[key], `${path}.${key}`, out);
  }
  return out;
}

async function runCase(
  name: string,
  firstWire: string,
): Promise<{
  readonly name: string;
  readonly exitCode: number | null;
  readonly final: string;
  readonly forbidden: readonly string[];
  readonly secondRequest: CapturedRequest;
  readonly secondRequestSummary: readonly Record<string, unknown>[];
  readonly responseHistory: readonly Record<string, unknown>[];
}> {
  let server: Server | undefined;
  let requestCount = 0;
  let secondRequest: CapturedRequest | undefined;

  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end();
        return;
      }
      requestCount += 1;
      const parsed = JSON.parse(body) as CapturedRequest;
      if (requestCount === 2) secondRequest = parsed;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(requestCount === 1 ? firstWire : secondWire);
    });
  });

  await new Promise<void>((resolveListen) => {
    server!.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const directory = join(root, name);
  const codexHome = join(directory, "codex-home");
  const sharedWorkdir = join(root, "shared-workdir");
  await mkdir(codexHome, { recursive: true });
  await mkdir(sharedWorkdir, { recursive: true });
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model = "gpt-native"',
      'model_provider = "ab_replay"',
      "[model_providers.ab_replay]",
      'name = "LuckyToken next-request A/B replay"',
      `base_url = "${baseUrl}"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
    ].join("\n"),
  );

  const output = join(directory, "final.txt");
  const result = await runCodex(
    [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-o",
      output,
      "Use both exec_command calls exactly as supplied by the model, then finish.",
    ],
    sharedWorkdir,
    codexHome,
  );
  const final = (await readFile(output, "utf8").catch(() => "")).trim();
  const forbidden = FORBIDDEN.filter((diagnostic) =>
    result.stderr.includes(diagnostic),
  );
  assert.ok(secondRequest, `${name}: Codex did not emit a second request`);
  const secondRequestSummary = summarizeInput(secondRequest);
  const history = responseHistory(secondRequestSummary);

  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));

  return {
    name,
    exitCode: result.code,
    final,
    forbidden,
    secondRequest,
    secondRequestSummary,
    responseHistory: history,
  };
}

try {
  const versionHome = join(root, "version-home");
  await mkdir(versionHome, { recursive: true });
  const version = await runCodex(["--version"], root, versionHome);
  process.stdout.write(`${version.stdout.trim()}\n`);

  const raw = await runCase("raw_tool_overlap", rawFirstWire);
  const reordered = await runCase("production_reordered_tool_overlap", normalizedFirstWire);

  const sameToolHistory =
    JSON.stringify(raw.responseHistory) === JSON.stringify(reordered.responseHistory);
  const completeRequestDiff = diffJson(raw.secondRequest, reordered.secondRequest);
  const canonicalToolDiff = diffJson(
    canonicalizeRequest(raw.secondRequest),
    canonicalizeRequest(reordered.secondRequest),
  );
  process.stdout.write(
    JSON.stringify({
      comparison: "tool_overlap_next_request_history",
      sameHistory: sameToolHistory,
      sameCompleteRequest: completeRequestDiff.length === 0,
      sameCanonicalRequest: canonicalToolDiff.length === 0,
      rawRequestBytes: Buffer.byteLength(JSON.stringify(raw.secondRequest)),
      reorderedRequestBytes: Buffer.byteLength(JSON.stringify(reordered.secondRequest)),
      completeRequestDiff,
      canonicalRequestDiff: canonicalToolDiff,
      rawTopLevelKeys: Object.keys(raw.secondRequest).sort(),
      reorderedTopLevelKeys: Object.keys(reordered.secondRequest).sort(),
      rawHistory: raw.responseHistory,
      reorderedHistory: reordered.responseHistory,
    }) + "\n",
  );

  assert.equal(raw.exitCode, 0);
  assert.equal(reordered.exitCode, 0);
  assert.equal(raw.final, "TOOLS_HISTORY_OK");
  assert.equal(reordered.final, "TOOLS_HISTORY_OK");
  assert.ok(raw.responseHistory.length > 0);
  assert.deepEqual(raw.responseHistory, reordered.responseHistory);
  assert.deepEqual(canonicalizeRequest(raw.secondRequest), canonicalizeRequest(reordered.secondRequest));

  const messageA = {
    type: "message",
    id: "msg_a",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ANSWER_A", annotations: [] }],
  };
  const messageB = {
    type: "message",
    id: "msg_b",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ANSWER_B", annotations: [] }],
  };
  const messageTool = {
    type: "function_call",
    id: "fc_tool_c",
    call_id: "call_tool_c",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "Write-Output TOOL_C" }),
    status: "completed",
  };
  const rawMessageOverlapWire = sse([
    {
      type: "response.created",
      response: { id: "resp_messages_1", status: "in_progress", model: "gpt-native" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...messageA, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg_a",
      content_index: 0,
      delta: "ANSWER_A",
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...messageB, status: "in_progress", content: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: messageA,
    },
    {
      type: "response.output_text.delta",
      output_index: 1,
      item_id: "msg_b",
      content_index: 0,
      delta: "ANSWER_B",
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: messageB,
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { ...messageTool, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 2,
      item_id: "fc_tool_c",
      delta: String(messageTool.arguments),
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 2,
      item_id: "fc_tool_c",
      arguments: String(messageTool.arguments),
    },
    {
      type: "response.output_item.done",
      output_index: 2,
      item: messageTool,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_messages_1",
        object: "response",
        status: "completed",
        model: "gpt-native",
        output: [messageA, messageB, messageTool],
        usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
      },
    },
  ]);
  const normalizedMessages = normalizeNativeResponsesSse(
    encoder.encode(rawMessageOverlapWire),
  );
  assert.equal(normalizedMessages.kind, "normalized");

  const rawMessages = await runCase("raw_message_overlap", rawMessageOverlapWire);
  const reorderedMessages = await runCase(
    "production_reordered_message_overlap",
    decoder.decode(normalizedMessages.body),
  );

  const sameMessageHistory =
    JSON.stringify(rawMessages.responseHistory) ===
    JSON.stringify(reorderedMessages.responseHistory);
  const completeMessageRequestDiff = diffJson(
    rawMessages.secondRequest,
    reorderedMessages.secondRequest,
  );
  const canonicalMessageDiff = diffJson(
    canonicalizeRequest(rawMessages.secondRequest),
    canonicalizeRequest(reorderedMessages.secondRequest),
  );
  process.stdout.write(
    JSON.stringify({
      comparison: "message_overlap_next_request_history",
      sameHistory: sameMessageHistory,
      sameCompleteRequest: completeMessageRequestDiff.length === 0,
      sameCanonicalRequest: canonicalMessageDiff.length === 0,
      rawRequestBytes: Buffer.byteLength(JSON.stringify(rawMessages.secondRequest)),
      reorderedRequestBytes: Buffer.byteLength(JSON.stringify(reorderedMessages.secondRequest)),
      completeRequestDiff: completeMessageRequestDiff,
      canonicalRequestDiff: canonicalMessageDiff,
      rawForbidden: rawMessages.forbidden,
      reorderedForbidden: reorderedMessages.forbidden,
      rawTopLevelKeys: Object.keys(rawMessages.secondRequest).sort(),
      reorderedTopLevelKeys: Object.keys(reorderedMessages.secondRequest).sort(),
      rawHistory: rawMessages.responseHistory,
      reorderedHistory: reorderedMessages.responseHistory,
    }) + "\n",
  );

  assert.equal(rawMessages.exitCode, 0);
  assert.equal(reorderedMessages.exitCode, 0);
  assert.equal(rawMessages.final, "TOOLS_HISTORY_OK");
  assert.equal(reorderedMessages.final, "TOOLS_HISTORY_OK");
  assert.ok(rawMessages.forbidden.includes("OutputTextDelta without active item"));
  assert.deepEqual(reorderedMessages.forbidden, []);
  assert.deepEqual(rawMessages.responseHistory, reorderedMessages.responseHistory);
  assert.deepEqual(
    canonicalizeRequest(rawMessages.secondRequest),
    canonicalizeRequest(reorderedMessages.secondRequest),
  );
} finally {
  const cleanup = resolve(root);
  const insideTemp = relative(resolve(tmpdir()), cleanup);
  assert.ok(insideTemp && !insideTemp.startsWith("..") && !isAbsolute(insideTemp));
  await rm(cleanup, { recursive: true, force: true });
}
