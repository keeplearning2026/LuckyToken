import type {
  ResponsesReasoningAdapter,
  ResponsesReasoningHistoryPreparationInput,
} from "./contract.js";
import {
  InvalidResponsesReasoningProjection,
} from "./payload.js";
import { fallback, native } from "./continuity-decisions.js";

export const responsesToCommandCodePrivateReasoningAdapter: ResponsesReasoningAdapter =
  Object.freeze({
    id: "commandcode-private",
    api: "commandcode-private",
    prepareHistory(input: ResponsesReasoningHistoryPreparationInput) {
      return input.model.reasoning
        ? native()
        : fallback("target does not support reasoning");
    },
    projectPayload(
      input: Parameters<ResponsesReasoningAdapter["projectPayload"]>[0],
    ) {
      if (
        typeof input.payload !== "object" ||
        input.payload === null ||
        Array.isArray(input.payload)
      ) {
        throw new InvalidResponsesReasoningProjection(
          "commandcode-private payload must be an object",
        );
      }
      const payload = structuredClone(input.payload) as Record<string, unknown>;
      if (
        typeof payload.params !== "object" ||
        payload.params === null ||
        Array.isArray(payload.params)
      ) {
        throw new InvalidResponsesReasoningProjection(
          "commandcode-private payload shape mismatch at params",
        );
      }
      const params = { ...(payload.params as Record<string, unknown>) };
      const outcomes = [...input.prepared.outcomes];
      const effort = input.prepared.request.effort;
      if (effort.kind === "provider-default") {
        const repaired = params.reasoning_effort !== undefined;
        delete params.reasoning_effort;
        outcomes.push({
          subject: "effort",
          outcome: repaired
            ? {
                kind: "payload-projected",
                projector: "commandcode-private",
                warning: "pi-native-mapping-repaired",
              }
            : { kind: "pi-native" },
        });
      } else if (effort.kind === "disabled") {
        delete params.reasoning_effort;
        outcomes.push({
          subject: "effort",
          outcome: {
            kind: "degraded",
            projector: "commandcode-private",
            fallback: "reasoning-disable-to-provider-default",
            warning:
              "target cannot express explicit reasoning disable; provider default retained",
          },
        });
      } else {
        const plan = input.prepared.effortPlan;
        if (plan.kind !== "enabled" || plan.selection.kind !== "selected") {
          delete params.reasoning_effort;
          const nonReasoning =
            plan.kind === "enabled" &&
            plan.selection.kind === "non-reasoning";
          outcomes.push({
            subject: "effort",
            outcome: {
              kind: "degraded",
              projector: "commandcode-private",
              fallback: nonReasoning
                ? "reasoning-to-ordinary-generation"
                : "reasoning-to-provider-default",
              warning: nonReasoning
                ? "target model does not support reasoning; ordinary generation retained"
                : "target model exposes no selectable reasoning level; provider default retained",
            },
          });
        } else {
          const expected = input.model.thinkingLevelMap?.[plan.selection.level];
          if (typeof expected !== "string") {
            delete params.reasoning_effort;
            outcomes.push({
              subject: "effort",
              outcome: {
                kind: "degraded",
                projector: "commandcode-private",
                fallback: "reasoning-to-provider-default",
                warning: `CommandCode Private has no certified ${plan.selection.level} effort mapping; provider default retained`,
              },
            });
          } else {
            const repaired = params.reasoning_effort !== expected;
            if (repaired) params.reasoning_effort = expected;
            outcomes.push({
              subject: "effort",
              outcome:
                plan.requested !== plan.selection.level
                  ? {
                      kind: "degraded",
                      projector: "commandcode-private",
                      fallback: "reasoning-effort-nearest-level",
                      warning: `requested reasoning level ${plan.requested} mapped to supported level ${plan.selection.level}`,
                    }
                  : repaired
                    ? {
                        kind: "payload-projected",
                        projector: "commandcode-private",
                        warning: "pi-native-mapping-repaired",
                      }
                    : { kind: "pi-native" },
            });
          }
        }
      }
      if (input.prepared.request.summary.kind === "requested") {
        outcomes.push({
          subject: "summary",
          outcome: {
            kind: "omitted",
            warning:
              "CommandCode Private has no reasoning summary preference field",
          },
        });
      }
      payload.params = params;
      return Object.freeze({
        payload: Object.freeze(payload),
        outcomes: Object.freeze(outcomes),
      });
    },
  });
