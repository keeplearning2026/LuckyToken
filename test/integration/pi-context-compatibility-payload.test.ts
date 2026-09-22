import {
  normalizeContext,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { describe, expect, it } from "vitest";

import { preparePiContextForModel } from "../../src/pi-context-compatibility.js";
import { captureFinalPiPayload } from "../support/pi-final-payload.js";

function model(supportsMidConvoSystemMessages: boolean): Model<"openai-responses"> {
  return {
    id: "model-test",
    name: "model-test",
    api: "openai-responses",
    provider: "provider-test",
    baseUrl: "https://provider.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
    compat: { supportsMidConvoSystemMessages },
  };
}

function context(): Context {
  return {
    systemPrompt: "root",
    messages: [
      { role: "user", content: "before", timestamp: 1 },
      { role: "system", content: "later rule", timestamp: 2 },
      { role: "user", content: "after", timestamp: 3 },
    ],
  };
}

function roles(payload: unknown): string[] {
  const input = (payload as { input?: Array<{ role?: string }> }).input;
  return (input ?? []).map((item) => item.role ?? "");
}

describe("Pi Context compatibility final payload", () => {
  it("keeps a supported mid-system at its original OpenAI Responses input position", async () => {
    const target = model(true);
    const prepared = preparePiContextForModel(target, context());
    const transcript = normalizeContext(prepared.context);

    const payload = await captureFinalPiPayload((onPayload) =>
      streamOpenAIResponses(target, transcript, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    );

    expect(roles(payload)).toEqual(["system", "user", "system", "user"]);
    expect((payload as { input: Array<{ content?: unknown }> }).input[2]).toMatchObject({
      role: "system",
      content: "later rule",
    });
  });

  it("prevents Pi collapse for an unsupported mid-system by degrading it in place first", async () => {
    const target = model(false);
    const prepared = preparePiContextForModel(target, context());
    expect(prepared.context.systemPrompt).toBe("root");
    expect(prepared.context.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
    ]);
    const transcript = normalizeContext(prepared.context);

    const payload = await captureFinalPiPayload((onPayload) =>
      streamOpenAIResponses(target, transcript, {
        apiKey: "test-only-key",
        maxTokens: 64,
        onPayload,
      }),
    );

    expect(roles(payload)).toEqual(["system", "user", "user", "user"]);
    expect((payload as { input: Array<{ content?: unknown }> }).input[0]).toMatchObject({
      role: "system",
      content: "root",
    });
    expect(JSON.stringify(payload)).not.toContain("root\\n\\nlater rule");
  });
});
