import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  CodexLocalCredentialAuthority,
  CodexNativeModelSource,
} from "../../src/codex-native-seam.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import {
  createOpenAIResponsesServingTestComposition,
} from "../support/openai-responses-serving.js";

const credentials: CodexLocalCredentialAuthority = Object.freeze({
  resolveForwardAuth: async (headers: Headers) =>
    headers.get("authorization") === "Bearer codex-token"
      ? Object.freeze({
          authorization: "Bearer codex-token",
          accountId: "acct-local",
        })
      : undefined,
  scrub: (value: string) => value.replaceAll("codex-token", "[REDACTED]"),
});

const nativeModels: CodexNativeModelSource = Object.freeze({
  has: () => false,
});

describe("Request Journey Codex Local Native web search", () => {
  it("publishes web_search as a successful Local Native journey", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-search-journey-"));
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
      codexLocalAuth: credentials,
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
        new Request("http://luckytoken.test/v1/alpha/search", {
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
        lane: "local_native",
        outcome: "success",
        workOutcome: {
          outcome: "success",
          terminalAuthority: "codex_local_search_handler",
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
