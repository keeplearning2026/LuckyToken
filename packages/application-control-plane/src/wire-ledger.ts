import type {
  LedgerAttempt,
  LedgerFailureSummary,
  LedgerNotice,
  LedgerPhase,
  LedgerOutcome,
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerQueryResult,
  RequestLedgerRecord,
} from "./ledger-contract.js";
import { decodeNormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";
import { isRecord } from "./wire.js";

/**
 * Wire codecs for the Request Ledger surface (Ticket 18). Strict allowlist
 * decoders: a frame carrying an unknown key or a value outside the bounded
 * grammar is rejected, never projected. The internal effective session
 * identity has its own distinct field and is never copied into the client
 * session field.
 */

const LEDGER_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEDGER_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEDGER_MESSAGE_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** Query allowlist: unknown keys are rejected, consistent with the record
 *  and event allowlists. */
const LEDGER_QUERY_KEYS: ReadonlySet<string> = new Set([
  "afterId",
  "limit",
  "protocolId",
  "providerId",
  "realModelId",
  "projectDir",
  "clientSessionId",
  "outcome",
  "from",
  "to",
]);

const LEDGER_RECORD_KEYS: ReadonlySet<string> = new Set([
  "id",
  "requestId",
  "protocolId",
  "phase",
  "outcome",
  "acceptedAt",
  "executionStartedAt",
  "terminalAt",
  "completedAt",
  "clientHttpStatus",
  "externalAlias",
  "providerId",
  "realModelId",
  "clientSessionId",
  "effectiveSessionId",
  "projectDir",
  "facts",
  "terminalUsage",
]);

const LEDGER_FACTS_KEYS: ReadonlySet<string> = new Set([
  "notices",
  "attempts",
  "failure",
  "persistenceWarnings",
  "piStopReason",
]);

const LEDGER_NOTICE_KEYS: ReadonlySet<string> = new Set([
  "adapter",
  "direction",
  "code",
  "jsonPath",
  "action",
]);

const LEDGER_ATTEMPT_KEYS: ReadonlySet<string> = new Set([
  "attempt",
  "classification",
  "stage",
  "status",
  "retryable",
  "safeIds",
]);

const LEDGER_FAILURE_KEYS: ReadonlySet<string> = new Set([
  "classification",
  "stage",
  "messageHash",
]);

function isLedgerPhase(value: unknown): value is LedgerPhase {
  return (
    value === "accepted" ||
    value === "execution" ||
    value === "rendering" ||
    value === "terminal-preparation"
  );
}

function isLedgerOutcome(value: unknown): value is LedgerOutcome {
  return (
    value === "running" ||
    value === "success" ||
    value === "failed" ||
    value === "aborted" ||
    value === "rejected-auth" ||
    value === "unknown-alias" ||
    value === "unavailable-alias" ||
    value === "interrupted"
  );
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function optionalTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function decodeNotice(value: unknown): LedgerNotice | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!LEDGER_NOTICE_KEYS.has(key)) return undefined;
  }
  const adapter = boundedText(value.adapter, 128);
  const code = boundedText(value.code, 128);
  const jsonPath =
    value.jsonPath === undefined
      ? undefined
      : typeof value.jsonPath === "string" && value.jsonPath.length <= 4_096
        ? value.jsonPath
        : undefined;
  if (
    adapter === undefined ||
    code === undefined ||
    (value.direction !== "request" && value.direction !== "response") ||
    (value.action !== "ignore" &&
      value.action !== "degrade" &&
      value.action !== "xrepair") ||
    (value.jsonPath !== undefined && jsonPath === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    adapter,
    direction: value.direction as LedgerNotice["direction"],
    code,
    ...(jsonPath === undefined ? {} : { jsonPath }),
    action: value.action as LedgerNotice["action"],
  });
}

function decodeSafeIds(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, string> = {};
  let entries = 0;
  for (const [name, entry] of Object.entries(value)) {
    if (entries >= 32) return undefined;
    const safeName = boundedText(name, 128);
    const safeValue =
      typeof entry === "string" && entry.length > 0 && entry.length <= 512
        ? entry
        : undefined;
    if (safeName === undefined || safeValue === undefined) return undefined;
    output[safeName] = safeValue;
    entries += 1;
  }
  return Object.freeze(output);
}

