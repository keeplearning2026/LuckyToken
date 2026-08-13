import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import {
  bindFailureLoggingConfiguration,
  type FailureLoggingConfiguration,
} from "./configuration.js";

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

export interface InvocationCheckpoint {
  readonly stage: string;
  readonly selector?: string;
}

export interface InvocationFailure {
  readonly classification: string;
  readonly stage?: string;
  readonly clientStatus?: number;
  readonly cancellation?: boolean;
  readonly error?: unknown;
  readonly safeIds?: Readonly<Record<string, string>>;
  readonly measurements?: Readonly<Record<string, number | boolean>>;
  /** Included only when detail=full, after permanent secret/binary redaction. */
  readonly fullSnapshot?: unknown;
}

export interface InvocationDiagnostics {
  readonly requestId: string;
  notice(notice: ConversionNotice): void;
  attempt(attempt: InvocationAttempt): void;
  checkpoint(checkpoint: InvocationCheckpoint): void;
  succeed(): Promise<void>;
  fail(failure: InvocationFailure): Promise<void>;
}

export interface InvocationDiagnosticsFactory {
  begin(clientProtocol: string): InvocationDiagnostics;
}

export interface InvocationDiagnosticsFactoryOptions {
  readonly configuration: FailureLoggingConfiguration;
  readonly createRequestId?: () => string;
  readonly now?: () => number;
  readonly stderr?: (message: string) => void;
}

const MAX_NOTICES = 128;
const MAX_ATTEMPTS = 128;
const MAX_TEXT = 1_024;
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,128}$/u;
const JOURNAL_NAME = /^[0-9a-f-]{36}\.json$/u;
const SECRET_KEY = /authorization|cookie|api[-_]?key|credential|password|secret|token/i;
const BINARY_KEY = /(?:^|_)(?:data|bytes|binary|image|file|base64)(?:$|_)/i;
const NOTICE_DIRECTIONS = new Set(["request", "response"]);
const NOTICE_ACTIONS = new Set(["ignore", "degrade", "xrepair"]);

function safeText(value: string, maximum = MAX_TEXT): string {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  const redacted = withoutControls
    .replace(/\b(?:bearer|basic)\s+\S+/giu, "[REDACTED]")
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._-]{8,}\b/giu, "[REDACTED]");
  return redacted.length <= maximum ? redacted : `${redacted.slice(0, maximum)}…`;
}

function safeName(value: string, field: string): string {
  if (!SAFE_NAME.test(value)) throw new Error(`${field} must be a bounded safe identifier`);
  return value;
}

function safeStatus(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error(`${field} must be an HTTP status from 100 to 599`);
  }
  return value;
}

function safeIds(values: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
  if (values === undefined) return undefined;
  const entries = Object.entries(values).slice(0, 32).map(([name, value]) => [
    safeName(name, "safeIds key"),
    /^[A-Za-z0-9_.:/-]{1,256}$/u.test(value)
      ? value
      : `sha256:${createHash("sha256").update(value).digest("hex")}`,
  ] as const);
  return Object.freeze(Object.fromEntries(entries));
}

function safeMeasurements(
  values: Readonly<Record<string, number | boolean>> | undefined,
): Readonly<Record<string, number | boolean>> | undefined {
  if (values === undefined) return undefined;
  const output: Record<string, number | boolean> = {};
  for (const [name, value] of Object.entries(values).slice(0, 64)) {
    safeName(name, "measurements key");
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`measurement ${name} must be finite`);
    }
    if (typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`measurement ${name} must be numeric or boolean`);
    }
    output[name] = value;
  }
  return Object.freeze(output);
}

function exceptionChain(error: unknown, full: boolean): readonly Readonly<Record<string, unknown>>[] {
  const result: Array<Readonly<Record<string, unknown>>> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && result.length < 8 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const message = current.message;
      result.push(Object.freeze({
        name: safeText(current.name, 128),
        messageLength: message.length,
        messageHash: createHash("sha256").update(message).digest("hex"),
        ...(full ? { message: safeText(message, 4_096) } : {}),
      }));
      current = current.cause;
    } else {
      const text = String(current);
      result.push(Object.freeze({
        name: "NonErrorCause",
        messageLength: text.length,
        messageHash: createHash("sha256").update(text).digest("hex"),
        ...(full ? { message: safeText(text, 4_096) } : {}),
      }));
      break;
    }
  }
  return Object.freeze(result);
}

