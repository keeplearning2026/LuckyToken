function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectsForcedToolChoiceOmission(
  provider: string,
  model: string,
): boolean {
  return (
    provider === "commandcode-goat" &&
    model === "deepseek/deepseek-v4-flash"
  );
}

export interface OnlineProviderMessage extends Readonly<Record<string, unknown>> {
  readonly role: string;
}

export function readOnlineProviderMessages(
  api: string,
  body: unknown,
): readonly OnlineProviderMessage[] {
  if (!isRecord(body)) {
    throw new Error(`online_${api}_payload_shape`);
  }
  let messages: unknown;
  if (api === "commandcode-private") {
    const params = body.params;
    if (!isRecord(params)) {
      throw new Error(`online_${api}_payload_shape`);
    }
    messages = params.messages;
  } else if (api === "openai-completions") {
    messages = body.messages;
  } else {
    throw new Error(`online_${api}_payload_shape`);
  }
  if (!Array.isArray(messages)) {
    throw new Error(`online_${api}_payload_shape`);
  }
  if (
    !messages.every(
      (message) => isRecord(message) && typeof message.role === "string",
    )
  ) {
    throw new Error(`online_${api}_message_shape`);
  }
  return messages as readonly OnlineProviderMessage[];
}

export function requireOnlineReasoningReplay(
  api: string,
  messages: readonly OnlineProviderMessage[],
  expectedSummary: string,
  reasoningFieldSelector?: string,
): void {
  let replayed = false;
  if (api === "openai-completions") {
    if (
      reasoningFieldSelector !== "reasoning_content" &&
      reasoningFieldSelector !== "reasoning" &&
      reasoningFieldSelector !== "reasoning_text"
    ) {
      throw new Error("online_reasoning_selector_missing");
    }
    replayed = messages.some(
      (message) =>
        message.role === "assistant" &&
        message[reasoningFieldSelector] === expectedSummary,
    );
  } else if (api === "commandcode-private") {
    replayed = messages.some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            isRecord(block) &&
            block.type === "reasoning" &&
            block.text === expectedSummary,
        ),
    );
  } else {
    throw new Error(`online_${api}_payload_shape`);
  }
  if (!replayed) {
    throw new Error("online_full_history_reasoning_replay_missing");
  }
}

export function requireOnlineOpenAICompletionsProjection(
  body: unknown,
  expected: {
    readonly toolName?: string;
    readonly omitToolChoice?: boolean;
    readonly schemaName?: string;
    readonly parallelToolCalls?: boolean;
    readonly maxOutputTokens: number;
  },
): void {
  if (!isRecord(body)) throw new Error("online_openai_projection_payload_shape");
  const choice = body.tool_choice;
  const format = body.response_format;
  const tokenLimit = body.max_completion_tokens ?? body.max_tokens;
  const toolMatches =
    expected.omitToolChoice === true
      ? choice === undefined
      : expected.toolName === undefined ||
        (isRecord(choice) &&
          choice.type === "function" &&
          isRecord(choice.function) &&
          choice.function.name === expected.toolName);
  const formatMatches =
    expected.schemaName === undefined ||
    (isRecord(format) &&
      format.type === "json_schema" &&
      isRecord(format.json_schema) &&
      format.json_schema.name === expected.schemaName);
  const parallelMatches =
    expected.parallelToolCalls === undefined ||
    body.parallel_tool_calls === expected.parallelToolCalls;
  if (
    !toolMatches ||
    !formatMatches ||
    !parallelMatches ||
    typeof tokenLimit !== "number" ||
    !Number.isSafeInteger(tokenLimit) ||
    tokenLimit <= 0 ||
    tokenLimit > expected.maxOutputTokens
  ) {
    throw new Error("online_openai_projection_wire_mismatch");
  }
}