function decodeAttempt(value: unknown): LedgerAttempt | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!LEDGER_ATTEMPT_KEYS.has(key)) return undefined;
  }
  const classification = boundedText(value.classification, 128);
  const stage = boundedText(value.stage, 128);
  if (
    classification === undefined ||
    stage === undefined ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1
  ) {
    return undefined;
  }
  const status = value.status;
  if (
    (status !== undefined &&
      (!Number.isSafeInteger(status) ||
        (status as number) < 100 ||
        (status as number) > 599)) ||
    (value.retryable !== undefined && typeof value.retryable !== "boolean")
  ) {
    return undefined;
  }
  const safeIds =
    value.safeIds === undefined ? undefined : decodeSafeIds(value.safeIds);
  if (value.safeIds !== undefined && safeIds === undefined) return undefined;
  return Object.freeze({
    attempt: value.attempt as number,
    classification,
    stage,
    ...(status === undefined ? {} : { status: status as number }),
    ...(value.retryable === undefined
      ? {}
      : { retryable: value.retryable as boolean }),
    ...(safeIds === undefined ? {} : { safeIds }),
  });
}

function decodeFailure(value: unknown): LedgerFailureSummary | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!LEDGER_FAILURE_KEYS.has(key)) return undefined;
  }
  const classification = boundedText(value.classification, 128);
  const messageHash = boundedText(value.messageHash, 64);
  const stage =
    value.stage === undefined
      ? undefined
      : typeof value.stage === "string" && value.stage.length <= 128
        ? value.stage
        : undefined;
  if (
    classification === undefined ||
    messageHash === undefined ||
    !LEDGER_MESSAGE_HASH_PATTERN.test(messageHash) ||
    (value.stage !== undefined && stage === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    classification,
    ...(stage === undefined ? {} : { stage }),
    messageHash,
  });
}

function decodeFacts(value: unknown): Readonly<{
  notices?: readonly LedgerNotice[];
  attempts?: readonly LedgerAttempt[];
  failure?: LedgerFailureSummary;
  persistenceWarnings?: number;
  piStopReason?: string;
}> | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!LEDGER_FACTS_KEYS.has(key)) return undefined;
  }
  const notices =
    value.notices === undefined ? undefined : decodeNoticeArray(value.notices);
  const attempts =
    value.attempts === undefined ? undefined : decodeAttemptArray(value.attempts);
  const failure =
    value.failure === undefined ? undefined : decodeFailure(value.failure);
  if (
    (value.notices !== undefined && notices === undefined) ||
    (value.attempts !== undefined && attempts === undefined) ||
    (value.failure !== undefined && failure === undefined)
  ) {
    return undefined;
  }
  const persistenceWarnings = value.persistenceWarnings;
  if (
    persistenceWarnings !== undefined &&
    (!Number.isSafeInteger(persistenceWarnings) ||
      (persistenceWarnings as number) < 0)
  ) {
    return undefined;
  }
  const piStopReason =
    value.piStopReason === undefined
      ? undefined
      : typeof value.piStopReason === "string" &&
          value.piStopReason.length <= 4_096
        ? value.piStopReason
        : undefined;
  if (
    (value.piStopReason !== undefined && piStopReason === undefined) ||
    (notices === undefined &&
      attempts === undefined &&
      failure === undefined &&
      persistenceWarnings === undefined &&
      piStopReason === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(notices === undefined ? {} : { notices }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(failure === undefined ? {} : { failure }),
    ...(persistenceWarnings === undefined
      ? {}
      : { persistenceWarnings: persistenceWarnings as number }),
    ...(piStopReason === undefined ? {} : { piStopReason }),
  });
}

function decodeNoticeArray(value: unknown): readonly LedgerNotice[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return undefined;
  }
  const notices: LedgerNotice[] = [];
  for (const entry of value) {
    const notice = decodeNotice(entry);
    if (notice === undefined) return undefined;
    notices.push(notice);
  }
  return Object.freeze(notices);
}

