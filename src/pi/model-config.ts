/**
 * Minimal Node-side extraction of Pi Coding Agent's immutable models.json
 * snapshot grammar. It intentionally excludes credential templates,
 * Agent/TUI/session state, and shell-command execution.
 *
 * Upstream reference:
 * pi-agent/packages/coding-agent/src/core/model-config.ts
 * pi-agent/packages/coding-agent/src/utils/json.ts
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface PiModelDefinition extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly name?: string;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly cost?: Readonly<Record<string, unknown>>;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface PiProviderConfig extends Readonly<Record<string, unknown>> {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly api?: string;
  readonly models?: readonly PiModelDefinition[];
}

export interface PiModelsConfig {
  readonly path: string;
  getProvider(providerId: string): PiProviderConfig | undefined;
  getProviderIds(): readonly string[];
}

const ROOT_KEYS = new Set(["providers"]);
const PROVIDER_KEYS = new Set([
  "name",
  "baseUrl",
  "api",
  "models",
]);
const MODEL_KEYS = new Set([
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  description: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${description} has unknown field: ${key}`);
  }
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  description: string,
): void {
  const field = value[key];
  if (field !== undefined && (typeof field !== "string" || field.length === 0)) {
    throw new Error(`${description}.${key} must be a non-empty string`);
  }
}

function validateModel(value: unknown, description: string): void {
  if (!isRecord(value)) throw new Error(`${description} must be an object`);
  assertAllowedKeys(value, MODEL_KEYS, description);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`${description}.id must be a non-empty string`);
  }
  for (const key of ["name", "api", "baseUrl"] as const) {
    optionalString(value, key, description);
  }
  if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") {
    throw new Error(`${description}.reasoning must be a boolean`);
  }
  if (
    value.input !== undefined &&
    (!Array.isArray(value.input) ||
      value.input.some((entry) => entry !== "text" && entry !== "image"))
  ) {
    throw new Error(`${description}.input must contain only text/image`);
  }
  for (const key of ["contextWindow", "maxTokens"] as const) {
    const field = value[key];
    if (
      field !== undefined &&
      (!Number.isSafeInteger(field) || (field as number) <= 0)
    ) {
      throw new Error(`${description}.${key} must be a positive safe integer`);
    }
  }
  if (value.cost !== undefined && !isRecord(value.cost)) {
    throw new Error(`${description}.cost must be an object`);
  }
}

function validateProvider(value: unknown, providerId: string): void {
  const description = `models.json provider ${providerId}`;
  if (!isRecord(value)) throw new Error(`${description} must be an object`);
  assertAllowedKeys(value, PROVIDER_KEYS, description);
  for (const key of ["name", "baseUrl", "api"] as const) {
    optionalString(value, key, description);
  }
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) throw new Error(`${description}.models must be an array`);
    value.models.forEach((model, index) =>
      validateModel(model, `${description}.models[${index}]`),
    );
  }
}

function stripPiJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/gu, (match) =>
      match[0] === '"' ? match : "",
    )
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/gu, (match, tail: string | undefined) =>
      tail ?? (match[0] === '"' ? match : ""),
    );
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export async function loadPiModelsConfig(inputPath: string): Promise<PiModelsConfig> {
  const path = resolve(inputPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripPiJsonComments(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Failed to load Pi models.json at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  if (!isRecord(parsed)) throw new Error("Pi models.json root must be an object");
  assertAllowedKeys(parsed, ROOT_KEYS, "Pi models.json root");
  if (!isRecord(parsed.providers)) {
    throw new Error("Pi models.json providers must be an object");
  }
  for (const [providerId, provider] of Object.entries(parsed.providers)) {
    if (providerId.length === 0) throw new Error("Pi provider id must be non-empty");
    validateProvider(provider, providerId);
  }
  const providers = deepFreeze(
    structuredClone(parsed.providers) as Record<string, PiProviderConfig>,
  );
  return Object.freeze({
    path,
    getProvider: (providerId: string) => providers[providerId],
    getProviderIds: () => Object.freeze(Object.keys(providers)),
  });
}
