import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseFailureLoggingConfiguration } from "../../src/invocation-diagnostics/configuration.js";
import { createInvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";
import { parseCommandCodeConfiguration } from "../../src/providers/commandcode-private/configuration.js";
import { createCommandCodeServingTestComposition } from "../support/commandcode-serving.js";

describe("CommandCode route failure journal", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("writes exactly one final journal with every physical attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-commandcode-journal-"));
    roots.push(root);
    const configuration = parseFailureLoggingConfiguration(
      {
        directory: root,
        detail: "safe",
        logCancellation: true,
        maxFiles: 10,
        maxFileBytes: 65_536,
        retentionDays: 1,
      },
      root,
    );
    const requestId = "33333333-3333-4333-8333-333333333333";
    const invocationDiagnostics = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => requestId,
      now: () => Date.UTC(2026, 7, 14),
    });
    let attempt = 0;
    const { runtime } = createCommandCodeServingTestComposition({
      clientApiKey: "client-key",
      commandCodeApiKey: "provider-key",
      commandCodeBaseUrl: "https://commandcode.test",
      modelId: "model",
      fetch: async () => {
        attempt += 1;
        return new Response(
          JSON.stringify({ error: { message: `failure-${attempt}` } }),
          {
            status: 503,
            headers: {
              "retry-after-ms": "0",
              "x-request-id": `upstream-${attempt}`,
            },
          },
        );
      },
      commandCodeConfiguration: parseCommandCodeConfiguration({
        request: { transport: { maxRetries: 1, maxRetryDelayMs: 0 } },
      }),
      invocationDiagnostics,
    });

    const response = await runtime.handle(
      new Request("http://luckytoken.test/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "model",
          max_tokens: 20,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect(attempt).toBe(2);
    const dayDirectories = await readdir(root);
    expect(dayDirectories).toHaveLength(1);
    const dayDirectory = join(root, dayDirectories[0]!);
    const files = await readdir(dayDirectory);
    expect(files).toEqual([`${requestId}.json`]);
    const journal = JSON.parse(
      await readFile(join(dayDirectory, files[0]!), "utf8"),
    ) as {
      classification: string;
      clientStatus: number;
      attempts: Array<Record<string, unknown>>;
    };
    expect(journal.classification).toBe("runtime-failure");
    expect(journal.clientStatus).toBe(503);
    expect(journal.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        classification: "http",
        status: 503,
        safeIds: { "x-request-id": "upstream-1" },
      }),
      expect.objectContaining({
        attempt: 2,
        classification: "http",
        status: 503,
        safeIds: { "x-request-id": "upstream-2" },
      }),
    ]);
  });
});
