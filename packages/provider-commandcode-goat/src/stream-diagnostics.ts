import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  createUpstreamFailureDiagnostic,
  createUpstreamFailureFact,
  findUpstreamFailureFact,
} from "@luckytoken/provider-contract/diagnostics";

function safeFailureMessage(value: string | undefined): string {
  const message = value
    ?.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .trim();
  return message === undefined || message.length === 0
    ? "CommandCode Goat stream failed"
    : message;
}

function withUpstreamFailure(message: AssistantMessage): AssistantMessage {
  if (findUpstreamFailureFact(message.diagnostics) !== undefined) return message;
  const failure = createUpstreamFailureFact({
    kind: "upstream_stream",
    message: safeFailureMessage(message.errorMessage),
  });
  return {
    ...message,
    diagnostics: [
      ...(message.diagnostics ?? []),
      createUpstreamFailureDiagnostic(failure, message.timestamp),
    ],
  };
}

function unexpectedStreamFailure(
  model: Model<string>,
  error: unknown,
): AssistantMessage {
  const message = safeFailureMessage(
    error instanceof Error ? error.message : String(error),
  );
  const timestamp = Date.now();
  const failure = createUpstreamFailureFact({
    kind: "transport",
    phase: "stream",
    message,
    retryable: true,
  });
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp,
    diagnostics: [createUpstreamFailureDiagnostic(failure, timestamp)],
  };
}

function annotateFailureStream(
  model: Model<string>,
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "error" && event.reason === "error") {
          output.push({
            ...event,
            error: withUpstreamFailure(event.error),
          });
        } else {
          output.push(event);
        }
      }
    } catch (error) {
      output.push({
        type: "error",
        reason: "error",
        error: unexpectedStreamFailure(model, error),
      });
    } finally {
      output.end();
    }
  })();
  return output;
}

/**
 * Goat-owned response boundary. Pi remains responsible for OpenAI-compatible
 * request construction and SSE decoding; this boundary preserves its exact
 * adapter error as LuckyToken's protocol-neutral upstream failure fact.
 */
export function bindUpstreamFailureDiagnostics(
  streams: ProviderStreams,
): ProviderStreams {
  const stream: ProviderStreams["stream"] = (model, context, options) =>
    annotateFailureStream(model, streams.stream(model, context, options));
  const streamSimple: ProviderStreams["streamSimple"] = (
    model,
    context,
    options,
  ) =>
    annotateFailureStream(
      model,
      streams.streamSimple(model, context, options),
    );
  return Object.freeze({ stream, streamSimple });
}
