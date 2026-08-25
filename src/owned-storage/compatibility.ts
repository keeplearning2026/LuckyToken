/** Read-only compatibility preflight for Token-owned persisted files. */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  CompatibilityIssue,
  RecoveryProjection,
} from "@token/application-control-plane/control-plane";
import type { TokenCliConfig } from "../cli-config.js";

export const TOKEN_CONFIG_SCHEMA_VERSION =
  "token-config-v2" as const;

export class OwnedFileCompatibilityError extends Error {
  constructor(readonly issue: CompatibilityIssue) {
    super(issue.validationError);
    this.name = "OwnedFileCompatibilityError";
  }
}

function safeValidationError(value: unknown): string {
  const raw = value instanceof Error ? value.message : "The file failed validation.";
  const redacted = raw
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
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
    contract: "token-config",
    foundVersion: "invalid" as const,
    expectedVersion: TOKEN_CONFIG_SCHEMA_VERSION,
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
    validationError: `${contract} version is incompatible with this Token build.`,
  });
}

/** Inspects only explicit paths derived from the already validated
 * Token config. No file is opened writable and no external default
 * store (Pi Agent, Codex, Claude Code, CC Switch, OpenCodex) is discovered. */
export async function inspectOwnedCompatibility(
  config: TokenCliConfig,
): Promise<readonly CompatibilityIssue[]> {
  const checks: Array<Promise<CompatibilityIssue | undefined>> = [
    inspectJsonVersion(
      join(config.pi.directory, "models-catalog-cache.json"),
      "Token-catalog-cache",
      "schema",
      "Token-catalog-cache-v1",
    ),
  ];
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
