import type { Context, Model, SystemMessage } from "@earendil-works/pi-ai";

import { PiContextCompatibilityError } from "./pi-context-compatibility-error.js";

export { PiContextCompatibilityError } from "./pi-context-compatibility-error.js";

export interface PiContextCompatibilityOutcome {
  readonly code: "pi_mid_system_degraded_to_user";
  readonly messageIndex: number;
}

const EMPTY_OUTCOMES = Object.freeze([]) as readonly PiContextCompatibilityOutcome[];

function supportsMidConvoSystemMessages(model: Model<string>): boolean {
  const compat = (model as unknown as {
    readonly compat?: { readonly supportsMidConvoSystemMessages?: boolean };
  }).compat;
  return compat?.supportsMidConvoSystemMessages === true;
}

function isComplexSystemMessage(message: SystemMessage): boolean {
  return (
    message.sections !== undefined ||
    message.toolsAdded !== undefined ||
    message.toolsRemoved !== undefined
  );
}

function toDegradedUser(message: SystemMessage) {
  return {
    role: "user" as const,
    content: message.content,
    timestamp: message.timestamp,
  };
}

export function preparePiContextForModel(
  model: Model<string>,
  context: Context,
): {
  readonly context: Context;
  readonly outcomes: readonly PiContextCompatibilityOutcome[];
} {
  if (supportsMidConvoSystemMessages(model)) {
    return { context, outcomes: EMPTY_OUTCOMES };
  }

  let seenNonSystem = false;
  let repaired = false;
  const repairedMessages: Context["messages"] = [];
  const outcomes: PiContextCompatibilityOutcome[] = [];
  const pendingToolCallIds = new Set<string>();
  const deferredSystems: Array<{
    readonly message: SystemMessage;
    readonly messageIndex: number;
  }> = [];

  const failRelocationBoundary = (messageIndex: number, role: string): never => {
    throw new PiContextCompatibilityError(
      `mid-conversation system relocation cannot cross ${role} boundary at index ${messageIndex} before the required tool exchange is complete`,
    );
  };

  const flushDeferredSystems = (): void => {
    for (const deferred of deferredSystems) {
      repairedMessages.push(toDegradedUser(deferred.message));
      outcomes.push(
        Object.freeze({
          code: "pi_mid_system_degraded_to_user",
          messageIndex: deferred.messageIndex,
        }),
      );
    }
    deferredSystems.length = 0;
  };

  for (const [messageIndex, message] of context.messages.entries()) {
    if (message.role === "system") {
      if (!seenNonSystem) {
        repairedMessages.push(message);
        continue;
      }
      if (isComplexSystemMessage(message)) {
        throw new PiContextCompatibilityError(
          `mid-conversation system message at index ${messageIndex} carries prompt or tool-state changes that cannot be safely degraded`,
        );
      }
      repaired = true;
      if (pendingToolCallIds.size > 0) {
        deferredSystems.push({ message, messageIndex });
        continue;
      }
      repairedMessages.push(toDegradedUser(message));
      outcomes.push(
        Object.freeze({
          code: "pi_mid_system_degraded_to_user",
          messageIndex,
        }),
      );
      continue;
    }

    seenNonSystem = true;

    if (message.role === "toolResult") {
      repairedMessages.push(message);
      pendingToolCallIds.delete(message.toolCallId);
      if (pendingToolCallIds.size === 0 && deferredSystems.length > 0) {
        flushDeferredSystems();
      }
      continue;
    }

    if (message.role === "user") {
      if (deferredSystems.length > 0 && pendingToolCallIds.size > 0) {
        failRelocationBoundary(messageIndex, "user");
      }
      pendingToolCallIds.clear();
      repairedMessages.push(message);
      continue;
    }

    if (message.role === "assistant") {
      if (deferredSystems.length > 0 && pendingToolCallIds.size > 0) {
        failRelocationBoundary(messageIndex, "assistant");
      }
      pendingToolCallIds.clear();
      for (const block of message.content) {
        if (block.type === "toolCall") pendingToolCallIds.add(block.id);
      }
      repairedMessages.push(message);
      continue;
    }

    repairedMessages.push(message);
  }

  if (deferredSystems.length > 0) {
    throw new PiContextCompatibilityError(
      "mid-conversation system relocation cannot complete because the required tool exchange is not complete before end of input",
    );
  }

  if (!repaired) {
    return { context, outcomes: EMPTY_OUTCOMES };
  }
  return {
    context: { ...context, messages: repairedMessages },
    outcomes: Object.freeze(outcomes),
  };
}