function redactFull(value: unknown, key = "", depth = 0, seen = new Set<object>()): unknown {
  if (SECRET_KEY.test(key) || BINARY_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return safeText(value, 16_384);
  if (typeof value !== "object" || depth >= 12) return "[OMITTED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 256).map((entry) => redactFull(entry, key, depth + 1, seen));
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const [name, entry] of Object.entries(value).slice(0, 256)) {
    output[safeText(name, 128)] = redactFull(entry, name, depth + 1, seen);
  }
  return output;
}

function dayDirectory(root: string, timestamp: number): string {
  return join(root, new Date(timestamp).toISOString().slice(0, 10));
}

async function journalFiles(root: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  let days;
  try {
    days = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const directory = join(root, day.name);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !JOURNAL_NAME.test(entry.name)) continue;
      const path = join(directory, entry.name);
      files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    }
  }
  return files;
}

async function enforceRetention(configuration: FailureLoggingConfiguration, now: number): Promise<void> {
  const files = await journalFiles(configuration.directory);
  const cutoff = now - configuration.retentionDays * 86_400_000;
  const expired = files.filter((entry) => entry.mtimeMs < cutoff);
  await Promise.all(expired.map((entry) => rm(entry.path, { force: true })));
  const retained = files
    .filter((entry) => entry.mtimeMs >= cutoff)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const excess = retained.slice(Math.max(0, configuration.maxFiles - 1));
  await Promise.all(excess.map((entry) => rm(entry.path, { force: true })));
}

function boundedJournal(journal: Record<string, unknown>, maximum: number): Uint8Array {
  let encoded = new TextEncoder().encode(`${JSON.stringify(journal, null, 2)}\n`);
  if (encoded.byteLength <= maximum) return encoded;
  const minimal: Record<string, unknown> = {
    version: journal.version,
    requestId: journal.requestId,
    time: journal.time,
    clientProtocol: journal.clientProtocol,
    selector: journal.selector,
    stage: journal.stage,
    classification: journal.classification,
    clientStatus: journal.clientStatus,
    truncation: { truncated: true, originalBytes: encoded.byteLength },
  };
  encoded = new TextEncoder().encode(`${JSON.stringify(minimal)}\n`);
  if (encoded.byteLength <= maximum) return encoded;
  throw new Error(`failure journal core exceeds maxFileBytes (${maximum})`);
}

function createNoopInvocation(): InvocationDiagnostics {
  let finalized = false;
  return Object.freeze({
    requestId: randomUUID(),
    notice: () => undefined,
    attempt: () => undefined,
    checkpoint: () => undefined,
    succeed: async () => { finalized = true; },
    fail: async () => { finalized = true; },
    get finalized() { return finalized; },
  });
}

export function createNoopInvocationDiagnosticsFactory(): InvocationDiagnosticsFactory {
  return Object.freeze({ begin: () => createNoopInvocation() });
}

