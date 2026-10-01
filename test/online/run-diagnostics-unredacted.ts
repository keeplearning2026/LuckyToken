/** Real Commandcode transport certification; all credentials/state are disposable.
 * Direct uses a test-only gateway mapping of its fixed URL to Commandcode Responses.
 * Anthropic Native uses an Anthropic model fixture at Commandcode's Messages gateway;
 * neither mapping changes production routing or the native certification table.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { FetchFunction, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { createDiagnosticsAuthority, parseDiagnosticsConfiguration } from "../../src/diagnostics/index.js";
import { createCodexDirectResponsesLane } from "../../src/integrations/codex/direct-responses.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { identityRequestModelResolver } from "../../src/protocols/options.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import { createTokenRuntime } from "../../src/runtime.js";
import { startTokenHttpServer } from "../../src/server.js";
import { createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { createProfileBoundPiExecution } from "../../src/credentials/profile-bound-pi-execution.js";
import { execute, type ExecutionOperation } from "../../src/execution.js";
import { createConfiguredPiModels } from "../support/configured-data-plane.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";
import { loginOnlineProvider } from "./provider-login.js";

const variants = [
  ["responses", "direct"], ["responses", "provider_native"], ["responses", "semantic_conversion"],
  ["anthropic", "provider_native"], ["anthropic", "semantic_conversion"],
] as const;
const GOAT_MODEL = "deepseek/deepseek-v4.1-flash";
const PRIVATE_MODEL = `commandcode-private/${GOAT_MODEL}`;
let stage = "setup";
let credential = "";

async function run(): Promise<void> {
  assert(process.env.CODEX_HOME && process.env.TOKEN_TEST_CODEX_SANDBOX === "1", "requires repository Codex test sandbox");
  const key = (await readFile("CommandcodeAPIKey.txt", "utf8")).trim();
  credential = key;
  assert(key.length > 0, "key file is empty");
  const root = await mkdtemp(join(tmpdir(), "Token-online-diagnostics-"));
  const configuration = parseDiagnosticsConfiguration({ directory: join(root, "diagnostics") }, root);
  const authority = await createDiagnosticsAuthority({ configuration,
    journeyCapturePolicy: { snapshot: () => ({ allRequestsEnabled: true, failedRequestsEnabled: true }) } });
  let requestBytes = Buffer.alloc(0);
  let responseBytes = Buffer.alloc(0);
  let payloadBytes: Buffer | undefined;
  let terminalBytes: Buffer | undefined;
  const inaccessible: string[] = [];
  let upstreamStatus = 0;
  const baseFetch = globalThis.fetch;
  const capturingFetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    requestBytes = Buffer.from(await request.clone().arrayBuffer());
    const response = await baseFetch(request);
    upstreamStatus = response.status;
    responseBytes = Buffer.from(await response.clone().arrayBuffer());
    return response;
  };
  let server: Awaited<ReturnType<typeof startTokenHttpServer>> | undefined;
  try {
    stage = "provider-runtime";
    const credentialRecordStore = createInMemoryProviderCredentialRecordStore({ createRevision: randomUUID });
    const pi = await createConfiguredPiModels({ piDirectory: join(root, "pi"),
      commandCodeModelsPath: join(root, "commandcode-models.json"), credentialRecordStore, fetch: capturingFetch });
    for (const providerId of ["commandcode-private", "commandcode-goat"]) {
      stage = `login/${providerId}`;
      await loginOnlineProvider({ ...pi, providerId, authType: "api_key", displayName: "Diagnostics certification",
        interaction: { prompt: async () => key, notify: () => undefined } });
    }
    const models = {
      getModels: pi.models.getModels.bind(pi.models), getAuth: pi.models.getAuth.bind(pi.models),
      streamSimple(model: Model<string>, context: Parameters<Models["streamSimple"]>[1], options?: ModelsSimpleStreamOptions) {
        return pi.models.streamSimple(model, context, { ...options, async onPayload(payload, selected) {
          payloadBytes = Buffer.from(JSON.stringify(payload));
          return options?.onPayload?.(payload, selected);
        } });
      },
    } as unknown as Models;
    const boundExecution = createProfileBoundPiExecution({ bindings: pi.providerAuthBindings, execute, resolveCredentialActivity: () => undefined });
    const executeOperation: ExecutionOperation = async (...args) => {
      const terminal = await boundExecution(...args);
      terminalBytes = Buffer.from(JSON.stringify(terminal));
      return terminal;
    };
    const nativeAnthropicModel: Model<string> = {
      id: "claude-haiku-4-5-20251001", name: "Online Messages gateway fixture", provider: "anthropic",
      api: "anthropic-messages", baseUrl: "https://api.commandcode.ai/provider", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 128,
    };
    const nativeAnthropicModels = { getModels: () => [nativeAnthropicModel], getAuth: async () => ({ auth: { apiKey: key } }) } as unknown as Models;
    for (const [protocol, lane] of variants) for (const streaming of [false, true]) {
      stage = `${protocol}/${lane}/${streaming ? "SSE" : "JSON"}`;
      const requestId = randomUUID();
      const marker = `diagnostics-evidence-${requestId}`;
      const selector = lane === "direct" ? GOAT_MODEL : protocol === "anthropic" && lane === "provider_native"
        ? `anthropic/${nativeAnthropicModel.id}` : lane === "provider_native" ? `commandcode-goat/${GOAT_MODEL}` : PRIVATE_MODEL;
      const providerFetch: FetchFunction = lane === "direct"
        ? async (input, init) => {
          const original = new Request(input, init);
          const upstream = await capturingFetch(new Request("https://api.commandcode.ai/provider/v1/responses", original));
          // Node fetch decodes compression. The test gateway exposes those
          // decoded bytes without the remote compressed-length/encoding fields.
          const headers = new Headers(upstream.headers);
          headers.delete("content-encoding"); headers.delete("content-length");
          return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
        } : capturingFetch;
      const handler = protocol === "anthropic"
        ? createAnthropicMessagesHandler({ models: lane === "provider_native" ? nativeAnthropicModels : models, executeOperation, maxRequestBytes: 65536,
          ...(lane === "provider_native" ? { providerNativeLane: createAnthropicProviderNativeLane({ models: nativeAnthropicModels,
            bindings: ambientProfileBindings, resolveRequestModel: identityRequestModelResolver, fetch: providerFetch }) } : {}) })
        : createOpenAIResponsesHandler({ models, executeOperation, stateFile: join(root, `${lane}.json`), maxRequestBytes: 65536,
          ...(lane === "direct" ? { directLane: createCodexDirectResponsesLane({ models: { has: (id) => id === GOAT_MODEL }, fetch: providerFetch }) } : {}),
          ...(lane === "provider_native" ? { providerNativeLane: createProviderNativeResponses({ models, bindings: pi.providerAuthBindings, fetch: providerFetch }) } : {}) });
      server = await startTokenHttpServer({ runtime: createTokenRuntime({ clientProtocols: [handler] }), diagnostics: authority,
        createRequestId: () => requestId, port: 0 });
      const body = Buffer.from(JSON.stringify(protocol === "anthropic"
        ? { model: selector, stream: streaming, max_tokens: 128, messages: [{ role: "user", content: `Reply OK. Reference: ${marker}` }] }
        : { model: selector, stream: streaming, max_output_tokens: 128, input: `Reply OK. Reference: ${marker}` }) + "\r\n");
      payloadBytes = undefined;
      terminalBytes = undefined;
      const response = await baseFetch(`${server.origin}/v1/${protocol === "anthropic" ? "messages" : "responses"}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${lane === "direct" ? key : "local-test"}`, "anthropic-version": "2023-06-01" },
        body, signal: AbortSignal.timeout(90000),
      });
      const clientBytes = Buffer.from(await response.arrayBuffer());
      const detail = await authority.getRequestJourney({ requestId });
      assert.equal(detail.lane, lane);
      const expected = new Map<string, Buffer>([["client_request_wire", body], ["client_response_wire", clientBytes]]);
      if (lane === "direct") {
        expected.set("direct_outbound_request_wire", requestBytes);
        expected.set("direct_upstream_response_wire", responseBytes);
      } else if (lane === "provider_native") {
        expected.set("provider_native_outbound_request_wire.1", requestBytes);
        expected.set("provider_native_upstream_response_wire.1", responseBytes);
        if (response.ok) expected.set("provider_native_preserved_response_wire", clientBytes);
      } else {
        assert(payloadBytes, "semantic payload boundary was not reached");
        expected.set("pi_provider_request_payload", payloadBytes);
        assert(terminalBytes, "semantic response boundary was not reached");
        expected.set("pi_provider_response_ir", terminalBytes);
        assert(!detail.artifacts.some((a) => a.artifactKind.includes("upstream_response_wire")));
      }
      for (const [artifactId, bytes] of expected) {
        const ref = await authority.resolveRequestArtifactFile({ requestId, artifactId });
        assert.equal(basename(join(ref.absolutePath, "..", "..")), requestId);
        assert.deepEqual(await readFile(ref.absolutePath), bytes, `${protocol}/${lane}/${artifactId} differs`);
        const read = await authority.getRequestArtifact({ requestId, artifactId, offset: 0, limit: 262144 });
        assert.deepEqual(Buffer.from(read.dataBase64, "base64"), bytes);
      }
      assert(!JSON.stringify(detail).includes(marker));
      assert(!JSON.stringify(detail).includes(key));
      for (const a of detail.artifacts.filter((a) => a.state === "captured" && a.artifactId.includes("envelope"))) {
        const ref = await authority.resolveRequestArtifactFile({ requestId, artifactId: a.artifactId });
        assert(!(await readFile(ref.absolutePath)).includes(Buffer.from(key)));
      }
      for (const entry of await readdir(configuration.directory)) if (entry.startsWith("diagnostics-v5.sqlite3")) {
        const bytes = await readFile(join(configuration.directory, entry));
        assert(!bytes.includes(Buffer.from(marker))); assert(!bytes.includes(Buffer.from(key)));
      }
      console.log(JSON.stringify({ protocol, lane, streaming, clientStatus: response.status, upstreamStatus, outcome: detail.outcome,
        checkedArtifacts: expected.size, directoryIsRequestId: true, rawBodyRead: true, indexSecretFree: true }));
      if (protocol === "anthropic" && lane === "provider_native" && response.status === 403) inaccessible.push(stage);
      else { assert(response.ok, `online ${stage} HTTP ${response.status}`); assert.equal(detail.outcome, "success"); }
      await server.close(); server = undefined;
    }
    assert.equal(inaccessible.length, 0, `Messages gateway denied access for ${inaccessible.join(", ")}; failure evidence passed, online native success is unverified`);
  } finally { await server?.close(); await authority.close(); await rm(root, { recursive: true, force: true }); }
}

run().catch((error: unknown) => {
  // Avoid ever emitting credential-bearing upstream error messages or captures.
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(JSON.stringify({ stage, error: credential ? message.replaceAll(credential, "[credential]").slice(0, 240) : "setup failure" }));
  process.exitCode = 1;
});
