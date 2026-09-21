import {
  normalizeContext,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

import { parseAnthropicTextInvocation } from "../../src/protocols/anthropic/request.js";
import { prepareAnthropicReasoning } from "../../src/protocols/anthropic/semantic/reasoning/request.js";
import { captureFinalPiPayload } from "./pi-final-payload.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Certify opaque continuity through the real Pi 0.86.1 Provider boundary.
 * `onPayload` is test-only observation: it captures and never repairs the
 * payload constructed by the selected Pi adapter.
 */
export async function captureAnthropicContinuityReplay(input: {
  readonly model: Model<string>;
  readonly clientContent: readonly Record<string, unknown>[];
  readonly start: (
    context: TranscriptContext,
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
      .filter(
        (name): name is string =>
          typeof name === "string" && name.length > 0,
      ),
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
    throw new Error(
      "Anthropic continuity fixture did not produce assistant history",
    );
  }
  if (!assistant.content.every(isRecord)) {
    throw new Error("Anthropic continuity fixture produced invalid Pi content");
  }
  input.verifyPreparedContext?.(prepared.invocation.pi.context);

  const transcript = normalizeContext(prepared.invocation.pi.context);
  return captureFinalPiPayload((capture) =>
    input.start(transcript, {
      ...prepared.invocation.pi.options,
      onPayload: capture,
    }),
  );
}
