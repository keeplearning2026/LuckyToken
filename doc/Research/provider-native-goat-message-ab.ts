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

const artifactPath = process.argv[2];
if (!artifactPath) {
  throw new Error("usage: tsx provider-native-goat-message-ab.ts <upstream.json>");
}

const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as UpstreamArtifact;
const rawWire = artifact.responseBody;
const normalized = normalizeNativeResponsesSse(new TextEncoder().encode(rawWire));
assert.equal(normalized.kind, "normalized");
const normalizedWire = new TextDecoder().decode(normalized.body);

const root = await mkdtemp(join(tmpdir(), "Token-goat-message-ab-"));
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
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "local-replay-only" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stderr });
    });
  });
}

async function runCase(name: string, wire: string) {
  let delivery:
    | {
        frameCount: number;
        framesWritten: number;
        terminalFrameAttempted: boolean;
        closedBeforeTerminal: boolean;
      }
    | undefined;
  let server: Server | undefined;
  server = createServer((req, res) => {
    req.resume();
    req.once("end", async () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = wire.match(/[\s\S]*?(?:\r\n\r\n|\n\n)/gu) ?? [];
      const facts = {
        frameCount: frames.length,
        framesWritten: 0,
        terminalFrameAttempted: false,
        closedBeforeTerminal: false,
      };
      delivery = facts;
      let terminalAttempted = false;
      res.once("close", () => {
        if (!terminalAttempted) facts.closedBeforeTerminal = true;
      });
      for (const frame of frames) {
        if (res.destroyed || res.writableEnded) break;
        if (/event:\s*response\.(?:completed|failed|incomplete)/u.test(frame)) {
          terminalAttempted = true;
          facts.terminalFrameAttempted = true;
        }
        res.write(frame);
        facts.framesWritten += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
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
      'name = "Captured Goat message replay"',
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
      "Reply with exactly: CHAIN_LONG_OK, then repeat the exact string 'abcdefghij' ten times on one line. Do not explain.",
    ],
    workdir,
    codexHome,
  );
  const final = (await readFile(output, "utf8").catch(() => "")).trim();
  const warningCount =
    result.stderr.match(/OutputTextDelta without active item/gu)?.length ?? 0;
  assert.ok(delivery);
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server!.close(resolveClose));
  return { name, exitCode: result.code, warningCount, final, delivery };
}

try {
  const versionHome = join(root, "version-home");
  await mkdir(versionHome, { recursive: true });
  const version = await runCodex(["--version"], root, versionHome);
  process.stdout.write(`${version.stderr.trim()}\n`);

  const raw = await runCase("raw", rawWire);
  const reordered = await runCase("reordered", normalizedWire);
  process.stdout.write(
    JSON.stringify({
      normalizer: {
        movedFrameCount: normalized.movedFrameCount,
        commitOrderDiffersFromOutputIndex: normalized.commitOrderDiffersFromOutputIndex,
      },
      raw,
      reordered,
      sameFinalText: raw.final === reordered.final,
    }) + "\n",
  );
} finally {
  const cleanup = resolve(root);
  const insideTemp = relative(resolve(tmpdir()), cleanup);
  assert.ok(insideTemp && !insideTemp.startsWith("..") && !isAbsolute(insideTemp));
  await rm(cleanup, { recursive: true, force: true });
}
