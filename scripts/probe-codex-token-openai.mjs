import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const ENDPOINT = "https://api.openai.com/v1/responses";

/** Explicit, read-only credential compatibility probe. Never logs or refreshes credentials. */
export async function probeCodexTokenOpenai({ authPath, modelId = "gpt-6-luna", fetch = globalThis.fetch }) {
  const report = {
    provider: "openai", model: modelId, endpoint: ENDPOINT,
    refreshed: false, copiedCredentials: false,
  };
  let original;
  let secrets = [];
  const redact = (value) => {
    let safe = String(value);
    for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
    return safe.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted-jwt]").slice(0, 1500);
  };
  try {
    original = await readFile(authPath);
    let auth;
    try { auth = JSON.parse(original.toString("utf8")); }
    catch { throw new Error("Source credential document is not valid JSON"); }
    secrets = [auth.tokens?.access_token, auth.tokens?.refresh_token, auth.tokens?.id_token]
      .filter((value) => typeof value === "string" && value.length > 0);
    const access = auth.tokens?.access_token;
    if (auth.auth_mode !== "chatgpt" || typeof access !== "string" || access.length === 0) {
      throw new Error("Source is not a Codex ChatGPT credential document");
    }
    const provider = openaiProvider();
    const model = provider.getModels().find((entry) => entry.id === modelId);
    if (!model || model.baseUrl !== "https://api.openai.com/v1") {
      throw new Error("The installed Pi public OpenAI catalog lacks this model/destination");
    }
    const models = createModels();
    models.setProvider(provider);
    // An explicit key override avoids OAuth refresh and credential persistence.
    const result = await models.completeSimple(model, {
      messages: [{ role: "user", content: "Reply with exactly OK. Do not explain.", timestamp: Date.now() }],
    }, {
      apiKey: access, maxTokens: 16, ...(model.reasoning ? { reasoning: "minimal" } : {}),
      signal: AbortSignal.timeout(45000),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== ENDPOINT || request.method !== "POST") throw new Error("Unexpected upstream destination or method");
        if (request.headers.get("authorization") !== `Bearer ${access}`) throw new Error("Pi did not apply the explicit Codex access token");
        report.usedCodexAccessToken = true;
        report.method = request.method;
        // Refuse redirects so the credential cannot reach a different host.
        const response = await fetch(request, { redirect: "error" });
        report.httpStatus = response.status;
        if (!response.ok) {
          const reader = response.clone().body?.getReader();
          if (reader) {
            const chunks = [];
            let length = 0;
            try {
              while (length < 8192) {
                const chunk = await reader.read();
                if (chunk.done) break;
                chunks.push(Buffer.from(chunk.value).subarray(0, 8192 - length));
                length += chunk.value.length;
              }
            } finally {
              void reader.cancel().catch(() => undefined);
            }
            report.errorResponse = redact(Buffer.concat(chunks).toString("utf8"));
          }
        }
        return response;
      },
    });
    report.stopReason = result.stopReason;
    if (result.stopReason === "error" || result.stopReason === "aborted") report.error = redact(result.errorMessage ?? "Provider request failed");
    else report.text = redact(result.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
  } catch (error) {
    report.error = redact(error instanceof Error ? error.message : error);
  } finally {
    if (original) {
      try {
        const after = await readFile(authPath);
        report.sourceUnchanged = createHash("sha256").update(original).digest("hex") === createHash("sha256").update(after).digest("hex");
      } catch {
        report.sourceUnchanged = "unavailable";
      }
    }
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("npm run probe:codex-token-openai -- [--auth-path <Codex auth.json>] [--model <OpenAI model>]\nDefault source: ~/.codex/auth.json. Default model: gpt-6-luna. Sends one minimal real Responses request.\n");
    return;
  }
  if (!process.env.TOKEN_TEST_CODEX_SANDBOX || !process.env.CODEX_HOME) {
    throw new Error("Run through npm run probe:codex-token-openai to create an isolated CODEX_HOME");
  }
  let authPath = join(homedir(), ".codex", "auth.json");
  let modelId = "gpt-6-luna";
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (!value) throw new Error("Missing argument value; use --help");
    if (args[index] === "--auth-path") authPath = resolve(value);
    else if (args[index] === "--model") modelId = value;
    else throw new Error("Unknown argument; use --help");
  }
  const result = await probeCodexTokenOpenai({ authPath, modelId });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.httpStatus !== 200 || result.error !== undefined) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    process.stderr.write("Probe setup failed; use --help and run through the guarded npm command.\n");
    process.exitCode = 1;
  });
}
