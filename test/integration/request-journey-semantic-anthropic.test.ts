import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createUpstreamFailureFact } from "@token/provider-contract/diagnostics";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type DiagnosticsAuthority,
} from "../../src/diagnostics/index.js";
import {
  ExecutionFailure,
  type ExecutionOperation,
} from "../../src/execution.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { defaultAnthropicModelValidityPolicy } from "../../src/protocols/anthropic/representability.js";
import { createTokenRuntime } from "../../src/runtime.js";
import {
  startTokenHttpServer,
  type RunningTokenHttpServer,
} from "../../src/server.js";

const REQUEST_ID = "73000000-0000-4000-8000-000000000001";
const CLIENT_SECRET = "anthropic-client-secret-canary";

const model: Model<string> = {
  id: "semantic-model",
  name: "Semantic Model",
  api: "anthropic-messages",
  provider: "semantic-provider",
  baseUrl: "https://provider.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const terminal: AssistantMessage = {
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: "text", text: "anthropic semantic evidence" }],
  usage: {
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

async function artifactJson(
  authority: DiagnosticsAuthority,
  artifactId: string,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    const page = await authority.getRequestArtifact({
      requestId: REQUEST_ID,
      artifactId,
      offset,
      limit: 256 * 1_024,
    });
    chunks.push(Buffer.from(page.dataBase64, "base64"));
    if (page.complete) break;
    offset = page.nextOffset;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

describe("Anthropic Messages Semantic Conversion full Journey", () => {
  it("captures Client JSON, protocol-owned Pi invocation, Provider request payload, decoded Pi response, and Client response", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-semantic-anthropic-"));
    let authority: DiagnosticsAuthority | undefined;
    let server: RunningTokenHttpServer | undefined;
    try {
      authority = await createDiagnosticsAuthority({
        configuration: parseDiagnosticsConfiguration(
          { directory: join(root, "diagnostics") },
          root,
        ),
        journeyCapturePolicy: {
          snapshot: () => Object.freeze({
            allRequestsEnabled: true,
            failedRequestsEnabled: true,
          }),
        },
      });
      const streamSimple = vi.fn(
        (
          _model: Model<string>,
          _context: unknown,
          options?: ModelsSimpleStreamOptions,
        ) => {
          expect(options?.timeoutMs).toBe(345_678);
          let emitted = false;
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                if (emitted) return { done: true as const, value: undefined };
                emitted = true;
                await options?.onPayload?.(
                  {
                    model: model.id,
                    max_tokens: 24,
                    messages: [{ role: "user", content: "diagnose anthropic" }],
                    stream: true,
                  },
                  model,
                );
                await options?.onResponse?.(
                  {
                    status: 200,
                    headers: { "request-id": "anthropic-provider-response" },
                  },
                  model,
                );
                return {
                  done: false as const,
                  value: { type: "done", reason: "stop", message: terminal },
                };
              },
            }),
          } as AssistantMessageEventStream;
        },
      );
      const models = {
        getModels: () => [model],
        streamSimple,
      } as unknown as Models;
      const handler = createAnthropicMessagesHandler({
        models,
        modelValidityPolicy: defaultAnthropicModelValidityPolicy,
        maxRequestBytes: 1_000_000,
        requestTimeoutMs: 345_678,
        routerDefaults: {},
        createMessageId: () => "msg_semantic_evidence",
        now: () => 1_787_600_100_000,
      });
      server = await startTokenHttpServer({
        runtime: createTokenRuntime({ clientProtocols: [handler] }),
        diagnostics: authority,
        createRequestId: () => REQUEST_ID,
        port: 0,
      });

      const response = await fetch(`${server.origin}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_SECRET}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: `${model.provider}/${model.id}`,
          max_tokens: 24,
          messages: [{ role: "user", content: "diagnose anthropic" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "msg_semantic_evidence",
        content: [{ type: "text", text: "anthropic semantic evidence" }],
      });
      expect(streamSimple).toHaveBeenCalledOnce();

      await server.close();
      server = undefined;
      const detail = await authority.getRequestJourney({ requestId: REQUEST_ID });
      expect(detail).toMatchObject({
        protocol: "anthropic-messages",
        lane: "semantic_conversion",
        outcome: "success",
      });
      expect(detail.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ artifactId: "client_request_wire", state: "captured" }),
          expect.objectContaining({ artifactId: "pi_invocation_snapshot", state: "captured" }),
          expect.objectContaining({
            artifactId: "pi_provider_request_payload",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "pi_provider_response_metadata",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "pi_provider_response_ir",
            state: "captured",
          }),
          expect.objectContaining({ artifactId: "client_response_wire", state: "captured" }),
        ]),
      );
      const artifactIds = detail.artifacts.map((artifact) => artifact.artifactId);
      expect(artifactIds).not.toContain("pi_provider_final_request_wire");
      expect(artifactIds).not.toContain("pi_provider_raw_response_wire");

      const providerRequest = await artifactJson(
        authority,
        "pi_provider_request_payload",
      );
      expect(providerRequest).toMatchObject({
        model: model.id,
        max_tokens: 24,
        stream: true,
      });
      const invocation = await artifactJson(authority, "pi_invocation_snapshot");
      expect(invocation).toEqual(expect.objectContaining({
        reasoning: expect.any(Object),
        supplement: expect.any(Object),
        context: expect.any(Object),
        options: expect.any(Object),
        client: expect.any(Object),
      }));
      const providerResponse = await artifactJson(
        authority,
        "pi_provider_response_ir",
      );
      expect(providerResponse).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "anthropic semantic evidence" }],
        stopReason: "stop",
      });
      expect(JSON.stringify({ invocation, providerRequest, providerResponse })).not.toContain(
        CLIENT_SECRET,
      );
    } finally {
      await Promise.allSettled([
        server?.close() ?? Promise.resolve(),
        authority?.close() ?? Promise.resolve(),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures the Provider request boundary and marks unreached response evidence on failure", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "Token-semantic-anthropic-failure-"),
    );
    const requestId = "73000000-0000-4000-8000-000000000002";
    let authority: DiagnosticsAuthority | undefined;
    let server: RunningTokenHttpServer | undefined;
    try {
      authority = await createDiagnosticsAuthority({
        configuration: parseDiagnosticsConfiguration(
          { directory: join(root, "diagnostics") },
          root,
        ),
        journeyCapturePolicy: {
          snapshot: () => Object.freeze({
            allRequestsEnabled: true,
            failedRequestsEnabled: true,
          }),
        },
      });
      const semanticExecution: ExecutionOperation = vi.fn(
        async (_models, selectedModel, context, options) => {
          await options.onPayload?.(
            {
              model: selectedModel.id,
              max_tokens: options.maxTokens,
              messages: context.messages,
              stream: true,
            },
            selectedModel,
          );
          throw new ExecutionFailure(
            "Pi execution failed before response headers",
            undefined,
            createUpstreamFailureFact({
              kind: "http",
              status: 503,
              statusText: "Service Unavailable",
              providerType: "overloaded_error",
              message: "Provider is temporarily overloaded",
              retryable: false,
              attemptCount: 1,
            }),
          );
        },
      );
      const models = {
        getModels: () => [model],
      } as unknown as Models;
      const handler = createAnthropicMessagesHandler({
        models,
        executeOperation: semanticExecution,
        modelValidityPolicy: defaultAnthropicModelValidityPolicy,
        maxRequestBytes: 1_000_000,
        routerDefaults: {},
        createMessageId: () => "msg_semantic_failure",
        now: () => 1_787_600_100_100,
      });
      server = await startTokenHttpServer({
        runtime: createTokenRuntime({ clientProtocols: [handler] }),
        diagnostics: authority,
        createRequestId: () => requestId,
        port: 0,
      });

      const response = await fetch(`${server.origin}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_SECRET}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: `${model.provider}/${model.id}`,
          max_tokens: 24,
          messages: [{ role: "user", content: "diagnose failure" }],
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("Provider is temporarily overloaded");

      await server.close();
      server = undefined;
      const detail = await authority.getRequestJourney({ requestId });
      expect(detail).toMatchObject({
        protocol: "anthropic-messages",
        lane: "semantic_conversion",
        outcome: "failed",
      });
      expect(detail.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: "pi_provider_request_payload",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "pi_provider_response_metadata",
            state: "unavailable",
            reason: "provider_response_headers_not_reached",
          }),
          expect.objectContaining({
            artifactId: "pi_provider_response_ir",
            state: "unavailable",
            reason: "provider_response_not_decoded",
          }),
          expect.objectContaining({
            artifactId: "client_response_wire",
            state: "captured",
          }),
        ]),
      );
      const artifactIds = detail.artifacts.map((artifact) => artifact.artifactId);
      expect(artifactIds).not.toContain("pi_provider_final_request_wire");
      expect(artifactIds).not.toContain("pi_provider_raw_response_wire");
    } finally {
      await Promise.allSettled([
        server?.close() ?? Promise.resolve(),
        authority?.close() ?? Promise.resolve(),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