function decodeAttemptArray(value: unknown): readonly LedgerAttempt[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return undefined;
  }
  const attempts: LedgerAttempt[] = [];
  for (const entry of value) {
    const attempt = decodeAttempt(entry);
    if (attempt === undefined) return undefined;
    attempts.push(attempt);
  }
  return Object.freeze(attempts);
}

/**
 * Strict ledger record decoder: the allowed key set is exact, every field is
 * bounded, and the internal effective session identity is validated only by
 * its own field — it is never copied into or substituted for the client
 * session id.
 */
export function decodeRequestLedgerRecord(
  value: unknown,
): RequestLedgerRecord | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!LEDGER_RECORD_KEYS.has(key)) return undefined;
  }
  if (
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.protocolId !== "string" ||
    value.protocolId.length === 0 ||
    value.protocolId.length > 128 ||
    !isLedgerPhase(value.phase) ||
    !isLedgerOutcome(value.outcome) ||
    !Number.isSafeInteger(value.acceptedAt) ||
    (value.acceptedAt as number) < 0
  ) {
    return undefined;
  }
  const requestId = boundedText(value.requestId, 36);
  if (requestId === undefined || !LEDGER_REQUEST_ID_PATTERN.test(requestId)) {
    return undefined;
  }
  const executionStartedAt = optionalTime(value.executionStartedAt);
  const terminalAt = optionalTime(value.terminalAt);
  const completedAt = optionalTime(value.completedAt);
  if (
    (value.executionStartedAt !== undefined &&
      executionStartedAt === undefined) ||
    (value.terminalAt !== undefined && terminalAt === undefined) ||
    (value.completedAt !== undefined && completedAt === undefined)
  ) {
    return undefined;
  }
  const clientHttpStatus = value.clientHttpStatus;
  if (clientHttpStatus !== undefined) {
    if (
      !Number.isSafeInteger(clientHttpStatus) ||
      (clientHttpStatus as number) < 100 ||
      (clientHttpStatus as number) > 599
    ) {
      return undefined;
    }
  }
  const externalAlias = boundedText(value.externalAlias, 4_096);
  const providerId = boundedText(value.providerId, 256);
  const realModelId = boundedText(value.realModelId, 256);
  const projectDir = boundedText(value.projectDir, 1_024);
  if (
    (value.externalAlias !== undefined && externalAlias === undefined) ||
    (value.providerId !== undefined && providerId === undefined) ||
    (value.realModelId !== undefined && realModelId === undefined) ||
    (value.projectDir !== undefined && projectDir === undefined)
  ) {
    return undefined;
  }
  // Session identities: each field validates independently against the UUID
  // grammar; a record missing clientSessionId never gains one from the
  // effective identity.
  const clientSessionId = value.clientSessionId;
  const effectiveSessionId = value.effectiveSessionId;
  if (
    (clientSessionId !== undefined &&
      (typeof clientSessionId !== "string" ||
        !LEDGER_SESSION_ID_PATTERN.test(clientSessionId))) ||
    (effectiveSessionId !== undefined &&
      (typeof effectiveSessionId !== "string" ||
        !LEDGER_SESSION_ID_PATTERN.test(effectiveSessionId)))
  ) {
    return undefined;
  }
  const facts = value.facts === undefined ? undefined : decodeFacts(value.facts);
  if (value.facts !== undefined && facts === undefined) return undefined;
  const terminalUsage =
    value.terminalUsage === undefined
      ? undefined
      : decodeNormalizedTerminalUsage(value.terminalUsage);
  if (value.terminalUsage !== undefined && terminalUsage === undefined) {
    return undefined;
  }
  return Object.freeze({
    id: value.id as number,
    requestId,
    protocolId: value.protocolId,
    phase: value.phase as LedgerPhase,
    outcome: value.outcome as LedgerOutcome,
    acceptedAt: value.acceptedAt as number,
    ...(executionStartedAt === undefined ? {} : { executionStartedAt }),
    ...(terminalAt === undefined ? {} : { terminalAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(clientHttpStatus === undefined
      ? {}
      : { clientHttpStatus: clientHttpStatus as number }),
    ...(externalAlias === undefined ? {} : { externalAlias }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(realModelId === undefined ? {} : { realModelId }),
    ...(clientSessionId === undefined
      ? {}
      : { clientSessionId: clientSessionId as string }),
    ...(effectiveSessionId === undefined
      ? {}
      : { effectiveSessionId: effectiveSessionId as string }),
    ...(projectDir === undefined ? {} : { projectDir }),
    ...(facts === undefined ? {} : { facts }),
    ...(terminalUsage === undefined ? {} : { terminalUsage }),
  });
}

export function decodeRequestLedgerEvent(
  value: unknown,
): RequestLedgerEvent | undefined {
  if (!isRecord(value) || value.type !== "request_ledger") return undefined;
  const record = decodeRequestLedgerRecord(value.record);
  return record === undefined
    ? undefined
    : { type: "request_ledger", record };
}

function decodeOutcome(value: unknown): LedgerOutcome | undefined {
  return isLedgerOutcome(value) ? value : undefined;
}

export function decodeRequestLedgerQuery(
  value: unknown,
): RequestLedgerQuery | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (!LEDGER_QUERY_KEYS.has(key)) return undefined;
  }
  const afterId =
    value.afterId === undefined
      ? undefined
      : Number.isSafeInteger(value.afterId) && (value.afterId as number) >= 1
        ? (value.afterId as number)
        : undefined;
  if (value.afterId !== undefined && afterId === undefined) return undefined;
  const limit =
    value.limit === undefined
      ? undefined
      : Number.isSafeInteger(value.limit) &&
          (value.limit as number) >= 1 &&
          (value.limit as number) <= 1_000
        ? (value.limit as number)
        : undefined;
  if (value.limit !== undefined && limit === undefined) return undefined;
  const protocolId =
    value.protocolId === undefined
      ? undefined
      : boundedText(value.protocolId, 128);
  const providerId =
    value.providerId === undefined
      ? undefined
      : boundedText(value.providerId, 256);
  const realModelId =
    value.realModelId === undefined
      ? undefined
      : boundedText(value.realModelId, 256);
  const projectDir =
    value.projectDir === undefined
      ? undefined
      : boundedText(value.projectDir, 1_024);
  const clientSessionId =
    value.clientSessionId === undefined
      ? undefined
      : boundedText(value.clientSessionId, 1_024);
  if (
    (value.protocolId !== undefined && protocolId === undefined) ||
    (value.providerId !== undefined && providerId === undefined) ||
    (value.realModelId !== undefined && realModelId === undefined) ||
    (value.projectDir !== undefined && projectDir === undefined) ||
    (value.clientSessionId !== undefined && clientSessionId === undefined)
  ) {
    return undefined;
  }
  const outcome = decodeOutcome(value.outcome);
  if (value.outcome !== undefined && outcome === undefined) return undefined;
  const from =
    value.from === undefined
      ? undefined
      : Number.isSafeInteger(value.from) && (value.from as number) >= 0
        ? (value.from as number)
        : undefined;
  const to =
    value.to === undefined
      ? undefined
      : Number.isSafeInteger(value.to) && (value.to as number) >= 0
        ? (value.to as number)
        : undefined;
  if (
    (value.from !== undefined && from === undefined) ||
    (value.to !== undefined && to === undefined) ||
    (from !== undefined && to !== undefined && from > to)
  ) {
    return undefined;
  }
  return {
    ...(afterId === undefined ? {} : { afterId }),
    ...(limit === undefined ? {} : { limit }),
    ...(protocolId === undefined ? {} : { protocolId }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(realModelId === undefined ? {} : { realModelId }),
    ...(projectDir === undefined ? {} : { projectDir }),
    ...(clientSessionId === undefined ? {} : { clientSessionId }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

export function decodeRequestLedgerResult(
  value: unknown,
): RequestLedgerQueryResult | undefined {
  if (!isRecord(value) || !Array.isArray(value.records)) return undefined;
  const records = value.records
    .map((entry) => decodeRequestLedgerRecord(entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (records.length !== value.records.length) return undefined;
  if (typeof value.hasMore !== "boolean") return undefined;
  return Object.freeze({
    records: Object.freeze(records),
    hasMore: value.hasMore,
  });
}