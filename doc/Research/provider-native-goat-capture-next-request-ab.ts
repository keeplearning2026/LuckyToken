import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { normalizeNativeResponsesSse } from "../../src/protocols/openai-responses/native-sse-lifecycle-normalizer.js";

interface UpstreamArtifact {
  readonly responseBody: string;
}

interface CapturedRequest {
  readonly input?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

interface JsonDiff {
  readonly path: string;
  readonly left: unknown;
  readonly right: unknown;
}

const [firstArtifactPath, secondArtifactPath] = process.argv.slice(2);
if (!firstArtifactPath || !secondArtifactPath) {
  throw new Error("usage: tsx provider-native-goat-capture-next-request-ab.ts <first-upstream.json> <second-upstream.json>");
}

const firstArtifact = JSON.parse(await readFile(firstArtifactPath, "utf8")) as UpstreamArtifact;
const secondArtifact = JSON.parse(await readFile(secondArtifactPath, "utf8")) as UpstreamArtifact;
const rawFirstWire = firstArtifact.responseBody;
const secondWire = secondArtifact.responseBody;

const normalized = normalizeNativeResponsesSse(new TextEncoder().encode(rawFirstWire));
assert.equal(normalized.kind, "normalized");
const normalizedFirstWire = new TextDecoder().decode(normalized.body);

interface WireFrameFact {
  readonly type: string;
  readonly itemId?: string;
  readonly outputIndex?: number;
  readonly semanticPayload: string;
  readonly isDone: boolean;
  readonly isTerminal: boolean;
  readonly isGlobal: boolean;
}

function wireFacts(wire: string): readonly WireFrameFact[] {
  return wire
    .split(/\r?\n\r?\n/u)
    .filter(Boolean)
    .map((frame) => {
      const dataLine = frame
        .split(/\r?\n/u)
        .find((line) => line.startsWith("data:"));
      assert.ok(dataLine, "captured Goat frame must contain data");
      const payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
      const type = String(payload.type ?? "");
      const nestedItem =
        typeof payload.item === "object" &&
        payload.item !== null &&
        !Array.isArray(payload.item)
          ? (payload.item as Record<string, unknown>)
          : undefined;
      const itemId =
        typeof payload.item_id === "string"
          ? payload.item_id
          : typeof nestedItem?.id === "string"
            ? nestedItem.id
            : undefined;
      const outputIndex =
        typeof payload.output_index === "number" ? payload.output_index : undefined;
      const semantic = { ...payload };
      delete semantic.sequence_number;
      const isDone = type === "response.output_item.done";
      const isTerminal =
        type === "response.completed" ||
        type === "response.failed" ||
        type === "response.incomplete";
      return {
        type,
        ...(itemId === undefined ? {} : { itemId }),
        ...(outputIndex === undefined ? {} : { outputIndex }),
        semanticPayload: JSON.stringify(semantic),
        isDone,
        isTerminal,
        isGlobal: itemId === undefined && outputIndex === undefined,
      };
    });
}

function multisetFingerprint(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function perItemTypeOrder(facts: readonly WireFrameFact[]): Readonly<Record<string, readonly string[]>> {
  const orders: Record<string, string[]> = {};
  for (const fact of facts) {
    if (fact.itemId === undefined) continue;
    (orders[fact.itemId] ??= []).push(fact.type);
  }
  return orders;
}

const rawWireFacts = wireFacts(rawFirstWire);
const normalizedWireFacts = wireFacts(normalizedFirstWire);
const rawTerminalIndexes = rawWireFacts
  .map((fact, index) => (fact.isTerminal ? index : -1))
  .filter((index) => index >= 0);
const normalizedTerminalIndexes = normalizedWireFacts
  .map((fact, index) => (fact.isTerminal ? index : -1))
  .filter((index) => index >= 0);
const rawDoneOrder = rawWireFacts
  .filter((fact) => fact.isDone)
  .map((fact) => fact.itemId);
const normalizedDoneOrder = normalizedWireFacts
  .filter((fact) => fact.isDone)
  .map((fact) => fact.itemId);
const rawGlobalDoneSkeleton = rawWireFacts
  .filter((fact) => fact.isGlobal || fact.isDone)
  .map((fact) => `${fact.type}:${fact.itemId ?? "global"}`);
const normalizedGlobalDoneSkeleton = normalizedWireFacts
  .filter((fact) => fact.isGlobal || fact.isDone)
  .map((fact) => `${fact.type}:${fact.itemId ?? "global"}`);

const root = await mkdtemp(join(tmpdir(), "Token-goat-capture-ab-"));
const cli = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);

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
        OPENAI_API_KEY: "local-goat-capture-replay-only",
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
    const timer = setTimeout(() => child.kill(), 60_000);
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

function canonicalizeRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeRequest(item));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(record)) {
    if (key === "client_metadata" || key === "prompt_cache_key") continue;
    if (
      key === "id" &&
      typeof fieldValue === "string" &&
      /^(?:msg|fco)_01[0-9a-f-]+$/u.test(fieldValue)
    ) {
      continue;
    }
    if (typeof fieldValue === "string") {
      let normalizedValue = fieldValue.replace(
        /Token-goat-capture-ab-[^/\\]+[/\\][^/\\]+[/\\]codex-home/g,
        "<CODEX_HOME>",
      );
      if (record.type === "function_call_output" && key === "output") {
        normalizedValue = normalizedValue
          .replace(/^Chunk ID: [^\r\n]+/mu, "Chunk ID: <runtime>")
          .replace(/^Wall time: [^\r\n]+/mu, "Wall time: <runtime>");
      }
      result[key] = normalizedValue;
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
  for (const key of keys) diffJson(leftRecord[key], rightRecord[key], `${path}.${key}`, out);
  return out;
}

function semanticHistory(request: CapturedRequest): readonly Record<string, unknown>[] {
  const input = Array.isArray(request.input) ? request.input : [];
  return input.filter((item) => {
    const type = item.type;
    return (
      type === "message" ||
      type === "function_call" ||
      type === "function_call_output" ||
      type === "custom_tool_call" ||
      type === "custom_tool_call_output" ||
      type === "reasoning"
    );
  });
}

async function runCase(name: string, firstWire: string) {
  let requestCount = 0;
  let secondRequest: CapturedRequest | undefined;
  let firstResponseDelivery:
    | {
        frameCount: number;
        framesAttempted: number;
        framesWritten: number;
        closedBeforeTerminal: boolean;
        closeObserved: boolean;
        terminalFrameAttempted: boolean;
      }
    | undefined;
  let server: Server | undefined;
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", async () => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end();
        return;
      }
      requestCount += 1;
      if (requestCount === 2) secondRequest = JSON.parse(body) as CapturedRequest;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requestCount !== 1) {
        res.end(secondWire);
        return;
      }

      const frames = firstWire.match(/[\s\S]*?(?:\r\n\r\n|\n\n)/gu) ?? [];
      const delivery = {
        frameCount: frames.length,
        framesAttempted: 0,
        framesWritten: 0,
        closedBeforeTerminal: false,
        closeObserved: false,
        terminalFrameAttempted: false,
      };
      firstResponseDelivery = delivery;
      let terminalAttempted = false;
      res.once("close", () => {
        delivery.closeObserved = true;
        if (!terminalAttempted) delivery.closedBeforeTerminal = true;
      });

      for (const frame of frames) {
        if (res.destroyed || res.writableEnded) {
          delivery.closedBeforeTerminal ||= !terminalAttempted;
          break;
        }
        delivery.framesAttempted += 1;
        if (/event:\s*response\.(?:completed|failed|incomplete)/u.test(frame)) {
          terminalAttempted = true;
          delivery.terminalFrameAttempted = true;
        }
        res.write(frame);
        delivery.framesWritten += 1;
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      if (!res.destroyed && !res.writableEnded) res.end();
    });
  });
  await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const directory = join(root, name);
  const codexHome = join(directory, "codex-home");
  const workdir = join(root, "shared-workdir");
  await mkdir(codexHome, { recursive: true });
  await mkdir(workdir, { recursive: true });
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model = "deepseek/deepseek-v4.1-flash"',
      'model_provider = "replay"',
      "[model_providers.replay]",
      'name = "Captured Goat Responses replay"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
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
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      output,
      "In one tool round, call exec_command exactly twice in parallel: one command outputs PARALLEL_A_OK and the other outputs PARALLEL_B_OK. After both finish, reply with exactly: PARALLEL_TOOLS_OK.",
    ],
    workdir,
    codexHome,
  );
  const final = (await readFile(output, "utf8").catch(() => "")).trim();
  assert.ok(secondRequest, `${name}: no second request captured`);
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server!.close(resolveClose));
  assert.ok(firstResponseDelivery, `${name}: first response delivery facts missing`);
  return {
    name,
    exitCode: result.code,
    final,
    stderrLifecycleLines: result.stderr
      .split(/\r?\n/u)
      .filter((line) => /active item|active tool|ToolCall|function_call/i.test(line)),
    firstResponseDelivery,
    secondRequest,
    history: semanticHistory(secondRequest),
  };
}

