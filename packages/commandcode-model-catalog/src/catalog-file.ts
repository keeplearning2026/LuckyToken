import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  freezeCommandCodeModelFacts,
  isCommandCodeReasoningEffort,
  type CommandCodeModelFacts,
  type CommandCodePlan,
  type CommandCodeReasoningEffort,
  type CommandCodeSupportedEndpoint,
  type CommandCodeThinkingLevelMap,
} from "./models.js";

export const COMMANDCODE_MODEL_CATALOG_SCHEMA =
  "luckytoken-commandcode-models-v1" as const;

export interface CommandCodeModelCatalog {
  readonly schema: typeof COMMANDCODE_MODEL_CATALOG_SCHEMA;
  readonly models: readonly CommandCodeModelFacts[];
}

export type CommandCodeModelCatalogLoadSource =
  | "file"
  | "seeded_default"
  | "fallback_default";

export interface CommandCodeModelCatalogLoadResult {
  readonly catalog: CommandCodeModelCatalog;
  readonly source: CommandCodeModelCatalogLoadSource;
  readonly error?: Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${description} must be an object`);
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  description: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${description} has unknown field: ${key}`);
    }
  }
}

function nonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${description} must be a positive safe integer`);
  }
  return value as number;
}

function parsePlan(value: unknown, description: string): CommandCodePlan {
  if (
    value !== "go" &&
    value !== "goat" &&
    value !== "pro" &&
    value !== "max"
  ) {
    throw new Error(`${description} must be go, goat, pro, or max`);
  }
  return value;
}

function parseInput(
  value: unknown,
  description: string,
): readonly ("text" | "image")[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${description} must be a non-empty array`);
  }
  const input = value.map((entry) => {
    if (entry !== "text" && entry !== "image") {
      throw new Error(`${description} contains an unsupported modality`);
    }
    return entry;
  });
  if (new Set(input).size !== input.length) {
    throw new Error(`${description} must contain unique modalities`);
  }
  return input;
}

