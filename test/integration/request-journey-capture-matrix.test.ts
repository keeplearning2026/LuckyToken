import type { AssistantMessage, AssistantMessageEventStream, Context, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDiagnosticsAuthority, parseDiagnosticsConfiguration } from "../../src/diagnostics/index.js";
import { createCodexDirectResponsesLane } from "../../src/integrations/codex/direct-responses.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { identityRequestModelResolver } from "../../src/protocols/options.js";
import { createAnthropicProviderNativeLane } from "../../src/provider-native-anthropic/index.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { createTokenRuntime } from "../../src/runtime.js";
import { startTokenHttpServer } from "../../src/server.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";

const CANARY = "matrix-body-secret-canary-52181";
const HEADER_CANARY = "matrix-header-secret-canary-52381";
const variants = [
  ["responses", "direct"], ["responses", "provider_native"], ["responses", "semantic_conversion"],
  ["anthropic", "provider_native"], ["anthropic", "semantic_conversion"],
] as const;
const policies = [[true, true], [true, false], [false, true], [false, false]] as const;

describe.each(variants)("%s / %s complete capture", (protocol, lane) => {
  it.each(policies)("certifies all=%s, failed=%s against the composed HTTP lane", async (all, failed) => {
    const root = await mkdtemp(join(tmpdir(), "Token-capture-matrix-"));
    let policyAll = all;
    let policyFailed = failed;
    const authority = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: join(root, "diagnostics") }, root),
      journeyCapturePolicy: { snapshot: () => ({ allRequestsEnabled: policyAll, failedRequestsEnabled: policyFailed }) },
    });
    let failure = false;
    let blocked = false;
    let upstreamStarted: () => void = () => undefined;
    const waitForAbort = async (signal: AbortSignal | undefined) => {
      if (signal === undefined) throw new Error("fixture cancellation signal missing");
      upstreamStarted();
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw signal.reason;
    };
    let requestId = randomUUID();
    let outbound = Buffer.alloc(0);
    let upstream = Buffer.alloc(0);
    let payload: unknown;
    let terminal: AssistantMessage | undefined;
    const model: Model<string> = {
      id: "fixture-model", name: "Fixture", provider: protocol === "anthropic" ? "anthropic" : "openai",
      api: protocol === "anthropic" ? "anthropic-messages" : "openai-responses",
      baseUrl: "https://provider.example.test/v1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
    };
    const models = {
      getModels: () => [model], getAuth: async () => ({ auth: { apiKey: HEADER_CANARY } }),
      streamSimple(selected: Model<string>, context: Context, options?: ModelsSimpleStreamOptions) {
        return { async *[Symbol.asyncIterator]() {
          payload = { model: selected.id, messages: context.messages, stream: true, secret: CANARY };
          await options?.onPayload?.(payload, selected);
          if (blocked) await waitForAbort(options?.signal);
          await options?.onResponse?.({ status: failure ? 502 : 200, headers: { "request-id": "safe-request", "set-cookie": HEADER_CANARY } }, selected);
          terminal = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [{ type: "text", text: CANARY }],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: failure ? "error" : "stop", timestamp: 1,
            ...(failure ? { errorMessage: "Fixture unavailable" } : {}),
          };
          if (failure) yield { type: "error", reason: "error", error: terminal };
          else yield { type: "done", reason: "stop", message: terminal };
        } } as unknown as AssistantMessageEventStream;
      },
    } as unknown as Models;
    const providerFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      outbound = Buffer.from(await request.arrayBuffer());
      if (blocked) await waitForAbort(request.signal);
      upstream = Buffer.from(failure
        ? JSON.stringify({ error: { type: "server_error", message: "Fixture unavailable", secret: CANARY } })
        : protocol === "anthropic"
          ? JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: model.id,
            content: [{ type: "text", text: CANARY }], stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } })
          : JSON.stringify({ id: "resp_fixture", object: "response", model: model.id, status: "completed",
            output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: CANARY, annotations: [] }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
      return new Response(upstream, { status: failure ? 502 : 200, headers: { "content-type": "application/json", "set-cookie": HEADER_CANARY } });
    };
    const handler = protocol === "anthropic"
      ? createAnthropicMessagesHandler({ models, maxRequestBytes: 8192,
        ...(lane === "provider_native" ? { providerNativeLane: createAnthropicProviderNativeLane({ models, bindings: ambientProfileBindings, resolveRequestModel: identityRequestModelResolver, fetch: providerFetch }) } : {}) })
      : createOpenAIResponsesHandler({ models, stateFile: join(root, "responses.json"), maxRequestBytes: 8192,
        ...(lane === "direct" ? { directLane: createCodexDirectResponsesLane({ models: { has: (id) => id === "direct-fixture" }, fetch: providerFetch }) } : {}),
        ...(lane === "provider_native" ? { providerNativeLane: createProviderNativeResponses({ models, bindings: ambientProfileBindings, fetch: providerFetch }) } : {}) });
    const runtime = createTokenRuntime({ clientProtocols: [handler] });
    const server = await startTokenHttpServer({ runtime, diagnostics: authority, createRequestId: () => requestId, port: 0 });
    try {
      for (const abnormal of [false, true]) {
        failure = abnormal;
        requestId = randomUUID();
        const body = Buffer.from(JSON.stringify(protocol === "anthropic"
          ? { model: `${model.provider}/${model.id}`, messages: [{ role: "user", content: CANARY }], max_tokens: 16 }
          : { model: lane === "direct" ? "direct-fixture" : `${model.provider}/${model.id}`, input: CANARY, max_output_tokens: 16 }) + "\r\n");
        const response = await fetch(`${server.origin}/v1/${protocol === "anthropic" ? "messages" : "responses"}`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${HEADER_CANARY}`, "anthropic-version": "2023-06-01" }, body,
        });
        const clientResponse = Buffer.from(await response.arrayBuffer());
        expect(response.status >= 400).toBe(abnormal);
        const detail = await authority.getRequestJourney({ requestId });
        expect(detail).toMatchObject({ lane, outcome: abnormal ? "failed" : "success" });
        expect(JSON.stringify(detail)).not.toContain(CANARY);
        expect(JSON.stringify(detail)).not.toContain(HEADER_CANARY);
        const retained = all || (abnormal && failed);
        const expected = new Map<string, Buffer>([["client_request_wire", body], ["client_response_wire", clientResponse]]);
        if (lane === "direct") {
          expected.set("direct_outbound_request_wire", outbound);
          expected.set("direct_upstream_response_wire", upstream);
        } else if (lane === "provider_native") {
          expected.set("provider_native_outbound_request_wire.1", outbound);
          expected.set("provider_native_upstream_response_wire.1", upstream);
          if (!abnormal || protocol === "responses") expected.set("provider_native_preserved_response_wire", clientResponse);
        } else {
          expected.set("pi_provider_request_payload", Buffer.from(JSON.stringify(payload)));
          if (!abnormal) expected.set("pi_provider_response_ir", Buffer.from(JSON.stringify(terminal)));
          expect(detail.artifacts.some((artifact) => artifact.artifactKind.includes("upstream_response_wire"))).toBe(false);
        }
        for (const [artifactId, bytes] of expected) {
          const descriptor = detail.artifacts.find((artifact) => artifact.artifactId === artifactId);
          expect(descriptor, artifactId).toBeDefined();
          if (!retained) {
            expect(descriptor).toMatchObject({ state: "unavailable", capturedBytes: 0 });
            await expect(authority.resolveRequestArtifactFile({ requestId, artifactId })).rejects.toThrow(/unavailable/u);
          } else {
            expect(descriptor).toMatchObject({ state: "captured", originalBytes: bytes.length, capturedBytes: bytes.length, truncated: false });
            const ref = await authority.resolveRequestArtifactFile({ requestId, artifactId });
            expect(await readFile(ref.absolutePath), artifactId).toEqual(bytes);
          }
        }
        if (retained) for (const descriptor of detail.artifacts.filter((artifact) => artifact.artifactId.includes("envelope") || artifact.artifactId === "pi_provider_response_metadata")) {
          const ref = await authority.resolveRequestArtifactFile({ requestId, artifactId: descriptor.artifactId });
          expect((await readFile(ref.absolutePath)).toString("utf8")).not.toContain(HEADER_CANARY);
        }
      }
      // An external admission owner seals interruption before stopping execution.
      // Cancellation uses the actual HTTP connection and upstream AbortSignal.
      for (const outcome of ["aborted", "interrupted"] as const) {
        policyAll = all;
        policyFailed = failed;
        blocked = true;
        failure = false;
        requestId = randomUUID();
        const body = Buffer.from(JSON.stringify(protocol === "anthropic"
          ? { model: `${model.provider}/${model.id}`, messages: [{ role: "user", content: CANARY }], max_tokens: 16 }
          : { model: lane === "direct" ? "direct-fixture" : `${model.provider}/${model.id}`, input: CANARY, max_output_tokens: 16 }));
        const controller = new AbortController();
        const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
        const observer = outcome === "interrupted" ? authority.begin({ requestId,
          operationCandidate: "model_generation", transport: "in_process", method: "POST",
          path: `/v1/${protocol === "anthropic" ? "messages" : "responses"}`, acceptedAt: Date.now(),
          cancellation: { caller: "active", shutdown: "not_bound" } }) : undefined;
        const request = new Request(`${server.origin}/v1/${protocol === "anthropic" ? "messages" : "responses"}`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${HEADER_CANARY}`, "anthropic-version": "2023-06-01" }, body, signal: controller.signal,
        });
        const pending = (observer === undefined ? fetch(request) : runtime.handle(request, { requestId, journey: observer, transport: "in_process" }))
          .then((response) => response.arrayBuffer()).catch(() => undefined);
        await Promise.race([started, pending.then(() => { throw new Error(`${protocol}/${lane}/${outcome} settled before upstream started`); })]);
        policyAll = !all;
        policyFailed = !failed;
        observer?.close({ outcome: "interrupted", lastKnownLocation: { phase: "upstream_execution", step: "dispatch_provider_request" } });
        controller.abort(new Error("fixture owner stopped request"));
        await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${protocol}/${lane}/${outcome} did not stop after cancellation`)), 1500))]);
        let detail = await authority.getRequestJourney({ requestId });
        for (let poll = 0; detail.outcome === "running" && poll < 100; poll += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          detail = await authority.getRequestJourney({ requestId });
        }
        expect(detail).toMatchObject({ lane, outcome });
        const descriptor = detail.artifacts.find((artifact) => artifact.artifactId === "client_request_wire");
        if (all || failed) {
          expect(descriptor).toMatchObject({ state: "captured", capturedBytes: body.length });
          const ref = await authority.resolveRequestArtifactFile({ requestId, artifactId: "client_request_wire" });
          expect(await readFile(ref.absolutePath)).toEqual(body);
        } else {
          expect(descriptor).toMatchObject({ state: "unavailable", capturedBytes: 0 });
          await expect(authority.resolveRequestArtifactFile({ requestId, artifactId: "client_request_wire" })).rejects.toThrow(/unavailable/u);
        }
      }
    } finally { await server.close(); await authority.close(); await rm(root, { recursive: true, force: true }); }
  });
});
