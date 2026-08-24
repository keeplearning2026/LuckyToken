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
      } else if (!input.model.reasoning) {
        outcomes.push({
          subject: "effort",
          outcome:
            effort.kind === "disabled"
              ? { kind: "pi-native" }
              : {
                  kind: "omitted",
                  warning: "target model does not support reasoning generation",
                },
        });
      } else if (effort.kind === "disabled") {
        throw new InvalidResponsesReasoningProjection(
          "CommandCode Private has no explicit reasoning-disable wire value",
        );
      } else {
        const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
        const available = levels.filter((level) => {
          const mapped = input.model.thinkingLevelMap?.[level];
          if (mapped === null) return false;
          if (level === "xhigh" || level === "max") return mapped !== undefined;
          return true;
        });
        const requestedIndex = levels.indexOf(effort.level);
        const effective =
          levels
            .slice(requestedIndex)
            .find((level) => available.includes(level)) ??
          levels
            .slice(0, requestedIndex)
            .reverse()
            .find((level) => available.includes(level));
        if (effective === undefined) {
          throw new InvalidResponsesReasoningProjection(
            "CommandCode Private model has no supported reasoning effort",
          );
        }
        const explicit = input.model.thinkingLevelMap?.[effective];
        const expected =
          typeof explicit === "string"
            ? explicit
            : effective === "minimal" || effective === "low"
              ? "low"
              : effective === "medium" || effective === "high"
                ? effective
                : undefined;
        if (expected === undefined) {
          throw new InvalidResponsesReasoningProjection(
            `CommandCode Private has no certified ${effective} effort mapping`,
          );
        }
        const repaired = params.reasoning_effort !== expected;
        if (repaired) params.reasoning_effort = expected;
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
