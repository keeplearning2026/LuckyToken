import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";

import type { TerminalUsageFact } from "./usage.js";

export * from "./upstream-failure.js";

export type {
  TerminalUsageFact,
  TerminalUsageClass,
} from "./usage.js";

export interface ConversionNotice {
  readonly adapter: string;
  readonly direction: "request" | "response";
  readonly code: string;
  readonly jsonPath?: string;
  readonly action: "ignore" | "degrade" | "xrepair";
}

export interface InvocationAttempt {
  readonly attempt: number;
  readonly classification: string;
  readonly stage: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly safeIds?: Readonly<Record<string, string>>;
}

export interface ExecutionFactsSink {
  notice(notice: ConversionNotice): void;
  attempt(attempt: InvocationAttempt): void;
  /** Fail-open terminal usage observation for the Request Ledger. */
  terminalUsage?(fact: TerminalUsageFact): void;
}

const CONVERSION_NOTICE_DIAGNOSTIC_TYPE =
  "luckytoken.conversion_notice.v1";
const INVOCATION_ATTEMPT_DIAGNOSTIC_TYPE =
  "luckytoken.invocation_attempt.v1";
const trustedNoticeDiagnostics = new WeakSet<object>();
const trustedAttemptDiagnostics = new WeakSet<object>();

export function createConversionNoticeDiagnostic(
  notice: ConversionNotice,
  timestamp: number,
): AssistantMessageDiagnostic {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(
      "conversion notice diagnostic timestamp must be a non-negative integer",
    );
  }
  if (!Object.isFrozen(notice)) {
    throw new TypeError(
      "conversion notice diagnostic requires an immutable notice",
    );
  }
  const diagnostic = Object.freeze({
    type: CONVERSION_NOTICE_DIAGNOSTIC_TYPE,
    timestamp,
    details: Object.freeze({ notice }),
  });
  trustedNoticeDiagnostics.add(diagnostic);
  return diagnostic;
}

export function createInvocationAttemptDiagnostic(
  attempt: InvocationAttempt,
  timestamp: number,
): AssistantMessageDiagnostic {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(
      "invocation attempt diagnostic timestamp must be a non-negative integer",
    );
  }
  if (
    !Object.isFrozen(attempt) ||
    (attempt.safeIds !== undefined && !Object.isFrozen(attempt.safeIds))
  ) {
    throw new TypeError(
      "invocation attempt diagnostic requires an immutable attempt",
    );
  }
  const diagnostic = Object.freeze({
    type: INVOCATION_ATTEMPT_DIAGNOSTIC_TYPE,
    timestamp,
    details: Object.freeze({ attempt }),
  });
  trustedAttemptDiagnostics.add(diagnostic);
  return diagnostic;
}

export function submitExecutionFacts(
  diagnostics: readonly AssistantMessageDiagnostic[] | undefined,
  sink: ExecutionFactsSink | undefined,
): void {
  if (diagnostics === undefined || sink === undefined) return;
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.type !== CONVERSION_NOTICE_DIAGNOSTIC_TYPE ||
      !trustedNoticeDiagnostics.has(diagnostic)
    ) {
      if (
        diagnostic.type === INVOCATION_ATTEMPT_DIAGNOSTIC_TYPE &&
        trustedAttemptDiagnostics.has(diagnostic)
      ) {
        const attempt = diagnostic.details?.attempt;
        if (typeof attempt === "object" && attempt !== null) {
          sink.attempt(attempt as unknown as InvocationAttempt);
        }
      }
      continue;
    }
    const notice = diagnostic.details?.notice;
    if (typeof notice === "object" && notice !== null) {
      sink.notice(notice as unknown as ConversionNotice);
    }
  }
}
