// Local synthetic SSE replay. No provider account, user config, or user sessions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

const root = await mkdtemp(join(tmpdir(), "Token-item-chain-replay-"));
const cli = join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const message = (id, text, status = "completed") => ({
  type: "message", id, role: "assistant", status,
  content: text ? [{ type: "output_text", text, annotations: [] }] : [],
});
const a = message("msg_a", "ANSWER_A");
const b = message("msg_b", "ANSWER_B");
const added = (item, index) => ({ type: "response.output_item.added", output_index: index, item: message(item.id, "", "in_progress") });
const delta = (item, index, text) => ({ type: "response.output_text.delta", output_index: index, item_id: item.id, content_index: 0, delta: text });
const done = (item, index) => ({ type: "response.output_item.done", output_index: index, item });
const chainA = [added(a, 0), delta(a, 0, "ANSWER_A"), done(a, 0)];
const chainB = [added(b, 1), delta(b, 1, "ANSWER_B"), done(b, 1)];
const terminal = { type: "response.completed", response: {
  id: "resp_replay", object: "response", status: "completed", model: "gpt-5.4",
  output: [a, b], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
} };
let wire = "";
let requests = 0;
const server = createServer((req, res) => {
  req.resume();
  if (req.method === "POST" && req.url === "/v1/responses") {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(wire);
  } else { res.writeHead(404); res.end(); }
});
function run(args, cwd, codexHome) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "local-replay-only" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); }, 45000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  });
}
try {
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const versionHome = join(root, "version-home");
  await mkdir(versionHome);
  const version = await run(["--version"], root, versionHome);
  console.log(version.stdout.trim());
  const cases = [
    ["overlap_index_ordered_done", [chainA[0], chainA[1], chainB[0], chainA[2], chainB[1], chainB[2]], "ANSWER_B", 1],
    ["overlap_reverse_done", [chainA[0], ...chainB, chainA[1], chainA[2]], "ANSWER_A", 1],
    ["serialized_by_index", [...chainA, ...chainB], "ANSWER_B", 0],
    ["serialized_by_done", [...chainB, ...chainA], "ANSWER_A", 0],
  ];
  for (const [name, events, expectedFinal, expectedWarnings] of cases) {
    const directory = join(root, name);
    const codexHome = join(directory, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), [
      'model = "gpt-5.4"', 'model_provider = "replay"',
      '[model_providers.replay]', 'name = "Local SSE replay"',
      `base_url = "${baseUrl}"`, 'wire_api = "responses"', 'requires_openai_auth = false',
    ].join("\n"));
    const output = join(directory, "final.txt");
    wire = [{ type: "response.created", response: { id: "resp_replay", status: "in_progress" } }, ...events, terminal]
      .map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
    const result = await run(["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-o", output, "Reply with a short answer. Do not use tools."], directory, codexHome);
    const final = await readFile(output, "utf8").catch(() => "");
    const warnings = (result.stderr.match(/OutputTextDelta without active item/g) ?? []).length;
    const parsed = result.stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
    const messages = parsed.filter(event => event.type === "item.completed" && event.item?.type === "agent_message").map(event => event.item.text);
    const summary = { name, exitCode: result.code, final: final.trim(), completedMessages: messages, warnings, completed: parsed.some(event => event.type === "turn.completed") };
    console.log(JSON.stringify(summary));
    if (result.code !== 0 || !summary.completed) {
      // Only synthetic replay state is used, but avoid printing arbitrary environment diagnostics.
      console.log(JSON.stringify({ errorEvents: parsed.filter(event => event.type === "error" || event.type === "turn.failed") }));
    }
    assert.equal(result.code, 0);
    assert.equal(summary.completed, true);
    assert.equal(summary.final, expectedFinal);
    assert.equal(warnings, expectedWarnings);
  }
  assert.equal(requests, cases.length);
} finally {
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  const cleanup = resolve(root);
  const insideTemp = relative(resolve(tmpdir()), cleanup);
  assert.ok(insideTemp && !insideTemp.startsWith("..") && !isAbsolute(insideTemp));
  await rm(cleanup, { recursive: true, force: true });
}
