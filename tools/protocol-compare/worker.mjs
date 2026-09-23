import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_URL, createChatCapture, readResponse, replayRequest } from "./wire.mjs";

// Parent creates these homes before importing any application module.
const [jobPath, resultPath] = process.argv.slice(2);
const job = JSON.parse(await readFile(jobPath, "utf8"));
if (!process.env.CODEX_HOME || !process.env.OPENCODEX_HOME || !process.env.PI_CODING_AGENT_DIR) throw new Error("Isolated homes are required");
const capture = createChatCapture();
globalThis.fetch = capture.fetch;
const localImport = path => import(pathToFileURL(resolve(job.root, path)).href);
const referenceImport = path => import(pathToFileURL(resolve(job.reference, path)).href);
let close = async () => {};
const result = { engine: job.engine, steps: [], outboundViolations: capture.violations };

async function tokenHandler() {
  const { createModels, createProvider } = await import("@earendil-works/pi-ai");
  const api = await import("@earendil-works/pi-ai/api/openai-completions");
  const { createOpenAIResponsesHandler } = await localImport("src/protocols/openai-responses/handler.ts");
  const { createResponseSessionState } = await localImport("src/protocols/openai-responses/session-state.ts");
  const { createPiContextCompatibleExecution } = await localImport("src/pi-context-compatibility-execution.ts");
  const { execute } = await localImport("src/execution.ts");
  const profile = job.scenario.profile ?? "standard";
  const model = {
    id: "model", name: "Comparison fixture", api: "openai-completions", provider: "compare", baseUrl: BASE_URL,
    reasoning: profile !== "no-reasoning", input: ["text", "image"],
    contextWindow: 128_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    compat: { supportsDeveloperRole: true, supportsMidConvoSystemMessages: profile !== "no-mid-system", maxTokensField: "max_tokens", supportsReasoningEffort: true, supportsStrictMode: true, supportsStore: false },
  };
  result.configuration = { model, conversion: "default", execution: "Pi Context compatibility + Models + upstream openai-completions" };
  const models = createModels();
  models.setProvider(createProvider({ id: "compare", models: [model], api,
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "comparison-dummy-key" } }) } },
  }));
  const stateFile = join(process.env.CODEX_HOME, "responses-state.json");
  const sessionState = createResponseSessionState({ stateFile });
  close = () => sessionState.flush();
  return createOpenAIResponsesHandler({ models, stateFile, sessionState,
    maxRequestBytes: 16 * 1024 * 1024, requestTimeoutMs: job.timeoutMs,
    executeOperation: createPiContextCompatibleExecution(async (...args) => {
      try { return await execute(...args); }
      catch (error) { console.error("[Token execution]", error, error.diagnostic); throw error; }
    }),
  }).handle;
}

async function opencodexHandler() {
  const { handleResponses } = await referenceImport("src/server/responses/core.ts");
  const { getDefaultConfig } = await referenceImport("src/config/proxy-env.ts");
  const { acquireSpendLedgerOwner } = await referenceImport("src/lib/spend-ledger-owner.ts");
  const owner = acquireSpendLedgerOwner();
  close = async () => owner.release();
  const provider = { adapter: "openai-chat", baseUrl: BASE_URL, apiKey: "comparison-dummy-key", authMode: "key",
    ...(job.scenario.profile === "no-reasoning" ? { noReasoningModels: ["model"] } : {}),
  };
  const config = { ...getDefaultConfig(), defaultProvider: "compare", providers: { compare: provider }, emptyCompletionRetry: false };
  result.configuration = { provider: { ...provider, apiKey: "<dummy>" }, emptyCompletionRetry: false, defaults: "getDefaultConfig()" };
  return request => handleResponses(request, config, { model: "", provider: "" });
}

try {
  const handle = job.engine === "token" ? await tokenHandler() : await opencodexHandler();
  let previous;
  for (const step of job.scenario.steps) {
    capture.begin(step.reply ?? {});
    let request;
    try { request = replayRequest(step, previous); }
    catch (error) {
      const skipped = { request: step.request, skipped: error.message, providerRequests: [] };
      result.steps.push(skipped);
      previous = skipped;
      continue;
    }
    const observed = { request, providerRequests: capture.captures };
    result.steps.push(observed);
    try {
      const response = await handle(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", "session_id": `compare-${job.scenario.id}` },
        body: JSON.stringify(request), signal: AbortSignal.timeout(job.timeoutMs),
      }));
      const bodyText = await response.text();
      const headers = Object.fromEntries(response.headers);
      observed.response = { status: response.status, headers, bodyText, parsed: readResponse(bodyText, headers["content-type"]) };
    } catch (error) {
      observed.error = { name: error.name, message: error.message };
    }
    previous = observed;
  }
} catch (error) {
  result.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  try { await close(); } catch (error) { result.cleanupError = error.message; }
  await mkdir(resolve(resultPath, ".."), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2));
}
// Reference owns background timers; parent owns process and directory lifetime.
process.exit(result.error || result.cleanupError ? 1 : 0);
