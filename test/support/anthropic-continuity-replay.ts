import type {
  AssistantMessageEventStream,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { prepareAnthropicPayloadProjection } from "../../src/protocols/anthropic/semantic/projection/request.js";
import { prepareAnthropicReasoning } from "../../src/protocols/anthropic/semantic/reasoning/request.js";
import { captureFinalPiPayload } from "./pi-final-payload.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function captureAnthropicContinuityReplay(input: {
  readonly model: Model<string>;
  readonly clientContent: readonly Record<string, unknown>[];
  readonly start: (
    context: Context,
    options: ModelsSimpleStreamOptions,
  ) => AssistantMessageEventStream;
  readonly verifyPreparedContext?: (context: Context) => void;
}): Promise<unknown> {
  const toolUses = input.clientContent.filter(
    (block) => block.type === "tool_use" && typeof block.id === "string",
  );
  const userContent: Record<string, unknown>[] = toolUses.map((block) => ({
    type: "tool_result",
    tool_use_id: block.id,
    content: "fixture result",
  }));
  userContent.push({ type: "text", text: "continue" });

  const toolNames = new Set(
    toolUses
      .map((block) => block.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
  const converted = parseAnthropicTextInvocation(
    {
      model: "client-model",
      max_tokens: 2_048,
      ...(toolNames.size === 0
        ? {}
        : {
            tools: [...toolNames].map((name) => ({
              name,
              description: "continuity fixture",
              input_schema: { type: "object" },
            })),
          }),
      messages: [
        { role: "assistant", content: input.clientContent },
        { role: "user", content: userContent },
      ],
    },
    2,
  );
  const prepared = prepareAnthropicReasoning({
    model: input.model,
    invocation: converted.invocation,
  });
  const assistant = prepared.invocation.pi.context.messages[0];
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
    throw new Error("Anthropic continuity fixture did not produce assistant history");
  }
  if (!assistant.content.every(isRecord)) {
    throw new Error("Anthropic continuity fixture produced invalid Pi content");
  }
  input.verifyPreparedContext?.(prepared.invocation.pi.context);

  const projection = prepareAnthropicPayloadProjection({
    model: input.model,
    invocation: prepared.invocation,
  });
  if (projection.initialFailure !== undefined) {
    throw new Error(projection.initialFailure);
  }
  return captureFinalPiPayload((capture) =>
    input.start(prepared.invocation.pi.context, {
      ...prepared.invocation.pi.options,
      async onPayload(basePayload) {
        const projected = await projection.project(basePayload, input.model);
        if (projected.failure !== undefined) throw new Error(projected.failure);
        return capture(projected.payload);
      },
    }),
  );
}
