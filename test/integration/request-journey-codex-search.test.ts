import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { CodexDirectModelSource } from "../../src/codex-direct-seam.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import {
  createOpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";

const directModels: CodexDirectModelSource = Object.freeze({
  has: () => false,
});

interface SearchJourneyHarness {
  readonly diagnostics: Awaited<ReturnType<typeof createDiagnosticsAuthority>>;
  readonly composition: Awaited<
    ReturnType<typeof createOpenAIResponsesServingTestComposition>
  >;
  readonly published: Promise<RequestJourneySummary>;
  close(): Promise<void>;
}

async function createSearchJourneyHarness(options?: Readonly<{
  fetch?: Parameters<typeof createOpenAIResponsesServingTestComposition>[0]["fetch"];
  maxRequestBytes?: number;
}>): Promise<SearchJourneyHarness> {
  const root = await mkdtemp(join(tmpdir(), "Token-search-journey-"));
  const diagnostics = await createDiagnosticsAuthority({
    configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    journeyCapturePolicy: {
      snapshot: () => ({
        allRequestsEnabled: true,
        failedRequestsEnabled: true,
      }),
    },
  });
  const composition = await createOpenAIResponsesServingTestComposition({
    clientApiKey: "client-token",
    commandCodeApiKey: "provider-secret",
    commandCodeBaseUrl: "https://commandcode.test",
    fetch:
      options?.fetch ??
      (async () =>
        new Response(Uint8Array.from([0x7b, 0x7d]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
    modelId: "deepseek/deepseek-v4-flash",
    codexDirectModels: directModels,
    diagnostics,
    ...(options?.maxRequestBytes === undefined
      ? {}
      : { maxRequestBytes: options.maxRequestBytes }),
  });
  let publish!: (record: RequestJourneySummary) => void;
  const published = new Promise<RequestJourneySummary>((resolve) => {
    publish = resolve;
  });
  const subscription = diagnostics.subscribeRequestJourneys((record) => {
    publish(record);
  });
  return {
    diagnostics,
    composition,
    published,
    async close() {
      subscription.unsubscribe();
      await composition.close();
      await diagnostics.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Request Journey Codex Direct Mode web search", () => {
  it("publishes decoded client and rewritten outbound request artifacts", async () => {
    const harness = await createSearchJourneyHarness();
    const { composition, diagnostics, published } = harness;

    try {
      const response = await composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          headers: { authorization: "Bearer codex-token" },
          body: '{"model":"caller-model","query":"hello","input":{"model":"nested","options":{"limit":5}}}',
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.has("x-token-request-id")).toBe(false);
      const summary = await published;
      expect(summary.path).toBe("/v1/alpha/search");

      const detail = await diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect({
        operation: detail.operation,
        protocol: detail.protocol,
        lane: detail.lane,
        outcome: detail.outcome,
        workOutcome: detail.workOutcome,
      }).toMatchObject({
        operation: "web_search",
        protocol: "codex-alpha-search",
        lane: "direct",
        outcome: "success",
        workOutcome: {
          outcome: "success",
          terminalAuthority: "codex_direct_search_handler",
        },
      });
      expect(detail.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: "client_request_wire",
            artifactKind: "client_request_wire",
            state: "captured",
            mediaType: "application/json",
          }),
          expect.objectContaining({
            artifactId: "direct_outbound_request_wire",
            artifactKind: "direct_outbound_request_wire",
            state: "captured",
            mediaType: "application/json",
          }),
        ]),
      );

      const clientArtifact = await diagnostics.getRequestArtifact({
        requestId: summary.requestId,
        artifactId: "client_request_wire",
        offset: 0,
        limit: 256 * 1_024,
      });
      const outboundArtifact = await diagnostics.getRequestArtifact({
        requestId: summary.requestId,
        artifactId: "direct_outbound_request_wire",
        offset: 0,
        limit: 256 * 1_024,
      });
      expect(
        JSON.parse(
          Buffer.from(clientArtifact.dataBase64, "base64").toString("utf8"),
        ),
      ).toEqual({
        model: "caller-model",
        query: "hello",
        input: { model: "nested", options: { limit: 5 } },
      });
      expect(
        JSON.parse(
          Buffer.from(outboundArtifact.dataBase64, "base64").toString("utf8"),
        ),
      ).toEqual({
        model: "gpt-6-luna",
        query: "hello",
        input: { model: "nested", options: { limit: 5 } },
      });
    } finally {
      await harness.close();
    }
  });

  it("persists zstd request artifacts as decoded JSON representations", async () => {
    const harness = await createSearchJourneyHarness();
    const clientBody = Buffer.from(
      '{"model":"caller-model","query":"compressed","input":{"model":"nested"}}',
      "utf8",
    );

    try {
      const response = await harness.composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "zstd",
          },
          body: zstdCompressSync(clientBody),
        }),
      );
      expect(response.status).toBe(200);

      const summary = await harness.published;
      const detail = await harness.diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect(detail.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: "client_request_wire",
            state: "captured",
          }),
          expect.objectContaining({
            artifactId: "direct_outbound_request_wire",
            state: "captured",
          }),
        ]),
      );

      const clientArtifact = await harness.diagnostics.getRequestArtifact({
        requestId: summary.requestId,
        artifactId: "client_request_wire",
        offset: 0,
        limit: 256 * 1_024,
      });
      const outboundArtifact = await harness.diagnostics.getRequestArtifact({
        requestId: summary.requestId,
        artifactId: "direct_outbound_request_wire",
        offset: 0,
        limit: 256 * 1_024,
      });
      expect(
        JSON.parse(
          Buffer.from(clientArtifact.dataBase64, "base64").toString("utf8"),
        ),
      ).toEqual({
        model: "caller-model",
        query: "compressed",
        input: { model: "nested" },
      });
      expect(
        JSON.parse(
          Buffer.from(outboundArtifact.dataBase64, "base64").toString("utf8"),
        ),
      ).toEqual({
        model: "gpt-6-luna",
        query: "compressed",
        input: { model: "nested" },
      });
    } finally {
      await harness.close();
    }
  });

  it("keeps ingress encoding failures before Direct lane commitment", async () => {
    let contacted = false;
    const harness = await createSearchJourneyHarness({
      fetch: async () => {
        contacted = true;
        return new Response("{}");
      },
    });

    try {
      const response = await harness.composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "br",
          },
          body: '{"model":"caller-model"}',
        }),
      );
      expect(response.status).toBe(400);
      expect(contacted).toBe(false);

      const summary = await harness.published;
      const detail = await harness.diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect(detail.lane).toBeUndefined();
      expect(detail.artifacts).toContainEqual(
        expect.objectContaining({
          artifactId: "client_request_wire",
          artifactKind: "client_request_wire",
          state: "unavailable",
          reason: "unsupported_content_encoding",
        }),
      );
      expect(detail.artifacts).not.toContainEqual(
        expect.objectContaining({
          artifactId: "direct_outbound_request_wire",
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("records supported-encoding decode failure before Direct lane commitment", async () => {
    let contacted = false;
    const harness = await createSearchJourneyHarness({
      fetch: async () => {
        contacted = true;
        return new Response("{}");
      },
    });

    try {
      const response = await harness.composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
          body: Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
        }),
      );
      expect(response.status).toBe(400);
      expect(contacted).toBe(false);

      const summary = await harness.published;
      const detail = await harness.diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect(detail.lane).toBeUndefined();
      expect(detail.artifacts).toContainEqual(
        expect.objectContaining({
          artifactId: "client_request_wire",
          artifactKind: "client_request_wire",
          state: "unavailable",
          reason: "request_body_decode_failed",
        }),
      );
      expect(detail.artifacts).not.toContainEqual(
        expect.objectContaining({
          artifactId: "direct_outbound_request_wire",
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("records raw body overflow before Direct lane commitment", async () => {
    let contacted = false;
    const harness = await createSearchJourneyHarness({
      maxRequestBytes: 4,
      fetch: async () => {
        contacted = true;
        return new Response("{}");
      },
    });

    try {
      const response = await harness.composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          body: Uint8Array.from([1, 2, 3, 4, 5]),
        }),
      );
      expect(response.status).toBe(413);
      expect(contacted).toBe(false);

      const summary = await harness.published;
      const detail = await harness.diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect(detail.lane).toBeUndefined();
      expect(detail.artifacts).toContainEqual(
        expect.objectContaining({
          artifactId: "client_request_wire",
          state: "unavailable",
          reason: "request_body_exceeds_limit",
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps decoded-size overflow on the existing HTTP 400 contract", async () => {
    let contacted = false;
    const decodedBody = Buffer.from(
      JSON.stringify({ model: "caller-model", input: "a".repeat(256) }),
      "utf8",
    );
    const compressed = zstdCompressSync(decodedBody);
    expect(compressed.byteLength).toBeLessThanOrEqual(64);
    expect(decodedBody.byteLength).toBeGreaterThan(64);
    const harness = await createSearchJourneyHarness({
      maxRequestBytes: 64,
      fetch: async () => {
        contacted = true;
        return new Response("{}");
      },
    });

    try {
      const response = await harness.composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "zstd",
          },
          body: compressed,
        }),
      );
      expect(response.status).toBe(400);
      expect(contacted).toBe(false);

      const summary = await harness.published;
      const detail = await harness.diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect(detail.lane).toBeUndefined();
      expect(detail.artifacts).toContainEqual(
        expect.objectContaining({
          artifactId: "client_request_wire",
          state: "unavailable",
          reason: "request_body_exceeds_limit",
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("records request-body read failure before Direct lane commitment", async () => {
    const harness = await createSearchJourneyHarness({
      fetch: async () => new Response("must not execute"),
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("caller body failed"));
      },
    });

    try {
      const response = await harness.composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
      expect(response.status).toBe(500);

      const summary = await harness.published;
      const detail = await harness.diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect(detail.lane).toBeUndefined();
      expect(detail.artifacts).toContainEqual(
        expect.objectContaining({
          artifactId: "client_request_wire",
          state: "unavailable",
          reason: "request_body_read_failed",
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("records caller abort without committing the Direct lane", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(Uint8Array.from([0x7b]));
      },
    });
    const harness = await createSearchJourneyHarness({
      fetch: async () => new Response("must not execute"),
    });
    const controller = new AbortController();

    try {
      const handling = harness.composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          body,
          signal: controller.signal,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
      await Promise.resolve();
      controller.abort(new Error("client canceled search"));
      await expect(handling).rejects.toMatchObject({
        name: "HttpRequestAbortedError",
      });

      const summary = await harness.published;
      expect(summary.outcome).toBe("aborted");
      const detail = await harness.diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect(detail.lane).toBeUndefined();
      expect(detail.artifacts).toContainEqual(
        expect.objectContaining({
          artifactId: "client_request_wire",
          state: "unavailable",
          reason: "request_body_read_aborted",
        }),
      );
    } finally {
      try {
        bodyController?.close();
      } catch {
        // Abort may already have canceled and closed the request body stream.
      }
      await harness.close();
    }
  });

  it("commits Direct lane before rejecting a decoded body without a top-level model", async () => {
    let contacted = false;
    const harness = await createSearchJourneyHarness({
      fetch: async () => {
        contacted = true;
        return new Response("{}");
      },
    });

    try {
      const response = await harness.composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"query":"hello","input":{"model":"nested"}}',
        }),
      );
      expect(response.status).toBe(400);
      expect(contacted).toBe(false);

      const summary = await harness.published;
      const detail = await harness.diagnostics.getRequestJourney({
        requestId: summary.requestId,
      });
      expect(detail.lane).toBe("direct");
      expect(detail.artifacts).toContainEqual(
        expect.objectContaining({
          artifactId: "client_request_wire",
          state: "captured",
        }),
      );
      expect(detail.artifacts).not.toContainEqual(
        expect.objectContaining({
          artifactId: "direct_outbound_request_wire",
        }),
      );
    } finally {
      await harness.close();
    }
  });
});