export function createInvocationDiagnosticsFactory(
  options: InvocationDiagnosticsFactoryOptions,
): InvocationDiagnosticsFactory {
  const configuration = bindFailureLoggingConfiguration(options.configuration);
  const createRequestId = options.createRequestId ?? randomUUID;
  const now = options.now ?? Date.now;
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  if (configuration.detail === "full") {
    stderr("LuckyToken warning: failureLogging.detail=full may record sensitive request text; credentials, cookies, and binary data remain excluded.");
  }

  return Object.freeze({
    begin(clientProtocol: string): InvocationDiagnostics {
      safeName(clientProtocol, "clientProtocol");
      const requestId = createRequestId();
      if (!JOURNAL_NAME.test(`${requestId}.json`) || basename(requestId) !== requestId) {
        throw new Error("createRequestId must return a UUID-shaped safe ID");
      }
      const createdAt = now();
      const notices: ConversionNotice[] = [];
      const attempts: InvocationAttempt[] = [];
      let droppedNotices = 0;
      let droppedAttempts = 0;
      let stage = "ingress";
      let selector: string | undefined;
      let finalized = false;

      const invocation: InvocationDiagnostics = {
        requestId,
        notice(notice): void {
          if (finalized) return;
          if (notices.length >= MAX_NOTICES) {
            droppedNotices += 1;
            return;
          }
          if (!NOTICE_DIRECTIONS.has(notice.direction)) {
            throw new Error("notice.direction must be request or response");
          }
          if (!NOTICE_ACTIONS.has(notice.action)) {
            throw new Error("notice.action must be ignore, degrade, or xrepair");
          }
          if (notice.jsonPath !== undefined && !notice.jsonPath.startsWith("$")) {
            throw new Error("notice.jsonPath must begin with $");
          }
          notices.push(Object.freeze({
            adapter: safeName(notice.adapter, "notice.adapter"),
            direction: notice.direction,
            code: safeName(notice.code, "notice.code"),
            ...(notice.jsonPath === undefined ? {} : { jsonPath: safeText(notice.jsonPath, 512) }),
            action: notice.action,
          }));
        },
        attempt(attempt): void {
          if (finalized) return;
          if (attempts.length >= MAX_ATTEMPTS) {
            droppedAttempts += 1;
            return;
          }
          if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) {
            throw new Error("attempt.attempt must be a positive safe integer");
          }
          if (attempt.retryable !== undefined && typeof attempt.retryable !== "boolean") {
            throw new Error("attempt.retryable must be boolean");
          }
          attempts.push(Object.freeze({
            attempt: attempt.attempt,
            classification: safeName(attempt.classification, "attempt.classification"),
            stage: safeName(attempt.stage, "attempt.stage"),
            ...(safeStatus(attempt.status, "attempt.status") === undefined ? {} : { status: attempt.status }),
            ...(attempt.retryable === undefined ? {} : { retryable: attempt.retryable }),
            ...(attempt.safeIds === undefined
              ? {}
              : { safeIds: safeIds(attempt.safeIds)! }),
          }));
        },
        checkpoint(checkpoint): void {
          if (finalized) return;
          stage = safeName(checkpoint.stage, "checkpoint.stage");
          if (checkpoint.selector !== undefined) selector = safeText(checkpoint.selector, 512);
        },
        async succeed(): Promise<void> {
          if (finalized) return;
          finalized = true;
          notices.length = 0;
          attempts.length = 0;
          selector = undefined;
        },
        async fail(failure): Promise<void> {
          if (finalized) return;
          finalized = true;
          if (failure.cancellation === true && !configuration.logCancellation) return;
          const failureStage = failure.stage === undefined ? stage : safeName(failure.stage, "failure.stage");
          const journal: Record<string, unknown> = {
            version: 1,
            requestId,
            time: new Date(createdAt).toISOString(),
            clientProtocol,
            ...(selector === undefined ? {} : { selector }),
            stage: failureStage,
            classification: safeName(failure.classification, "failure.classification"),
            ...(safeStatus(failure.clientStatus, "failure.clientStatus") === undefined ? {} : { clientStatus: failure.clientStatus }),
            notices,
            attempts,
            ...(failure.safeIds === undefined ? {} : { safeIds: safeIds(failure.safeIds) }),
            ...(failure.measurements === undefined
              ? {}
              : { measurements: safeMeasurements(failure.measurements) }),
            exceptionChain: exceptionChain(failure.error, configuration.detail === "full"),
            truncation: {
              truncated: droppedNotices > 0 || droppedAttempts > 0,
              noticeLimit: MAX_NOTICES,
              attemptLimit: MAX_ATTEMPTS,
              droppedNotices,
              droppedAttempts,
            },
            ...(configuration.detail === "full" && failure.fullSnapshot !== undefined
              ? { fullSnapshot: redactFull(failure.fullSnapshot) }
              : {}),
          };
          try {
            const timestamp = now();
            const directory = dayDirectory(configuration.directory, timestamp);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await enforceRetention(configuration, timestamp);
            const target = join(directory, `${requestId}.json`);
            const temporary = join(directory, `.${requestId}.${randomUUID()}.tmp`);
            try {
              await writeFile(temporary, boundedJournal(journal, configuration.maxFileBytes), {
                flag: "wx",
                mode: 0o600,
              });
              await rename(temporary, target);
            } catch (error) {
              await rm(temporary, { force: true }).catch(() => undefined);
              throw error;
            }
            await chmod(target, 0o600).catch(() => undefined);
          } catch (error) {
            stderr(`LuckyToken failure journal write failed for ${requestId}: ${safeText(error instanceof Error ? error.message : String(error), 512)}`);
          } finally {
            notices.length = 0;
            attempts.length = 0;
            selector = undefined;
          }
        },
      };
      return Object.freeze(invocation);
    },
  });
}
