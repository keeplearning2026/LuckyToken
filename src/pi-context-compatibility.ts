import type { Context, Model } from "@earendil-works/pi-ai";

export interface PiContextCompatibilityOutcome {
  readonly code: "pi_mid_system_degraded_to_user";
  readonly messageIndex: number;
}

export class PiContextCompatibilityError extends Error {
  readonly kind = "PiContextCompatibilityError";

  constructor(message: string) {
    super(message);
    this.name = "PiContextCompatibilityError";
  }
}

function supportsMidConvoSystemMessages(model: Model<string>): boolean {
  const compat = (model as unknown as {
    readonly compat?: { readonly supportsMidConvoSystemMessages?: boolean };
  }).compat;
  return compat?.supportsMidConvoSystemMessages === true;
}

export function preparePiContextForModel(
  model: Model<string>,
  context: Context,
): {
  readonly context: Context;
  readonly outcomes: readonly PiContextCompatibilityOutcome[];
} {
  let seenNonSystem = false;
  for (const [messageIndex, message] of context.messages.entries()) {
    if (message.role !== "system") {
      seenNonSystem = true;
      continue;
    }
    if (!seenNonSystem) continue;
    if (
      message.sections !== undefined ||
      message.toolsAdded !== undefined ||
      message.toolsRemoved !== undefined
    ) {
      throw new PiContextCompatibilityError(
        `mid-conversation system message at index ${messageIndex} carries prompt or tool-state changes that cannot be safely degraded`,
      );
    }
  }

  if (supportsMidConvoSystemMessages(model)) {
    return { context, outcomes: Object.freeze([]) };
  }

  seenNonSystem = false;
  let repairedMessages: Context["messages"] | undefined;
  const outcomes: PiContextCompatibilityOutcome[] = [];

  for (const [messageIndex, message] of context.messages.entries()) {
    if (message.role !== "system") {
      seenNonSystem = true;
      continue;
    }
    if (!seenNonSystem) continue;

    repairedMessages ??= [...context.messages];
    repairedMessages[messageIndex] = {
      role: "user",
      content: message.content,
      timestamp: message.timestamp,
    };
    outcomes.push(
      Object.freeze({
        code: "pi_mid_system_degraded_to_user",
        messageIndex,
      }),
    );
  }

  if (repairedMessages === undefined) {
    return { context, outcomes: Object.freeze([]) };
  }
  return {
    context: { ...context, messages: repairedMessages },
    outcomes: Object.freeze(outcomes),
  };
}
