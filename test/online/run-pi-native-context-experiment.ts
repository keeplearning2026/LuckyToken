import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createModels, type CredentialStore, type Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createCodexLocalOAuthRegistration } from "../../src/credentials/codex-local-oauth.js";
import { readCredentialDocumentFile } from "../../src/credentials/credential-document.js";
import { sendWithPiEnvelope } from "../support/pi-native-context-transport.js";

interface WireResponse {
  readonly id: string;
  readonly status: string;
  readonly output: Array<Record<string, unknown>>;
}

let stage = "local_oauth";
async function main() {
  assert(process.env.TOKEN_TEST_CODEX_SANDBOX === "1" && process.env.CODEX_HOME,
    "Run through scripts/run-with-codex-test-sandbox.mjs");
  // External local_oauth reference only. No auth file is copied or written;
  // all test-owned state lives in the guard's temporary CODEX_HOME.
  const authPath = join(resolve(process.env.TOKEN_CODEX_TEST_AUTH_HOME || join(homedir(), ".codex")), "auth.json");
  const registration = createCodexLocalOAuthRegistration({ authPath, label: () => "Local Codex" });
  const reference = await registration.acquire(AbortSignal.timeout(5_000));
  assert(reference, "Local OAuth acquisition did not return a reference");
  const before = await readCredentialDocumentFile(reference.path);
  assert(before.state === "ok", "Local Codex OAuth login is unavailable");
  const credential = registration.read(before.raw);
  assert(credential?.type === "oauth", "Local Codex OAuth document is invalid");
  assert(credential.expires > Date.now() + 5 * 60_000,
    "Local OAuth token is near expiry; log in through Codex before this read-only experiment");
  const credentials: CredentialStore = {
    read: async (id) => id === "openai-codex" ? credential : undefined,
    list: async () => [{ providerId: "openai-codex", type: "oauth" }],
    modify: async () => { throw new Error("Read-only experiment refuses credential refresh"); },
    delete: async () => { throw new Error("Read-only experiment refuses credential deletion"); },
  };
  const provider = openaiCodexProvider();
  const models = createModels({ credentials });
  models.setProvider(provider);
  const model = models.getModel("openai-codex", "gpt-6-luna");
  assert(model, "Pi catalog must include the requested gpt-6-luna model");
  const evidence: Array<Record<string, unknown>> = [];
  const signal = AbortSignal.timeout(90_000);
  try {
    stage = "pi-baseline-low";
    // First establish that this local credential/model works through ordinary Pi.
    const baseline = await models.completeSimple(model, {
      messages: [{ role: "user", content: "Reply with exactly TOKEN_PI_BASELINE_OK", timestamp: 1 }],
    }, { reasoning: "low", transport: "sse", maxRetries: 0, signal });
    assert.equal(baseline.stopReason, "stop", "Pi baseline request failed");
    assert(baseline.content.some((part) => part.type === "text" && part.text.includes("TOKEN_PI_BASELINE_OK")),
      "Pi baseline did not return the expected marker");
    evidence.push({ probe: "pi-baseline", reasoning: "low", outcome: "passed" });

    stage = "native-low";
    const low = await native(model, {
      model: model.id, instructions: "Follow the user's request.", store: false, stream: true,
      input: [{ role: "user", content: "Reply with exactly TOKEN_NATIVE_PI_LOW_OK" }],
      reasoning: { effort: "low" }, include: ["reasoning.encrypted_content"],
    }, signal);
    assert(text(low).includes("TOKEN_NATIVE_PI_LOW_OK"), "Native low marker missing");
    evidence.push({ probe: "native-response", reasoning: "low", outcome: "passed" });

    const input: Array<Record<string, unknown>> = [{ role: "user",
      content: "Call audit_sum once with a=2 and b=3. After its result, reply with exactly TOKEN_NATIVE_PI_TOOL_OK 5." }];
    const tools = [{ type: "function", name: "audit_sum", description: "Add two integers.",
      parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"], additionalProperties: false }, strict: true }];
    const request = { model: model.id, instructions: "Follow the user's request.", store: false, stream: true,
      input, tools, reasoning: { effort: "medium" }, include: ["reasoning.encrypted_content"] };
    stage = "native-medium-tool-call";
    const toolTurn = await native(model, request, signal);
    const call = toolTurn.output.find((item) => item.type === "function_call");
    assert(call && call.name === "audit_sum" && typeof call.call_id === "string");
    assert.deepEqual(JSON.parse(String(call.arguments)), { a: 2, b: 3 });
    stage = "native-medium-tool-replay";
    const followup = await native(model, { ...request,
      input: [...input, ...toolTurn.output, { type: "function_call_output", call_id: call.call_id, output: "5" }],
    }, signal);
    assert(text(followup).includes("TOKEN_NATIVE_PI_TOOL_OK 5"), "Native tool replay marker missing");
    evidence.push({ probe: "native-tool-complete-history", reasoning: "medium", outcome: "passed",
      opaqueReasoningReplayed: toolTurn.output.some((item) => item.type === "reasoning" && typeof item.encrypted_content === "string") });
    stage = "native-supported-v2-compaction";
    const compacted = await native(model, { ...request, reasoning: { effort: "low" },
      input: [...input, ...toolTurn.output, { type: "function_call_output", call_id: call.call_id, output: "5" },
        ...followup.output, { type: "compaction_trigger" }],
    }, signal);
    const compactItems = compacted.output.filter((item) => item.type === "compaction" || item.type === "compaction_summary");
    assert.equal(compactItems.length, 1, "Supported native compaction must return exactly one compaction item");
    assert(typeof compactItems[0]?.encrypted_content === "string" && compactItems[0].encrypted_content.length > 0,
      "Supported native compaction must contain an opaque envelope");
    evidence.push({ probe: "native-supported-v2-compaction", reasoning: "low", outcome: "passed" });
    stage = "native-opaque-compaction-replay";
    const replayed = await native(model, { ...request, reasoning: { effort: "low" },
      input: [...compactItems, { role: "user", content: "Reply with exactly TOKEN_NATIVE_PI_COMPACTION_REPLAY_OK" }],
    }, signal);
    assert(text(replayed).includes("TOKEN_NATIVE_PI_COMPACTION_REPLAY_OK"), "Native opaque compaction replay marker missing");
    evidence.push({ probe: "native-opaque-compaction-replay", reasoning: "low", outcome: "passed" });
    process.stdout.write(JSON.stringify({ outcome: "passed", acquisition: "local_oauth",
      provider: model.provider, model: model.id, evidence }) + "\n");
  } finally {
    const after = await readCredentialDocumentFile(reference.path);
    assert(after.state === "ok" && after.revision === before.revision,
      "External local_oauth document changed during the experiment");
  }

  async function native(target: Model<string>, body: Readonly<Record<string, unknown>>, callerSignal: AbortSignal): Promise<WireResponse> {
    const response = await sendWithPiEnvelope(models, target, body, 1, {
      fetch: globalThis.fetch, signal: callerSignal, pi: { sessionId: "token-pi-native-context-experiment" },
    });
    assert.equal(response.bodyUsed, false, "Pi consumed the real response");
    assert.equal(response.status, 200, `Native upstream status ${response.status}`);
    const raw = await response.text();
    const eventTypes = new Set<string>();
    const completedItems: Array<Record<string, unknown>> = [];
    const terminal = raw.split(/\r?\n\r?\n/).flatMap((frame) => {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return [];
      const event = JSON.parse(data) as { type: string; response?: WireResponse; item?: Record<string, unknown> };
      if (/^response\.[a-z_.]+$/.test(event.type)) eventTypes.add(event.type);
      if (event.type === "response.output_item.done" && event.item) completedItems.push(event.item);
      return (event.type === "response.completed" || event.type === "response.done") && event.response ? [event.response] : [];
    }).at(-1);
    process.stdout.write(JSON.stringify({ stage, status: response.status,
      terminal: terminal?.status ?? null, eventTypes: [...eventTypes].slice(0, 24),
      terminalItems: terminal?.output?.length ?? 0, completedItemTypes: completedItems.map((item) => item.type) }) + "\n");
    assert(terminal?.status === "completed", "Raw native SSE has no successful terminal");
    // Test-side consumption only: Codex can put completed items in dedicated
    // events rather than repeating them in response.completed.response.output.
    return { ...terminal, output: terminal.output?.length ? terminal.output : completedItems };
  }
}

function text(response: WireResponse): string {
  return response.output.filter((item) => item.type === "message").flatMap((item) =>
    Array.isArray(item.content) ? item.content.flatMap((part: { type?: string; text?: string }) =>
      part.type === "output_text" && typeof part.text === "string" ? [part.text] : []) : []).join("");
}

main().catch(() => {
  // SDK/provider errors can contain credential or request details. Keep the
  // terminal bounded and let assertion labels identify the failed stage.
  process.stderr.write(JSON.stringify({ outcome: "failed", stage }) + "\n");
  process.exitCode = 1;
});