function parseSupportedEndpoints(
  value: unknown,
  description: string,
): readonly CommandCodeSupportedEndpoint[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${description} must be a non-empty array`);
  }
  const endpoints = value.map((entry) => {
    if (
      entry !== "/messages" &&
      entry !== "/chat/completions" &&
      entry !== "/responses"
    ) {
      throw new Error(`${description} contains an unsupported endpoint`);
    }
    return entry;
  });
  if (new Set(endpoints).size !== endpoints.length) {
    throw new Error(`${description} must contain unique endpoints`);
  }
  if (endpoints.includes("/messages") && endpoints.length !== 1) {
    throw new Error(
      `${description} cannot combine /messages with another endpoint`,
    );
  }
  return endpoints;
}

const THINKING_LEVEL_KEYS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);

function parseThinkingLevelMap(
  value: unknown,
  description: string,
): CommandCodeThinkingLevelMap {
  const record = requireRecord(value, description);
  assertKeys(record, THINKING_LEVEL_KEYS, description);
  if (Object.keys(record).length !== THINKING_LEVEL_KEYS.length) {
    throw new Error(`${description} must declare every thinking level`);
  }
  const parsed: Record<
    (typeof THINKING_LEVEL_KEYS)[number],
    CommandCodeReasoningEffort | null
  > = {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    };
  for (const key of THINKING_LEVEL_KEYS) {
    const mapped = record[key];
    if (
      mapped !== null &&
      !isCommandCodeReasoningEffort(mapped)
    ) {
      throw new Error(
        `${description}.${key} must be null or a supported reasoning effort`,
      );
    }
    if (key === "off" && mapped !== null) {
      throw new Error(`${description}.off must be null`);
    }
    parsed[key] = mapped;
  }
  return Object.freeze(parsed);
}

function parseModel(value: unknown, index: number): CommandCodeModelFacts {
  const description = `CommandCode catalog models[${index}]`;
  const record = requireRecord(value, description);
  assertKeys(
    record,
    [
      "id",
      "name",
      "description",
      "supportedEndpoints",
      "input",
      "reasoning",
      "thinkingLevelMap",
      "contextWindow",
      "maxOutputTokens",
      "minimumPlan",
    ],
    description,
  );
  if (typeof record.reasoning !== "boolean") {
    throw new Error(`${description}.reasoning must be a boolean`);
  }

  const thinkingLevelMap =
    record.thinkingLevelMap === undefined
      ? undefined
      : parseThinkingLevelMap(
          record.thinkingLevelMap,
          `${description}.thinkingLevelMap`,
        );
  if (record.reasoning && thinkingLevelMap === undefined) {
    throw new Error(
      `${description}.thinkingLevelMap is required when reasoning is true`,
    );
  }
  if (!record.reasoning && thinkingLevelMap !== undefined) {
    throw new Error(
      `${description}.thinkingLevelMap is not allowed when reasoning is false`,
    );
  }

  return {
    id: nonEmptyString(record.id, `${description}.id`),
    name: nonEmptyString(record.name, `${description}.name`),
    description: nonEmptyString(
      record.description,
      `${description}.description`,
    ),
    supportedEndpoints: parseSupportedEndpoints(
      record.supportedEndpoints,
      `${description}.supportedEndpoints`,
    ),
    input: parseInput(record.input, `${description}.input`),
    reasoning: record.reasoning,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    contextWindow: positiveSafeInteger(
      record.contextWindow,
      `${description}.contextWindow`,
    ),
    ...(record.maxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: positiveSafeInteger(
            record.maxOutputTokens,
            `${description}.maxOutputTokens`,
          ),
        }),
    minimumPlan: parsePlan(
      record.minimumPlan,
      `${description}.minimumPlan`,
    ),
  };
}

export function parseCommandCodeModelCatalog(
  value: unknown,
  path = "commandcode-models.json",
): CommandCodeModelCatalog {
  const root = requireRecord(value, `CommandCode catalog ${path}`);
  assertKeys(root, ["schema", "models"], `CommandCode catalog ${path}`);
  if (root.schema !== COMMANDCODE_MODEL_CATALOG_SCHEMA) {
    throw new Error(
      `CommandCode catalog ${path} schema must be ${COMMANDCODE_MODEL_CATALOG_SCHEMA}`,
    );
  }
  if (!Array.isArray(root.models) || root.models.length === 0) {
    throw new Error(`CommandCode catalog ${path}.models must be non-empty`);
  }
  const models = freezeCommandCodeModelFacts(root.models.map(parseModel));
  return Object.freeze({
    schema: COMMANDCODE_MODEL_CATALOG_SCHEMA,
    models,
  });
}

export function parseCommandCodeModelCatalogText(
  text: string,
  path = "commandcode-models.json",
): CommandCodeModelCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Failed to parse CommandCode catalog at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  return parseCommandCodeModelCatalog(parsed, path);
}

const BUNDLED_COMMANDCODE_MODEL_CATALOG_PATH = fileURLToPath(
  new URL("../commandcode-models.json", import.meta.url),
);
const BUNDLED_COMMANDCODE_MODEL_CATALOG_TEXT = readFileSync(
  BUNDLED_COMMANDCODE_MODEL_CATALOG_PATH,
  "utf8",
);

/**
 * Product-default CommandCode catalog. The tracked JSON file is the only
 * bundled model-data authority; this object is only its validated frozen view.
 */
export const DEFAULT_COMMANDCODE_MODEL_CATALOG: CommandCodeModelCatalog =
  parseCommandCodeModelCatalogText(
    BUNDLED_COMMANDCODE_MODEL_CATALOG_TEXT,
    BUNDLED_COMMANDCODE_MODEL_CATALOG_PATH,
  );

/** Compatibility projection for existing tools/tests; data still comes from the JSON authority. */
export const COMMANDCODE_MODEL_FACTS: readonly CommandCodeModelFacts[] =
  DEFAULT_COMMANDCODE_MODEL_CATALOG.models;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMissingFile(error: unknown): boolean {
  return (
    isRecord(error) &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function defaultCatalogText(): string {
  return BUNDLED_COMMANDCODE_MODEL_CATALOG_TEXT;
}

export async function loadCommandCodeModelCatalog(
  path: string,
): Promise<CommandCodeModelCatalogLoadResult> {
  try {
    const content = await readFile(path, "utf8");
    return Object.freeze({
      catalog: parseCommandCodeModelCatalogText(content, path),
      source: "file" as const,
    });
  } catch (error) {
    if (!isMissingFile(error)) {
      return Object.freeze({
        catalog: DEFAULT_COMMANDCODE_MODEL_CATALOG,
        source: "fallback_default" as const,
        error: asError(error),
      });
    }
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, defaultCatalogText(), {
      encoding: "utf8",
      flag: "wx",
    });
    return Object.freeze({
      catalog: DEFAULT_COMMANDCODE_MODEL_CATALOG,
      source: "seeded_default" as const,
    });
  } catch (error) {
    if (
      isRecord(error) &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "EEXIST"
    ) {
      try {
        const content = await readFile(path, "utf8");
        return Object.freeze({
          catalog: parseCommandCodeModelCatalogText(content, path),
          source: "file" as const,
        });
      } catch (readError) {
        return Object.freeze({
          catalog: DEFAULT_COMMANDCODE_MODEL_CATALOG,
          source: "fallback_default" as const,
          error: asError(readError),
        });
      }
    }
    return Object.freeze({
      catalog: DEFAULT_COMMANDCODE_MODEL_CATALOG,
      source: "fallback_default" as const,
      error: asError(error),
    });
  }
}
