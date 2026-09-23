import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpus, validateCorpus } from "./corpus.mjs";
import { compareCase, writeReport } from "./report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const help = `Usage: npm run compare:protocols -- [options]
  --case TEXT          Select case ids containing TEXT
  --tag TAG            Select scenarios with TAG
  --input FILE         Use a JSON scenario array instead of the generated corpus
  --generated N        Additional seeded combinations (default 32)
  --seed N             Generator seed (default 20260922)
  --limit N            Run only the first N selected cases
  --concurrency N      Concurrent cases (default 2; each starts two workers)
  --timeout-ms N       Per-engine case deadline (default 30000)
  --reference DIR      opencodex checkout (default reference/opencodex)
  --bun PATH           Bun executable (default bun)
  --out DIR            New artifact directory (must not exist)
  --list               List selected cases without running engines
  --write-corpus FILE  Export selected cases without running engines
  --help               Show this help
No CLI or live model calls. Differences are reported, not pass/fail assertions.
Exit: 0 completed (differences allowed); 1 engine/infrastructure errors; 2 invalid invocation.`;

function argumentsFor(args) {
  const options = { generated: 32, seed: 20260922, concurrency: 2, timeoutMs: 30_000, reference: join(root, "reference/opencodex"), bun: "bun" };
  const fields = { "--case": "filter", "--tag": "tag", "--input": "input", "--generated": "generated", "--seed": "seed", "--limit": "limit", "--concurrency": "concurrency", "--timeout-ms": "timeoutMs", "--reference": "reference", "--bun": "bun", "--out": "out", "--write-corpus": "writeCorpus" };
  const numbers = new Set(["generated", "seed", "limit", "concurrency", "timeoutMs"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "--list") { options[arg.slice(2)] = true; continue; }
    const field = fields[arg];
    if (!field || args[i + 1] === undefined) throw new Error(`Unknown option or missing value: ${arg}`);
    options[field] = numbers.has(field) ? Number(args[++i]) : args[++i];
  }
  for (const field of numbers) if (options[field] !== undefined && (!Number.isSafeInteger(options[field]) || options[field] < (["seed", "generated"].includes(field) ? 0 : 1))) throw new Error(`Invalid ${field}`);
  if (options.concurrency > 8) throw new Error("Concurrency must be at most 8");
  options.reference = resolve(options.reference);
  return options;
}

function revision(directory) {
  try { return { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", windowsHide: true }).trim(), dirty: execFileSync("git", ["status", "--porcelain"], { cwd: directory, encoding: "utf8", windowsHide: true }).trim().length > 0,
    trackedDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: directory, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).digest("hex"),
  }; }
  catch { return { commit: null, dirty: null }; }
}
function environment(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "tmpdir", "lang", "lc_all"].includes(key.toLowerCase())) env[key] = value;
  return { ...env, CODEX_HOME: join(home, "codex"), OPENCODEX_HOME: join(home, "opencodex"), PI_CODING_AGENT_DIR: join(home, "pi"),
    HOME: join(home, "user"), USERPROFILE: join(home, "user"), APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
    NO_COLOR: "1", OTEL_SDK_DISABLED: "true", OPENCODEX_CODEX_SHIM_AUTO_RESTORE: "0" };
}

const active = new Set();
let interrupted = false;
function interrupt() { interrupted = true; for (const child of active) child.kill(); }

async function runEngine(engine, scenario, directory, scratch, options) {
  const home = await mkdtemp(join(scratch, `${engine}-`));
  const env = environment(home);
  await Promise.all([env.CODEX_HOME, env.OPENCODEX_HOME, env.PI_CODING_AGENT_DIR, env.HOME, env.APPDATA, env.LOCALAPPDATA].map(path => mkdir(path, { recursive: true })));
  const jobPath = join(home, "job.json");
  const resultPath = join(directory, `${engine}.json`);
  await writeFile(jobPath, JSON.stringify({ engine, scenario, root, reference: options.reference, timeoutMs: options.timeoutMs }));
  const worker = join(root, "tools/protocol-compare/worker.mjs");
  const command = engine === "token" ? process.execPath : options.bun;
  const args = engine === "token" ? ["--import", "tsx", worker, jobPath, resultPath] : [worker, jobPath, resultPath];
  let log = "";
  let timedOut = false;
  const outcome = await new Promise(resolveExit => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    active.add(child);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    const append = chunk => { if (log.length < 256_000) log += chunk.toString(); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.once("error", error => { clearTimeout(timer); active.delete(child); resolveExit({ spawnError: error.message }); });
    child.once("close", (code, signal) => { clearTimeout(timer); active.delete(child); resolveExit({ code, signal }); });
  });
  await writeFile(join(directory, `${engine}.log`), log);
  let result;
  try { result = JSON.parse(await readFile(resultPath, "utf8")); }
  catch { result = { engine, steps: [], error: { message: timedOut ? `Worker timed out after ${options.timeoutMs}ms` : outcome.spawnError ?? `Worker exited ${outcome.code}; see ${engine}.log` } }; }
  if (!result.error && (timedOut || outcome.code !== 0)) result.error = { message: timedOut ? "Worker deadline exceeded" : `Worker exited ${outcome.code}; see ${engine}.log` };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  let corpus = options.input ? validateCorpus(JSON.parse(await readFile(resolve(options.input), "utf8"))) : buildCorpus(options);
  corpus = corpus.filter(item => (!options.filter || item.id.includes(options.filter)) && (!options.tag || item.tags.includes(options.tag)));
  if (options.limit) corpus = corpus.slice(0, options.limit);
  if (!corpus.length) throw new Error("No scenarios selected");
  if (options.list) { for (const item of corpus) console.log(`${item.id}\t${item.tags.join(",")}`); return; }
  if (options.writeCorpus) { await writeFile(resolve(options.writeCorpus), JSON.stringify(corpus, null, 2), { flag: "wx" }); console.log(`Exported ${corpus.length} scenarios`); return; }
  await access(join(options.reference, "node_modules/zod/package.json")).catch(() => { throw new Error("Install reference dependencies first: bun install --frozen-lockfile --ignore-scripts (in reference/opencodex)"); });
  const bunVersion = execFileSync(options.bun, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  const out = resolve(options.out ?? join(root, "artifacts/protocol-compare", new Date().toISOString().replaceAll(/[:.]/gu, "-")));
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Never overwrite an earlier report.
  const manifest = {
    generatedAt: new Date().toISOString(), token: revision(root), opencodex: { ...revision(options.reference), version: JSON.parse(await readFile(join(options.reference, "package.json"), "utf8")).version },
    pi: JSON.parse(await readFile(join(root, "node_modules/@earendil-works/pi-ai/package.json"), "utf8")).version,
    toolFiles: Object.fromEntries(await Promise.all(["cli.mjs", "worker.mjs", "wire.mjs", "corpus.mjs", "report.mjs"].map(async file => [file, createHash("sha256").update(await readFile(join(root, "tools/protocol-compare", file))).digest("hex")]))),
    node: process.version, bun: bunVersion, seed: options.seed,
    corpusSha256: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
    transport: "Real Responses handlers, serialized Chat requests captured at fetch; scripted Chat JSON/SSE; isolated process per case and engine",
    normalization: "Generated Responses response/item IDs and created_at/completed_at only. No request normalization. SSE event topology compared separately.",
    scope: "Semantic conversion only; catalog/auth UI, listener admission, Direct and Native Preservation lanes are outside this tool.",
  };
  await writeFile(join(out, "corpus.json"), JSON.stringify(corpus, null, 2));
  const scratch = await mkdtemp(join(tmpdir(), "Token-protocol-compare-"));
  const results = new Array(corpus.length);
  let cursor = 0;
  let completed = 0;
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  console.log(`Comparing ${corpus.length} scenarios → ${out}`);
  try {
    // A broken driver must not be mistaken for hundreds of conversion differences.
    const preflight = { id: "preflight", tags: [], steps: [{ request: { model: "compare/model", input: "Fixture preflight", stream: true, store: false }, reply: { text: "PREFLIGHT_OK" } }] };
    const preflightDir = join(out, "preflight");
    await mkdir(preflightDir);
    for (const observed of await Promise.all(["token", "opencodex"].map(engine => runEngine(engine, preflight, preflightDir, scratch, options)))) {
      const step = observed.steps?.[0];
      if (observed.error || step?.response?.status !== 200 || !step?.providerRequests?.length || !JSON.stringify(step?.response?.parsed?.json?.output ?? null).includes("PREFLIGHT_OK")) {
        manifest.preflightError = `${observed.engine} preflight failed; see preflight/${observed.engine}.json and .log`;
        throw new Error(manifest.preflightError);
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: Math.min(options.concurrency, corpus.length) }, async () => {
      while (!interrupted) {
        const index = cursor++;
        const scenario = corpus[index];
        if (!scenario) break;
        const directory = join(out, "cases", scenario.id);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "scenario.json"), JSON.stringify(scenario, null, 2));
        const observed = await Promise.allSettled(["token", "opencodex"].map(engine => runEngine(engine, scenario, directory, scratch, options)));
        const [token, opencodex] = observed.map((entry, engineIndex) => entry.status === "fulfilled" ? entry.value : { engine: engineIndex === 0 ? "token" : "opencodex", steps: [], error: { message: String(entry.reason) } });
        results[index] = compareCase(scenario, token, opencodex);
        completed++;
        console.log(`[${completed}/${corpus.length}] ${scenario.id}: ${results[index].differences.length} differences${results[index].errors.length ? `; ${results[index].errors.join("; ")}` : ""}`);
      }
    }));
    for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  } finally {
    for (const child of active) child.kill();
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const report = await writeReport(out, { ...manifest, interrupted, selectedCases: corpus.length }, results.filter(Boolean));
    console.log(`Report: ${join(out, "report.html")}\n${JSON.stringify(report.summary)}`);
    process.exitCode = interrupted || manifest.preflightError || report.summary.executionErrors ? 1 : 0;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 2; });
