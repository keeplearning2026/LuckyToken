/** Read-only compatibility preflight for LuckyToken-owned persisted files. */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CompatibilityIssue,
  RecoveryProjection,
} from "@luckytoken/application-control-plane/control-plane";
import type { LuckyTokenCliConfig } from "../cli-config.js";
import { redactDiagnosticText } from "../runtime-diagnostics/redaction.js";

export const LUCKYTOKEN_CONFIG_SCHEMA_VERSION =
  "luckytoken-config-v1" as const;

export class OwnedFileCompatibilityError extends Error {
  constructor(readonly issue: CompatibilityIssue) {
    super(issue.validationError);
    this.name = "OwnedFileCompatibilityError";
  }
}

function safeValidationError(value: unknown): string {
  const raw = value instanceof Error ? value.message : "The file failed validation.";
  const redacted = redactDiagnosticText(raw);
  return redacted.length > 512
    ? `${redacted.slice(0, 509)}...`
    : redacted;
}

export function configCompatibilityIssue(
  path: string,
  error: unknown,
): CompatibilityIssue {
  if (error instanceof OwnedFileCompatibilityError) return error.issue;
  return Object.freeze({
    path: resolve(path),
    contract: "luckytoken-config",
    foundVersion: "invalid" as const,
    expectedVersion: LUCKYTOKEN_CONFIG_SCHEMA_VERSION,
    validationError: safeValidationError(error),
  });
}

function issue(input: CompatibilityIssue): CompatibilityIssue {
  return Object.freeze(input);
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function inspectJsonVersion(
  path: string,
  contract: string,
  field: string,
  expectedVersion: string | number,
): Promise<CompatibilityIssue | undefined> {
  if (!(await exists(path))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return issue({
      path: resolve(path),
      contract,
      foundVersion: "invalid",
      expectedVersion,
      validationError: `${contract} is not valid JSON.`,
    });
  }
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const found = record?.[field];
  if (found === expectedVersion) return undefined;
  return issue({
    path: resolve(path),
    contract,
    foundVersion:
      typeof found === "string" || typeof found === "number"
        ? found
        : "missing",
    expectedVersion,
    validationError: `${contract} version is incompatible with this LuckyToken build.`,
  });
}

async function inspectSqliteVersion(
  path: string,
  contract: string,
  schemaName: string,
  expectedVersion: number,
): Promise<CompatibilityIssue | undefined> {
  if (!(await exists(path))) return undefined;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const existing = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    if (existing.length === 0) return undefined;
    if (!existing.some((entry) => entry.name === "meta")) {
      return issue({
        path: resolve(path),
        contract,
        foundVersion: "missing",
        expectedVersion,
        validationError: `${contract} has no version metadata.`,
      });
    }
    const name = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_name'")
      .get() as { value?: unknown } | undefined;
    const version = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value?: unknown } | undefined;
    if (name?.value !== schemaName) {
      return issue({
        path: resolve(path),
        contract,
        foundVersion: "invalid",
        expectedVersion,
        validationError: `${contract} belongs to a different schema.`,
      });
    }
    if (version?.value === expectedVersion) return undefined;
    return issue({
      path: resolve(path),
      contract,
      foundVersion:
        typeof version?.value === "string" || typeof version?.value === "number"
          ? version.value
          : "missing",
      expectedVersion,
      validationError: `${contract} version is incompatible with this LuckyToken build.`,
    });
  } catch (error) {
    return issue({
      path: resolve(path),
      contract,
      foundVersion: "invalid",
      expectedVersion,
      validationError: safeValidationError(error),
    });
  } finally {
    database?.close();
  }
}

/** Inspects only explicit paths derived from the already validated
 * LuckyToken config. No file is opened writable and no external default
 * store (Pi Agent, Codex, Claude Code, CC Switch, OpenCodex) is discovered. */
export async function inspectOwnedCompatibility(
  config: LuckyTokenCliConfig,
): Promise<readonly CompatibilityIssue[]> {
  const checks: Array<Promise<CompatibilityIssue | undefined>> = [
    inspectSqliteVersion(
      join(config.runtimeDiagnostics.directory, "diagnostics.sqlite3"),
      "luckytoken-runtime-diagnostics",
      "luckytoken_runtime_diagnostics",
      1,
    ),
    inspectSqliteVersion(
      join(config.requestLedger.directory, "ledger.sqlite3"),
      "luckytoken-request-ledger",
      "luckytoken_request_ledger",
      2,
    ),
    inspectSqliteVersion(
      join(config.deepDiagnostics.directory, "capture.sqlite3"),
      "luckytoken-deep-capture",
      "luckytoken_deep_capture",
      1,
    ),
    inspectJsonVersion(
      join(config.pi.directory, "models-catalog-cache.json"),
      "luckytoken-catalog-cache",
      "schema",
      "luckytoken-catalog-cache-v1",
    ),
  ];
  for (const protocol of Object.values(config.clientProtocols)) {
    checks.push(
      inspectJsonVersion(
        protocol.authFile,
        "luckytoken-client-auth",
        "schemaVersion",
        "luckytoken-client-auth-v2",
      ),
    );
  }
  const results = await Promise.all(checks);
  return Object.freeze(
    results.filter((entry): entry is CompatibilityIssue => entry !== undefined),
  );
}

export function recoveryProjection(
  issues: readonly CompatibilityIssue[],
): RecoveryProjection {
  return Object.freeze({
    mode: "incompatible_configuration",
    issues: Object.freeze([...issues]),
  });
}
