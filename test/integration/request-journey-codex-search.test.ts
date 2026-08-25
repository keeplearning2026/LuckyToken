import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CodexNativeModelSource } from "../../src/codex-native-seam.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import {
  createOpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";

const nativeModels: CodexNativeModelSource = Object.freeze({
  has: () => false,
});

describe("Request Journey Codex Direct Mode web search", () => {
  it("publishes web_search as a successful Direct Mode journey", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-search-journey-"));
    const diagnostics = await createDiagnosticsAuthority({
      configuration: parseDiagnosticsConfiguration({ directory: root }, root),
    });
    const composition = await createOpenAIResponsesServingTestComposition({
      clientApiKey: "client-token",
      commandCodeApiKey: "provider-secret",
      commandCodeBaseUrl: "https://commandcode.test",
      fetch: async () =>
        new Response(Uint8Array.from([0x7b, 0x7d]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      modelId: "deepseek/deepseek-v4-flash",
      codexNativeModels: nativeModels,
      diagnostics,
    });
    let publish!: (record: RequestJourneySummary) => void;
    const published = new Promise<RequestJourneySummary>((resolve) => {
      publish = resolve;
    });
    const subscription = diagnostics.subscribeRequestJourneys((record) => {
      publish(record);
    });

    try {
      const response = await composition.runtime.handle(
        new Request("http://Token.test/v1/alpha/search", {
          method: "POST",
          headers: { authorization: "Bearer codex-token" },
          body: Uint8Array.from([0x7b, 0x7d]),
        }),
      );
      expect(response.status).toBe(200);
      const summary = await published;

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
    } finally {
      subscription.unsubscribe();
      await composition.close();
      await diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
