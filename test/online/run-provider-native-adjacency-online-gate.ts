import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createResponsesSmokeHarness } from "./responses-smoke-harness.js";

const PROVIDER_URL = "https://api.commandcode.ai/provider/v1/responses";
const MODEL = "commandcode-goat/deepseek/deepseek-v4.1-flash";
const API_KEY_FILE = "CommandcodeAPIKey.txt";
const FIRST_CALL_ID = "call_synthetic_view_image";
const SECOND_CALL_ID = "call_synthetic_exec_command";

const firstCall = {
  type: "function_call",
  id: "fc_synthetic_image",
  call_id: FIRST_CALL_ID,
  name: "view_image",
  arguments: JSON.stringify({ path: "synthetic-image.png" }),
  status: "completed",
};
const secondCall = {
  type: "function_call",
  id: "fc_synthetic_command",
  call_id: SECOND_CALL_ID,
  name: "exec_command",
  arguments: JSON.stringify({
    cmd: "Start-Sleep -Milliseconds 1500; Write-Output SYNTHETIC_TOOL_B",
  }),
  status: "completed",
};
const firstOutput = {
  type: "function_call_output",
  call_id: FIRST_CALL_ID,
  output: "Synthetic image inspected.",
};
const secondOutput = {
  type: "function_call_output",
  call_id: SECOND_CALL_ID,
  output: "SYNTHETIC_TOOL_B",
};
const developerMessage = {
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "Synthetic image resize notice." }],
};
const input = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Reply with SYNTHETIC_DONE." }],
  },
  firstCall,
  secondCall,
  firstOutput,
  developerMessage,
  secondOutput,
];
const expectedInput = [
  input[0],
  firstCall,
  secondCall,
  firstOutput,
  secondOutput,
  developerMessage,
];

async function run(): Promise<void> {
  const harness = await createResponsesSmokeHarness({
    providerId: "commandcode-goat",
    model: MODEL,
    apiKeyFile: API_KEY_FILE,
  });
  try {
    assert.equal(harness.providerApi, "openai-responses");
    const apiKey = (await readFile(API_KEY_FILE, "utf8")).trim();
    const directBody = {
      model: harness.upstreamModelId,
      input,
      max_output_tokens: 128,
    };
    const clientBody = { ...directBody, model: harness.selector };
    assert.deepEqual(clientBody.input, directBody.input);

    const sessionId = randomUUID();
    const direct = await fetch(PROVIDER_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        session_id: sessionId,
        "x-client-request-id": sessionId,
      },
      body: JSON.stringify(directBody),
      signal: AbortSignal.timeout(90_000),
    });
    const directText = await direct.text();
    const adjacencyRejected =
      /insufficient tool messages following tool_calls message/iu.test(directText);
    assert.equal(direct.status, 400, `direct upstream status ${direct.status}`);
    assert.equal(adjacencyRejected, true, "direct 400 must name tool-call adjacency");

    const token = await harness.post(clientBody);
    assert.equal(token.status, 200, `Token status ${token.status}`);
    const exchange = harness.exchanges.findLast(
      (entry) =>
        new URL(entry.url).pathname === "/provider/v1/responses" &&
        entry.body.includes(FIRST_CALL_ID),
    );
    assert.ok(exchange, "Token Provider Native outbound request missing");
    const outbound = JSON.parse(exchange.body) as Record<string, unknown>;
    assert.equal(outbound.model, harness.upstreamModelId);
    assert.deepEqual(outbound.input, expectedInput);

    process.stdout.write(
      `${JSON.stringify({
        result: "pass",
        directStatus: direct.status,
        directAdjacencyRejected: adjacencyRejected,
        tokenStatus: token.status,
        outboundPath: new URL(exchange.url).pathname,
        outboundOrder: [
          "view_image",
          "exec_command",
          "view_image_output",
          "exec_command_output",
          "developer",
        ],
        syntheticOnly: true,
      })}\n`,
    );
  } finally {
    await harness.close();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `Provider Native adjacency online gate failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
