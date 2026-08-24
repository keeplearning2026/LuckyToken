import { ExecutionFailure, type ExecutionOperation } from "../execution.js";
import {
  isManagedProviderAuthBindingCapture,
  MAX_PROFILE_ATTEMPTS_PER_REQUEST,
  type ProviderAuthBindingAuthority,
} from "./profile-contract.js";
import type { CredentialActivitySink } from "./activity.js";

function retryAfterMs(
  headers: Readonly<Record<string, string>>,
  now: () => number,
): number | undefined {
  const value = headers["retry-after"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - now());
}

/**
 * Composition owns this Profile-binding Adapter for Pi execution. It keeps the exact
 * Provider Profile scope alive through lazy Pi stream consumption and does
 * not expose credentials or binding machinery to Client Protocol handlers.
 */
export function createProfileBoundPiExecution(options: {
  readonly bindings: Pick<
    ProviderAuthBindingAuthority,
    "capture" | "runBound" | "advanceAfterFinal429"
  >;
  readonly execute: ExecutionOperation;
  readonly resolveCredentialActivity: (
    facts: Parameters<ExecutionOperation>[4],
  ) => CredentialActivitySink | undefined;
  readonly now?: () => number;
}): ExecutionOperation {
  const now = options.now ?? Date.now;
  return async (
    models,
    model,
    context,
    streamOptions,
    factsSink,
  ) => {
    const credentialActivity = options.resolveCredentialActivity(factsSink);
    let capture = await options.bindings.capture(model.provider);
    const attemptedCredentialIds: string[] = [];
    let profileAttempt = 1;
    let selectionReason: "active" | "http_429_switch" = "active";
    if (capture.facts.kind === "managed") {
      credentialActivity?.credentialCaptured?.({
        ...capture.facts,
        lane: "semantic_conversion",
        selectionReason,
      });
    }
    for (;;) {
      try {
        const result = await options.bindings.runBound(capture, () =>
          options.execute(
            models,
            model,
            context,
            streamOptions,
            factsSink,
          ),
        );
        if (capture.facts.kind === "managed") {
          credentialActivity?.credentialAttempt?.({
            ...capture.facts,
            lane: "semantic_conversion",
            selectionReason,
            attempt: profileAttempt,
            outcome: "success",
          });
        }
        return result;
      } catch (error) {
        if (capture.facts.kind === "managed") {
          credentialActivity?.credentialAttempt?.({
            ...capture.facts,
            lane: "semantic_conversion",
            selectionReason,
            attempt: profileAttempt,
            outcome:
              error instanceof ExecutionFailure && error.failure?.status === 429
                ? "http_429"
                : streamOptions.signal?.aborted === true
                  ? "aborted"
                  : "failed",
          });
        }
        if (!(error instanceof ExecutionFailure) || error.failure?.status !== 429) {
          throw error;
        }
        // Ambient auth is not a Profile pool and never enters the managed
        // Profile transition Interface.
        if (!isManagedProviderAuthBindingCapture(capture)) throw error;
        attemptedCredentialIds.push(capture.facts.credentialId);
        if (profileAttempt >= MAX_PROFILE_ATTEMPTS_PER_REQUEST) throw error;
        const requestedDelay = retryAfterMs(error.failure.headers, now);
        const transition = await options.bindings.advanceAfterFinal429({
          capture,
          attemptedCredentialIds,
          ...(streamOptions.signal === undefined ? {} : { signal: streamOptions.signal }),
          ...(requestedDelay === undefined ? {} : { retryAfterMs: requestedDelay }),
        });
        if (transition.outcome !== "switched") throw error;
        capture = transition.capture;
        profileAttempt += 1;
        selectionReason = "http_429_switch";
      }
    }
  };
}
