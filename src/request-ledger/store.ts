/**
 * Request Lifecycle Ledger store (Ticket 18) — the permanent SQLite/WAL
 * authority for lifecycle + narrow facts, modeled on the Runtime Diagnostics
 * store (Ticket 07) but with its own versioned database and its own policy.
 *
 * The store is deliberately NOT a second semantic request model: rows carry
 * lifecycle phases/timestamps, the outcome, the captured authority snapshots,
 * and a bounded facts summary — never raw protocol payloads. It is versioned
 * and refuses unknown or foreign schema without mutating the original file.
 * All access is prepared/bound statements inside synchronous SQLite
 * transactions; writes are intentionally low-frequency and off the request
 * hot path.
 *
 * Failure policy: a ledger persistence fault is fail-open — it never throws
 * into the handler and never changes a model response. The observer counts
 * persistence warnings and reports one narrow sanitized fact (request id +
 * message hash) through the injected diagnostics seam.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as createDatabaseSync } from "node:sqlite";

import {
  assertLedgerOutcome,
  assertLedgerPhase,
  type LedgerAliasFact,
  type LedgerAttempt,
  type LedgerAuthFacts,
  type LedgerFailureInput,
  type LedgerFailureSummary,
  type LedgerFacts,
  type LedgerModelSnapshot,
  type LedgerNotice,
  type LedgerOutcome,
  type LedgerPersistenceFailure,
  type LedgerPhase,
  type LedgerTerminalFacts,
  type LedgerTerminalOutcome,
  type RequestLedgerEntry,
  type RequestLedgerEvent,
  type RequestLedgerQuery,
  type RequestLedgerQueryResult,
  type RequestLedgerRecord,
  type RequestLedgerStore,
} from "./contract.js";
import { decodeNormalizedTerminalUsage, type NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";
import type { AnalyticsQuery, AnalyticsQueryResult } from "@luckytoken/application-control-plane/control-plane";
import { redactDiagnosticText } from "../runtime-diagnostics/redaction.js";
import { createLedgerAnalyticsAccumulator } from "./analytics.js";

const SCHEMA_NAME = "luckytoken_request_ledger";
const SCHEMA_VERSION = 2;
const MAX_QUERY_LIMIT = 1_000;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_NOTICES = 64;
const MAX_ATTEMPTS = 64;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface RequestLedgerStoreOptions {
  readonly configuration: { readonly directory: string };
  readonly createRequestId?: () => string;
  readonly now?: () => number;
  readonly databaseFactory?: {
    open(path: string): DatabaseSync;
  };
  /**
   * Opaque known-value scrubber (Ticket 07 F4): removes arbitrary
   * user-chosen Client tokens / provider credentials from every producer
   * value before commit. Supplied by the credential authorities through
   * composition; pattern redaction is the baseline either way.
   */
  readonly scrub?: (value: string) => string;
  /** Narrow sanitized persistence-failure seam (Ticket 18): invoked with a
   *  request id and a message hash only; never with fault text. Wired by
   *  the composition to the diagnostics Critical surface. */
  readonly onPersistenceFailure?: (fact: LedgerPersistenceFailure) => void;
}

interface Row {
  readonly id: number;
  readonly requestId: string;
  readonly protocolId: string;
  readonly phase: string;
  readonly outcome: string;
  readonly acceptedAt: number;
  readonly executionStartedAt: number | null;
  readonly terminalAt: number | null;
  readonly completedAt: number | null;
  readonly clientHttpStatus: number | null;
  readonly externalAlias: string | null;
  readonly providerId: string | null;
  readonly realModelId: string | null;
  readonly clientSessionId: string | null;
  readonly effectiveSessionId: string | null;
  readonly projectDir: string | null;
  readonly facts: string | null;
  readonly terminalUsage: string | null;
}

interface DraftFacts {
  readonly notices: readonly LedgerNotice[];
  readonly attempts: readonly LedgerAttempt[];
  readonly failure?: LedgerFailureSummary;
  readonly persistenceWarnings: number;
  readonly piStopReason?: string;
}

/** Ticket 20: the canonical terminal-usage snapshot draft (validated on
 *  ingest by the shared decoder, never by guessing). */
type TerminalUsageDraft = NonNullable<RequestLedgerRecord["terminalUsage"]>;

/** In-memory authoritative draft of one request's committed row; the one
 *  representation rebuilt into every transition's full-column UPDATE. */
