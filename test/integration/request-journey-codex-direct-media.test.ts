import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CodexDirectModelSource } from "../../src/codex-direct-seam.js";
import {
  createDiagnosticsAuthority,
  parseDiagnosticsConfiguration,
  type RequestJourneySummary,
} from "../../src/diagnostics/index.js";
import { createOpenAIResponsesServingTestComposition } from "../support/openai-responses-serving.js";

const noDirectModels: CodexDirectModelSource = Object.freeze({
  has: () => false,
});

describe("Request Journey Codex Direct Mode media", () => {
  it("publishes Images and Realtime HTTP through their Direct Mode contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-native-media-journey-"));
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
      codexDirectModels: noDirectModels,
      diagnostics,
    });
    const records: RequestJourneySummary[] = [];
    let publishAll!: () => void;
    const published = new Promise<void>((resolve) => {
      publishAll = resolve;
    });
    const subscription = diagnostics.subscribeRequestJourneys((record) => {
      records.push(record);
      if (records.length === 2) publishAll();
    });

    try {
      const images = await composition.runtime.handle(
        new Request("http://Token.test/v1/images/generations", {
          method: "POST",
          headers: { authorization: "Bearer codex-token" },
          body: Uint8Array.from([0x00, 0xff]),
        }),
      );
      const realtime = await composition.runtime.handle(
        new Request("http://Token.test/v1/live", {
          method: "POST",
          headers: {
            authorization: "Bearer codex-token",
            "content-type": "application/json",
          },
          body: '{"sdp":"v=0"}',
        }),
      );
      expect([images.status, realtime.status]).toEqual([200, 200]);
      expect(images.headers.has("x-token-request-id")).toBe(false);
      expect(realtime.headers.has("x-token-request-id")).toBe(false);
      await published;

      const details = await Promise.all(
        records.map((record) =>
          diagnostics.getRequestJourney({ requestId: record.requestId }),
        ),
      );
      expect(
        details.map((detail) => ({
          operation: detail.operation,
          protocol: detail.protocol,
          lane: detail.lane,
          outcome: detail.outcome,
          terminalAuthority: detail.workOutcome?.terminalAuthority,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            operation: "image_generation",
            protocol: "codex-images",
            lane: "direct",
            outcome: "success",
            terminalAuthority: "codex_direct_images_handler",
          },
          {
            operation: "realtime_session",
            protocol: "codex-realtime",
            lane: "direct",
            outcome: "success",
            terminalAuthority: "codex_direct_realtime_handler",
          },
        ]),
      );
    } finally {
      subscription.unsubscribe();
      await composition.close();
      await diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