try {
  const versionHome = join(root, "version-home");
  await mkdir(versionHome, { recursive: true });
  const version = await runCodex(["--version"], root, versionHome);
  process.stdout.write(`${version.stdout.trim()}\n`);
  process.stdout.write(
    JSON.stringify({
      normalizerKind: normalized.kind,
      movedFrameCount: normalized.movedFrameCount,
      commitOrderDiffersFromOutputIndex: normalized.commitOrderDiffersFromOutputIndex,
      wireInvariants: {
        rawFrameCount: rawWireFacts.length,
        normalizedFrameCount: normalizedWireFacts.length,
        sameSemanticFrameMultiset:
          JSON.stringify(
            multisetFingerprint(rawWireFacts.map((fact) => fact.semanticPayload)),
          ) ===
          JSON.stringify(
            multisetFingerprint(normalizedWireFacts.map((fact) => fact.semanticPayload)),
          ),
        samePerItemTypeOrder:
          JSON.stringify(perItemTypeOrder(rawWireFacts)) ===
          JSON.stringify(perItemTypeOrder(normalizedWireFacts)),
        rawDoneOrder,
        normalizedDoneOrder,
        sameDoneOrder: JSON.stringify(rawDoneOrder) === JSON.stringify(normalizedDoneOrder),
        rawGlobalDoneSkeleton,
        normalizedGlobalDoneSkeleton,
        sameGlobalDoneSkeleton:
          JSON.stringify(rawGlobalDoneSkeleton) ===
          JSON.stringify(normalizedGlobalDoneSkeleton),
        rawTerminalIndexes,
        normalizedTerminalIndexes,
        rawTerminalIsLast:
          rawTerminalIndexes.length === 1 &&
          rawTerminalIndexes[0] === rawWireFacts.length - 1,
        normalizedTerminalIsLast:
          normalizedTerminalIndexes.length === 1 &&
          normalizedTerminalIndexes[0] === normalizedWireFacts.length - 1,
      },
    }) + "\n",
  );

  const raw = await runCase("raw", rawFirstWire);
  const reordered = await runCase("reordered", normalizedFirstWire);
  const canonicalRaw = canonicalizeRequest(raw.secondRequest);
  const canonicalReordered = canonicalizeRequest(reordered.secondRequest);
  const canonicalDiff = diffJson(canonicalRaw, canonicalReordered);

  process.stdout.write(
    JSON.stringify({
      raw: {
        exitCode: raw.exitCode,
        final: raw.final,
        stderrLifecycleLines: raw.stderrLifecycleLines,
        firstResponseDelivery: raw.firstResponseDelivery,
        history: raw.history,
      },
      reordered: {
        exitCode: reordered.exitCode,
        final: reordered.final,
        stderrLifecycleLines: reordered.stderrLifecycleLines,
        firstResponseDelivery: reordered.firstResponseDelivery,
        history: reordered.history,
      },
      sameHistory: JSON.stringify(raw.history) === JSON.stringify(reordered.history),
      sameCanonicalRequest: canonicalDiff.length === 0,
      canonicalRequestDiff: canonicalDiff,
    }) + "\n",
  );
} finally {
  const cleanup = resolve(root);
  const insideTemp = relative(resolve(tmpdir()), cleanup);
  assert.ok(insideTemp && !insideTemp.startsWith("..") && !isAbsolute(insideTemp));
  await rm(cleanup, { recursive: true, force: true });
}