interface LedgerDraft {
  id: number | undefined;
  readonly protocolId: string;
  readonly requestId: string;
  phase: LedgerPhase;
  outcome: LedgerOutcome;
  acceptedAt: number;
  executionStartedAt?: number;
  terminalAt?: number;
  completedAt?: number;
  clientHttpStatus?: number;
  externalAlias?: string;
  providerId?: string;
  realModelId?: string;
  clientSessionId?: string;
  effectiveSessionId?: string;
  projectDir?: string;
  facts: DraftFacts;
  terminalUsage?: TerminalUsageDraft;
  /** True once the narrow persistence-failure seam fired for this entry:
   *  one sanitized report per request, later faults only count warnings. */
  faultReported: boolean;
}

/**
 * Versioned schema; refuses unknown or foreign schema without mutation.
 * Must run before any write (including WAL pragmas) so foreign files are
 * never modified.
 *
 * v1 -> v2 (Ticket 20): adds the `terminal_usage` column carrying the
 * canonical terminal-usage snapshot. The migration is atomic (one
 * transaction), preserves every v1 row (existing rows keep their facts and
 * a NULL snapshot — history stays truthful), and a failure rolls back
 * leaving the v1 file untouched. Unknown/future schema versions are
 * refused without mutation.
 */
function initializeSchema(database: DatabaseSync): void {
  const existing = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  const hasMeta = existing.some((entry) => entry.name === "meta");
  if (hasMeta) {
    const meta = database.prepare(
      "SELECT value FROM meta WHERE key = 'schema_name'",
    );
    const name = meta.get() as { value: string } | undefined;
    if (name === undefined || name.value !== SCHEMA_NAME) {
      throw new Error(
        name === undefined
          ? "request ledger database has no schema name"
          : `request ledger database belongs to a different schema (${name.value})`,
      );
    }
    const versionRow = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: number } | undefined;
    if (versionRow === undefined) {
      throw new Error("request ledger database has no schema version");
    }
    if (versionRow.value === SCHEMA_VERSION) return;
    if (versionRow.value === 1) {
      migrateV1ToV2(database);
      return;
    }
    throw new Error(
      `request ledger database schema ${versionRow.value} is not supported (supported: ${SCHEMA_VERSION})`,
    );
  }
  if (existing.length > 0) {
    throw new Error("request ledger database contains an unknown schema");
  }
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value NOT NULL);
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      protocol_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      outcome TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      execution_started_at INTEGER,
      terminal_at INTEGER,
      completed_at INTEGER,
      client_http_status INTEGER,
      external_alias TEXT,
      provider_id TEXT,
      real_model_id TEXT,
      client_session_id TEXT,
      effective_session_id TEXT,
      project_dir TEXT,
      facts TEXT,
      terminal_usage TEXT
    );
    CREATE INDEX requests_id_desc ON requests (id DESC);
    CREATE INDEX requests_accepted ON requests (accepted_at, id);
    CREATE INDEX requests_outcome ON requests (outcome, id);
    CREATE INDEX requests_provider_model ON requests (provider_id, real_model_id, id);
    CREATE INDEX requests_project ON requests (project_dir, id);
    INSERT INTO meta (key, value) VALUES ('schema_name', '${SCHEMA_NAME}');
    INSERT INTO meta (key, value) VALUES ('schema_version', ${SCHEMA_VERSION});
  `);
}

/**
 * Atomic v1 -> v2 migration: one transaction adds the `terminal_usage`
 * column and bumps the schema version. v1 rows are never rewritten; a
 * failure rolls back to the untouched v1 file.
 */
function migrateV1ToV2(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("ALTER TABLE requests ADD COLUMN terminal_usage TEXT");
    database.exec(
      "UPDATE meta SET value = 2 WHERE key = 'schema_version'",
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function decodeJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("request ledger database contains invalid JSON facts");
  }
}

function encodeFacts(facts: DraftFacts): string | null {
  const output: Record<string, unknown> = {};
  if (facts.notices.length > 0) output.notices = facts.notices;
  if (facts.attempts.length > 0) output.attempts = facts.attempts;
  if (facts.failure !== undefined) output.failure = facts.failure;
  if (facts.persistenceWarnings > 0) {
    output.persistenceWarnings = facts.persistenceWarnings;
  }
  if (facts.piStopReason !== undefined) {
    output.piStopReason = facts.piStopReason;
  }
  return Object.keys(output).length === 0 ? null : JSON.stringify(output);
}

function decodeFacts(value: unknown): Readonly<LedgerFacts> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    return undefined;
  }
  const facts = value as Record<string, unknown>;
  const output: Readonly<LedgerFacts> = Object.freeze({
    ...(facts.notices === undefined
      ? {}
      : { notices: Object.freeze(facts.notices as readonly LedgerNotice[]) }),
    ...(facts.attempts === undefined
      ? {}
      : { attempts: Object.freeze(facts.attempts as readonly LedgerAttempt[]) }),
    ...(facts.failure === undefined
      ? {}
      : { failure: facts.failure as LedgerFailureSummary }),
    ...(facts.persistenceWarnings === undefined
      ? {}
      : { persistenceWarnings: facts.persistenceWarnings as number }),
    ...(facts.piStopReason === undefined
      ? {}
      : { piStopReason: facts.piStopReason as string }),
  });
  return Object.keys(output).length === 0 ? undefined : output;
}

/** Ticket 20: snapshot bytes carry the decoder-validated shape only. */
function encodeTerminalUsage(
  snapshot: TerminalUsageDraft | undefined,
): string | null {
  return snapshot === undefined ? null : JSON.stringify(snapshot);
}

function decodeTerminalUsage(
  value: string | null,
): Readonly<NormalizedTerminalUsage> | undefined {
  if (value === null) return undefined;
  try {
    return decodeNormalizedTerminalUsage(JSON.parse(value) as unknown);
  } catch {
    throw new Error(
      "request ledger database contains invalid terminal usage JSON",
    );
  }
}

function rowToRecord(row: Row): RequestLedgerRecord {
  const facts = decodeFacts(decodeJson(row.facts));
  const terminalUsage = decodeTerminalUsage(row.terminalUsage);
  const record: RequestLedgerRecord = {
    id: row.id,
    requestId: row.requestId,
    protocolId: row.protocolId,
    phase: assertLedgerPhase(row.phase),
    outcome: assertLedgerOutcome(row.outcome),
    acceptedAt: row.acceptedAt,
    ...(row.executionStartedAt === null
      ? {}
      : { executionStartedAt: row.executionStartedAt }),
    ...(row.terminalAt === null ? {} : { terminalAt: row.terminalAt }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
    ...(row.clientHttpStatus === null
      ? {}
      : { clientHttpStatus: row.clientHttpStatus }),
    ...(row.externalAlias === null ? {} : { externalAlias: row.externalAlias }),
    ...(row.providerId === null ? {} : { providerId: row.providerId }),
    ...(row.realModelId === null ? {} : { realModelId: row.realModelId }),
    ...(row.clientSessionId === null
      ? {}
      : { clientSessionId: row.clientSessionId }),
    ...(row.effectiveSessionId === null
      ? {}
      : { effectiveSessionId: row.effectiveSessionId }),
    ...(row.projectDir === null ? {} : { projectDir: row.projectDir }),
    ...(facts === undefined ? {} : { facts }),
    ...(terminalUsage === undefined ? {} : { terminalUsage }),
  };
  return Object.freeze(record);
}

function applyScrub(
  value: string,
  scrub: ((value: string) => string) | undefined,
): string {
  if (scrub === undefined) return value;
  try {
    return scrub(value);
  } catch {
    return "[SCRUB_FAILED]";
  }
}

/**
 * Universal string choke point: known-value scrub first, then the pattern
 * redaction, then a hard bound. Credentials must never appear in ledger
 * bytes, CP frames, or persisted WAL frames.
 */
function safeText(
  value: string,
  maximum: number,
  scrub: ((value: string) => string) | undefined,
): string {
  const scrubbed = redactDiagnosticText(applyScrub(value, scrub), scrub);
  return scrubbed.length <= maximum
    ? scrubbed
    : `${scrubbed.slice(0, maximum)}…`;
}

function safeName(value: string, field: string): string {
  if (!SAFE_NAME_PATTERN.test(value)) {
    throw new Error(`${field} must be a bounded safe identifier`);
  }
  return value;
}

function safeStatus(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error(`${field} must be an HTTP status from 100 to 599`);
  }
  return value;
}

function safeTime(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must return a non-negative safe integer`);
  }
  return value;
}

