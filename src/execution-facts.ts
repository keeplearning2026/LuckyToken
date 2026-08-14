import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";

import type {
  ConversionNotice,
  InvocationAttempt,
} from "./invocation-diagnostics/index.js";

const CONVERSION_NOTICE_DIAGNOSTIC_TYPE =
  "luckytoken.conversion_notice.v1";
const trustedNoticeDiagnostics = new WeakSet<object>();

export interface ExecutionFactsSink {
  notice(notice: ConversionNotice): void;
  attempt(attempt: InvocationAttempt): void;
}

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
    throw new TypeError("conversion notice diagnostic requires an immutable notice");
  }
  const diagnostic = Object.freeze({
    type: CONVERSION_NOTICE_DIAGNOSTIC_TYPE,
    timestamp,
    details: Object.freeze({ notice }),
  });
  trustedNoticeDiagnostics.add(diagnostic);
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
      continue;
    }
    const notice = diagnostic.details?.notice;
    if (typeof notice === "object" && notice !== null) {
      sink.notice(notice as unknown as ConversionNotice);
    }
  }
}
