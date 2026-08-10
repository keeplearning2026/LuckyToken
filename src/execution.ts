import type {
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

export async function execute(
  models: Models,
  model: Model<string>,
  context: Context,
  options: ModelsSimpleStreamOptions,
): Promise<AssistantMessage> {
  const stream = models.streamSimple(model, context, options);

  for await (const event of stream) {
    if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "Pi execution failed");
    }
    if (event.type === "done") {
      if (event.reason === "deferred" || event.message.stopReason !== event.reason) {
        throw new Error("Pi terminal did not contain a supported consistent message");
      }
      return event.message;
    }
  }

  throw new Error("Pi execution ended without a terminal event");
}