export function createRequestLedgerStoreFactory(
  options: RequestLedgerStoreOptions,
): { open(): Promise<RequestLedgerStore> } {
  const createRequestId = options.createRequestId ?? randomUUID;
  const now = options.now ?? Date.now;
  const databaseFactory = options.databaseFactory ?? {
    open: (path: string) => new createDatabaseSync(path),
  };
  const directory = options.configuration.directory;
  const scrub = options.scrub;
  const onPersistenceFailure = options.onPersistenceFailure;

  return {
    async open(): Promise<RequestLedgerStore> {
      await mkdir(directory, { recursive: true });
      const path = join(directory, "ledger.sqlite3");
      const database = databaseFactory.open(path);
      let closed = false;
      try {
        initializeSchema(database);
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = NORMAL");
        // Startup recovery: a committed `running` row can only mean the last
        // transition predated a crash. Recover it into a truthful
        // interrupted/unknown terminal state instead of deleting it; this
        // runs on open so it is idempotent and covers every reopen. The
        // injected clock is guarded like every other seam: a throwing clock
        // must not prevent the store from opening.
        let recoveryTime: number;
        try {
          recoveryTime = safeTime(now(), "request ledger clock");
        } catch {
          recoveryTime = Date.now();
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare(
              "UPDATE requests SET outcome = 'interrupted', terminal_at = ?, completed_at = ? WHERE outcome = 'running'",
            )
            .run(recoveryTime, recoveryTime);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        database.close();
        throw error;
      }
      const insert = database.prepare(
        `INSERT INTO requests (
           request_id, protocol_id, phase, outcome, accepted_at,
           execution_started_at, terminal_at, completed_at, client_http_status,
           external_alias, provider_id, real_model_id, client_session_id,
           effective_session_id, project_dir, facts, terminal_usage
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const update = database.prepare(
        `UPDATE requests SET
           phase = ?, outcome = ?, accepted_at = ?, execution_started_at = ?,
           terminal_at = ?, completed_at = ?, client_http_status = ?,
           external_alias = ?, provider_id = ?, real_model_id = ?,
           client_session_id = ?, effective_session_id = ?, project_dir = ?,
           facts = ?, terminal_usage = ?
         WHERE id = ?`,
      );
      const selectBase = `SELECT
           id, request_id AS requestId, protocol_id AS protocolId, phase,
           outcome, accepted_at AS acceptedAt,
           execution_started_at AS executionStartedAt,
           terminal_at AS terminalAt, completed_at AS completedAt,
           client_http_status AS clientHttpStatus,
           external_alias AS externalAlias, provider_id AS providerId,
           real_model_id AS realModelId,
           client_session_id AS clientSessionId,
           effective_session_id AS effectiveSessionId,
           project_dir AS projectDir, facts, terminal_usage AS terminalUsage
         FROM requests`;
      const eventListeners = new Set<(event: RequestLedgerEvent) => void>();
      let attachedScrub = scrub;

      /** One full-column UPDATE under BEGIN IMMEDIATE; committed state is
       *  published to subscribers. Fail-open: throws are swallowed, counted
       *  as persistence warnings and reported through the narrow seam. */
      const persistEntry = (entry: LedgerDraft): void => {
        if (closed) {
          countEntryFault(
            entry,
            new Error("Request Ledger store is closed"),
          );
          return;
        }
        if (entry.id === undefined) return;
        try {
          database.exec("BEGIN IMMEDIATE");
          try {
            update.run(
              entry.phase,
              entry.outcome,
              entry.acceptedAt,
              entry.executionStartedAt ?? null,
              entry.terminalAt ?? null,
              entry.completedAt ?? null,
              entry.clientHttpStatus ?? null,
              entry.externalAlias ?? null,
              entry.providerId ?? null,
              entry.realModelId ?? null,
              entry.clientSessionId ?? null,
              entry.effectiveSessionId ?? null,
              entry.projectDir ?? null,
              encodeFacts(entry.facts),
              encodeTerminalUsage(entry.terminalUsage),
              entry.id,
            );
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error);
          const messageHash = createHash("sha256").update(message).digest("hex");
          entry.facts = Object.freeze({
            ...entry.facts,
            persistenceWarnings: entry.facts.persistenceWarnings + 1,
          });
          try {
            onPersistenceFailure?.({ requestId: entry.requestId, messageHash });
          } catch {
            // The diagnostics seam must never affect the request path.
          }
          return;
        }
        if (entry.id !== undefined) {
          const record = rowToRecord({
            id: entry.id,
            requestId: entry.requestId,
            protocolId: entry.protocolId,
            phase: entry.phase,
            outcome: entry.outcome,
            acceptedAt: entry.acceptedAt,
            executionStartedAt: entry.executionStartedAt ?? null,
            terminalAt: entry.terminalAt ?? null,
            completedAt: entry.completedAt ?? null,
            clientHttpStatus: entry.clientHttpStatus ?? null,
            externalAlias: entry.externalAlias ?? null,
            providerId: entry.providerId ?? null,
            realModelId: entry.realModelId ?? null,
            clientSessionId: entry.clientSessionId ?? null,
            effectiveSessionId: entry.effectiveSessionId ?? null,
            projectDir: entry.projectDir ?? null,
            facts: encodeFacts(entry.facts),
            terminalUsage: encodeTerminalUsage(entry.terminalUsage),
          });
          for (const listener of eventListeners) {
            listener({ type: "request_ledger", record });
          }
        }
      };

      /** Fail-open ledger fault: a transition could not be committed (clock,
       *  input, or database fault). Counts a persistence warning; the narrow
       *  sanitized seam fires once per request (later faults of the same
       *  entry only count) so one request never floods the diagnostics.
       *  Never reaches the caller: the fallback callback itself is guarded
       *  so it cannot recursively steer the request. */
      const countEntryFault = (entry: LedgerDraft, error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        entry.facts = Object.freeze({
          ...entry.facts,
          persistenceWarnings: entry.facts.persistenceWarnings + 1,
        });
        if (entry.faultReported) return;
        entry.faultReported = true;
        try {
          onPersistenceFailure?.({
            requestId: entry.requestId,
            messageHash: createHash("sha256").update(message).digest("hex"),
          });
        } catch {
          // The diagnostics seam must never affect the request path.
        }
      };

      const store: RequestLedgerStore = {
        begin(protocolId: string): RequestLedgerEntry {
          // Fail-open assembly: every untrusted/injected seam (protocol id
          // input, request-id generator, clock, callback) is guarded so
          // begin() can never throw into the handler and never loses the
          // response request id — faults use safe local fallbacks and the
          // narrow seam reports them once per entry.
          const faults: unknown[] = [];
          let ledgerProtocolId = "unknown";
          try {
            ledgerProtocolId = safeName(protocolId, "protocolId");
          } catch (error) {
            faults.push(error);
          }
          let requestId: string;
          try {
            const candidate = createRequestId();
            if (
              typeof candidate !== "string" ||
              !REQUEST_ID_PATTERN.test(candidate)
            ) {
              throw new Error(
                "createRequestId must return a UUID-shaped safe ID",
              );
            }
            requestId = candidate;
          } catch (error) {
            faults.push(error);
            requestId = randomUUID();
          }
          let acceptedAt: number;
          try {
            acceptedAt = safeTime(now(), "request ledger clock");
          } catch (error) {
            faults.push(error);
            acceptedAt = Date.now();
          }
          const facts: DraftFacts = Object.freeze({
            notices: Object.freeze([]),
            attempts: Object.freeze([]),
            persistenceWarnings: 0,
          });
          const entry: LedgerDraft = {
            id: undefined,
            protocolId: ledgerProtocolId,
            requestId,
            phase: "accepted",
            outcome: "running",
            acceptedAt,
            facts,
            faultReported: false,
          };
          for (const fault of faults) countEntryFault(entry, fault);
          try {
            if (!closed) {
              database.exec("BEGIN IMMEDIATE");
              try {
                const result = insert.run(
                  entry.requestId,
                  entry.protocolId,
                  entry.phase,
                  entry.outcome,
                  entry.acceptedAt,
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  encodeFacts(entry.facts),
                  null,
                );
                entry.id = Number(result.lastInsertRowid);
                database.exec("COMMIT");
              } catch (error) {
                database.exec("ROLLBACK");
                throw error;
              }
            }
          } catch (error) {
            countEntryFault(entry, error);
          }
          if (entry.id !== undefined) {
            const record = rowToRecord({
              id: entry.id,
              requestId: entry.requestId,
              protocolId: entry.protocolId,
              phase: "accepted",
              outcome: "running",
              acceptedAt: entry.acceptedAt,
              executionStartedAt: null,
              terminalAt: null,
              completedAt: null,
              clientHttpStatus: null,
              externalAlias: null,
              providerId: null,
              realModelId: null,
              clientSessionId: null,
              effectiveSessionId: null,
              projectDir: null,
              facts: encodeFacts(entry.facts),
              terminalUsage: null,
            });
            for (const listener of eventListeners) {
              listener({ type: "request_ledger", record });
            }
          }
          return Object.freeze({
            requestId: entry.requestId,
            aliasCaptured(fact: LedgerAliasFact): void {
              try {
                if (typeof fact.externalAlias !== "string") {
                  throw new Error("aliasCaptured requires an alias string");
                }
                entry.externalAlias = safeText(
                  fact.externalAlias,
                  4_096,
                  attachedScrub,
                );
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
              persistEntry(entry);
            },
            authorized(factsInput: LedgerAuthFacts): void {
              try {
                if (typeof factsInput.effectiveSessionId !== "string") {
                  throw new Error(
                    "authorized requires the effective session identity",
                  );
                }
                entry.effectiveSessionId = safeText(
                  factsInput.effectiveSessionId,
                  128,
                  attachedScrub,
                );
                if (factsInput.clientSessionId !== undefined) {
                  entry.clientSessionId = safeText(
                    factsInput.clientSessionId,
                    128,
                    attachedScrub,
                  );
                }
                if (factsInput.projectDir !== undefined) {
                  entry.projectDir = safeText(
                    factsInput.projectDir,
                    1_024,
                    attachedScrub,
                  );
                }
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
              persistEntry(entry);
            },
            modelResolved(snapshot: LedgerModelSnapshot): void {
              try {
                entry.externalAlias = safeText(
                  snapshot.externalAlias,
                  4_096,
                  attachedScrub,
                );
                entry.providerId = safeText(
                  snapshot.providerId,
                  256,
                  attachedScrub,
                );
                entry.realModelId = safeText(
                  snapshot.realModelId,
                  256,
                  attachedScrub,
                );
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
              persistEntry(entry);
            },
            executing(): void {
              try {
                entry.phase = "execution";
                entry.executionStartedAt = safeTime(
                  now(),
                  "request ledger clock",
                );
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
              persistEntry(entry);
            },
            rendering(): void {
              entry.phase = "rendering";
              persistEntry(entry);
            },
            terminal(
              outcome: LedgerTerminalOutcome,
              terminalFacts?: LedgerTerminalFacts,
            ): void {
              try {
                assertLedgerOutcome(outcome);
                entry.outcome = outcome;
                entry.terminalAt = safeTime(now(), "request ledger clock");
                if (terminalFacts?.clientHttpStatus !== undefined) {
                  const status = safeStatus(
                    terminalFacts.clientHttpStatus,
                    "clientHttpStatus",
                  );
                  if (status !== undefined) entry.clientHttpStatus = status;
                }
                if (terminalFacts?.piStopReason !== undefined) {
                  entry.facts = Object.freeze({
                    ...entry.facts,
                    piStopReason: safeText(
                      terminalFacts.piStopReason,
                      4_096,
                      attachedScrub,
                    ),
                  });
                }
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
              persistEntry(entry);
            },
            terminalUsage(snapshot: NormalizedTerminalUsage): void {
              // The shared decoder is the one validator: an untrusted
              // snapshot is refused (fail-open, counted) and never
              // persisted, so committed bytes always re-decode.
              const decoded = decodeNormalizedTerminalUsage(snapshot);
              if (decoded === undefined) {
                countEntryFault(
                  entry,
                  new Error("terminal usage snapshot failed validation"),
                );
                return;
              }
              entry.terminalUsage = decoded;
              persistEntry(entry);
            },
            notice(notice: LedgerNotice): void {
              if (entry.facts.notices.length >= MAX_NOTICES) return;
              try {
                if (
                  (notice.direction !== "request" &&
                    notice.direction !== "response") ||
                  (notice.action !== "ignore" &&
                    notice.action !== "degrade" &&
                    notice.action !== "xrepair")
                ) {
                  throw new Error(
                    "notice.direction/action must be a bounded enum value",
                  );
                }
                const sanitizedNotice = Object.freeze({
                  adapter: safeName(notice.adapter, "notice.adapter"),
                  direction: notice.direction,
                  code: safeName(notice.code, "notice.code"),
                  ...(notice.jsonPath === undefined
                    ? {}
                    : {
                        jsonPath: safeText(
                          notice.jsonPath,
                          4_096,
                          attachedScrub,
                        ),
                      }),
                  action: notice.action,
                });
                entry.facts = Object.freeze({
                  ...entry.facts,
                  notices: Object.freeze([
                    ...entry.facts.notices,
                    sanitizedNotice,
                  ]),
                });
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
              // Notices/attempts persist with the next transition; a quiet
              // request still commits them at terminal/completed.
            },
            attempt(attempt: LedgerAttempt): void {
              if (entry.facts.attempts.length >= MAX_ATTEMPTS) return;
              try {
                if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) {
                  throw new Error("attempt.attempt must be a positive integer");
                }
                const safeAttempt = Object.freeze({
                  attempt: attempt.attempt,
                  classification: safeName(
                    attempt.classification,
                    "attempt.classification",
                  ),
                  stage: safeName(attempt.stage, "attempt.stage"),
                  ...(safeStatus(attempt.status, "attempt.status") === undefined
                    ? {}
                    : { status: attempt.status }),
                  ...(attempt.retryable === undefined
                    ? {}
                    : { retryable: attempt.retryable }),
                  ...(attempt.safeIds === undefined
                    ? {}
                    : {
                        safeIds: safeIds(attempt.safeIds)!,
                      }),
                });
                entry.facts = Object.freeze({
                  ...entry.facts,
                  attempts: Object.freeze([
                    ...entry.facts.attempts,
                    safeAttempt,
                  ]),
                });
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
            },
            fail(input: LedgerFailureInput): void {
              try {
                if (typeof input.classification !== "string") {
                  throw new Error("fail.classification must be a string");
                }
                const message =
                  input.error instanceof Error
                    ? input.error.message
                    : input.error === undefined
                      ? ""
                      : String(input.error);
                const summary: LedgerFailureSummary = {
                  classification: safeName(
                    input.classification,
                    "fail.classification",
                  ),
                  ...(input.stage === undefined
                    ? {}
                    : { stage: safeName(input.stage, "fail.stage") }),
                  messageHash: createHash("sha256")
                    .update(applyScrub(message, attachedScrub))
                    .digest("hex"),
                };
                entry.facts = Object.freeze({
                  ...entry.facts,
                  failure: Object.freeze(summary),
                });
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
            },
            completed(status: number): void {
              const clientHttpStatus = safeStatus(status, "clientHttpStatus");
              try {
                entry.phase = "terminal-preparation";
                entry.completedAt = safeTime(now(), "request ledger clock");
                if (clientHttpStatus !== undefined) {
                  entry.clientHttpStatus = clientHttpStatus;
                }
              } catch (error) {
                countEntryFault(entry, error);
                return;
              }
              persistEntry(entry);
            },
          });
        },
        query(query: RequestLedgerQuery | undefined): RequestLedgerQueryResult {
          if (closed) throw new Error("Request Ledger store is closed");
          const afterId =
            query?.afterId === undefined ||
            !Number.isSafeInteger(query.afterId) ||
            query.afterId < 1
              ? undefined
              : query.afterId;
          const limit =
            query?.limit === undefined
              ? DEFAULT_QUERY_LIMIT
              : Math.min(
                  Math.max(
                    Number.isSafeInteger(query.limit) ? query.limit : DEFAULT_QUERY_LIMIT,
                    1,
                  ),
                  MAX_QUERY_LIMIT,
                );
          const conditions: string[] = [];
          const params: Array<number | string> = [];
          if (afterId !== undefined) {
            conditions.push("id < ?");
            params.push(afterId);
          }
          if (query?.protocolId !== undefined) {
            conditions.push("protocol_id = ?");
            params.push(safeName(query.protocolId, "query.protocolId"));
          }
          if (query?.providerId !== undefined) {
            conditions.push("provider_id = ?");
            params.push(
              safeText(query.providerId, 256, attachedScrub),
            );
          }
          if (query?.realModelId !== undefined) {
            conditions.push("real_model_id = ?");
            params.push(
              safeText(query.realModelId, 256, attachedScrub),
            );
          }
          if (query?.projectDir !== undefined) {
            conditions.push("project_dir = ?");
            params.push(
              safeText(query.projectDir, 1_024, attachedScrub),
            );
          }
          if (query?.outcome !== undefined) {
            conditions.push("outcome = ?");
            params.push(assertLedgerOutcome(query.outcome));
          }
          if (query?.from !== undefined) {
            if (!Number.isSafeInteger(query.from) || query.from < 0) {
              throw new Error("query.from must be a non-negative safe integer");
            }
            conditions.push("accepted_at >= ?");
            params.push(query.from);
          }
          if (query?.to !== undefined) {
            if (!Number.isSafeInteger(query.to) || query.to < 0) {
              throw new Error("query.to must be a non-negative safe integer");
            }
            conditions.push("accepted_at <= ?");
            params.push(query.to);
          }
          if (
            query?.from !== undefined &&
            query?.to !== undefined &&
            query.from > query.to
          ) {
            throw new Error("query.from must not exceed query.to");
          }
          const where =
            conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
          const rows = database
            .prepare(`${selectBase}${where} ORDER BY id DESC LIMIT ?`)
            .all(...params, limit + 1) as unknown as Row[];
          const hasMore = rows.length > limit;
          const visible = rows.slice(0, limit);
          return Object.freeze({
            records: Object.freeze(visible.map(rowToRecord)),
            hasMore,
          });
        },
        analyze(query: AnalyticsQuery): AnalyticsQueryResult {
          if (closed) throw new Error("Request Ledger store is closed");
          // Light contract guard before the scan (the Control Plane host
          // already normalized the query; this protects direct callers).
          const range =
            query.command === "summary"
              ? { from: query.from, to: query.to }
              : {
                  from: query.from ?? 0,
                  to: query.to ?? Number.MAX_SAFE_INTEGER,
                };
          if (
            !Number.isSafeInteger(range.from) ||
            !Number.isSafeInteger(range.to)
          ) {
            throw new Error(
              "analyze range must be non-negative safe integers",
            );
          }
          const accumulator = createLedgerAnalyticsAccumulator(query);
          const conditions: string[] = [];
          const params: number[] = [];
          if (query.command === "summary") {
            conditions.push("accepted_at >= ?", "accepted_at < ?");
            params.push(query.from, query.to);
          } else {
            if (query.from !== undefined) {
              conditions.push("accepted_at >= ?");
              params.push(query.from);
            }
            if (query.to !== undefined) {
              conditions.push("accepted_at < ?");
              params.push(query.to);
            }
          }
          // Bounded keyset scan: history is streamed in fixed pages and
          // discarded; only the aggregation state is retained.
          const pageSize = 1_000;
          const conditionsWithCursor = [...conditions, "id > ?"];
          const scan = database.prepare(
            `${selectBase}${
              conditionsWithCursor.length === 0
                ? ""
                : ` WHERE ${conditionsWithCursor.join(" AND ")}`
            } ORDER BY id ASC LIMIT ?`,
          );
          let lastId = 0;
          for (;;) {
            const rows = scan.all(
              ...params,
              lastId,
              pageSize,
            ) as unknown as Row[];
            for (const row of rows) accumulator.add(rowToRecord(row));
            if (rows.length < pageSize) break;
            const last = rows[rows.length - 1];
            if (last === undefined) break;
            lastId = last.id;
          }
          return accumulator.finish();
        },
        subscribe(
          listener: (event: RequestLedgerEvent) => void,
        ): { readonly unsubscribe: () => void } {
          eventListeners.add(listener);
          return {
            unsubscribe: () => {
              eventListeners.delete(listener);
            },
          };
        },
        attachScrub(next: (value: string) => string): void {
          // Audit-surface policy (Ticket 18): pattern redaction is always
          // the baseline; the known-value scrubber is the credential-owner
          // enhancement and may be replaced on a Data Plane restart.
          attachedScrub = next;
        },
        close(): void {
          if (closed) return;
          closed = true;
          eventListeners.clear();
          try {
            // Finalize prepared statements and merge WAL frames so no
            // -wal/-shm files keep the database locked after close.
            database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } catch {
            // Best effort; the database is still closed below.
          }
          database.close();
        },
      };
      return store;
    },
  };
}

function safeIds(
  values: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (values === undefined) return undefined;
  const entries = Object.entries(values).slice(0, 32).map(([name, value]) => [
    safeName(name, "safeIds key"),
    /^[A-Za-z0-9_.:/-]{1,256}$/u.test(value)
      ? value
      : createHash("sha256").update(value).digest("hex"),
  ] as const);
  return Object.freeze(Object.fromEntries(entries));
}