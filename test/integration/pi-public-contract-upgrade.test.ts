import { createModels, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createRequestCompositionModels } from "../../src/providers/request-composition.js";
import { createConfigValueResolver } from "../../src/providers/config-value.js";
import { execute } from "../../src/execution.js";
import { captureFinalPiPayload } from "../support/pi-final-payload.js";

function fixture() {
  const provider = openaiProvider();
  const underlying = createModels();
  underlying.setProvider(provider);
  const model = { ...provider.getModels()[0]!, compat: { supportsOpenAIGrammarTools: true } };
  const models = createRequestCompositionModels(underlying, undefined, { configValues: createConfigValueResolver() });
  return { models, model };
}

describe("installed Pi public execution contract", () => {
  it.each([
    { custom: true, oldId: "fc_old", finalType: "custom_tool_call" },
    { custom: false, oldId: "ctc_old", finalType: "function_call" },
  ])("lets Pi discard an incompatible history item id for $finalType", async ({ custom, oldId, finalType }) => {
    const { models, model } = fixture();
    const previous: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "toolCall", id: `call_1|${oldId}`, name: "patch", arguments: { input: "patch text" } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 1,
    };
    const context: Context = {
      tools: [{ name: "patch", description: "patch", parameters: Type.Object({ input: Type.String() }),
        ...(custom ? { constrainedSampling: { type: "grammar" as const, variants: { openai_lark: "start: /.+/" } } } : {}),
      }],
      messages: [previous, { role: "toolResult", toolCallId: `call_1|${oldId}`, toolName: "patch", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 }],
    };
    const payload = await captureFinalPiPayload((onPayload) => models.streamSimple(model, context, { apiKey: "test", onPayload })) as { input: Array<Record<string, unknown>> };
    const call = payload.input.find((item) => item.type === finalType)!;
    expect(call).toBeDefined();
    expect(call.id).toBeUndefined();
    expect(call.call_id).toBe("call_1");
    expect(payload.input.find((item) => item.type === `${finalType}_output`)?.call_id).toBe("call_1");
  });

  it("refuses an unfinished streamed tool call before Token can return a successful terminal", async () => {
    const { models, model } = fixture();
    const events = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "patch", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"input":' },
      { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const fetch = async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    await expect(execute(models, model, { messages: [{ role: "user", content: "patch", timestamp: 1 }] }, { apiKey: "test", fetch }))
      .rejects.toMatchObject({ name: "ExecutionFailure", diagnostic: expect.stringContaining("unfinished tool call") });
  });
});
