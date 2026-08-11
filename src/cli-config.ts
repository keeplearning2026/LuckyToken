import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface LuckyTokenCliConfig {
  readonly configPath: string;
  readonly server: { readonly host: string; readonly port: number };
  readonly client: { readonly apiKey: string; readonly projectDir?: string };
  readonly pi: { readonly directory: string };
  readonly limits: {
    readonly maxRequestBytes: number;
    readonly requestTimeoutMs: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
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
    if (!allowedSet.has(key)) throw new Error(`${description} has unknown field: ${key}`);
  }
}

function nonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  fallback: number,
  description: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${description} is out of range`);
  }
  return value as number;
}

function fromConfigDirectory(value: string, directory: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(directory, value);
}

export async function loadLuckyTokenCliConfig(
  inputPath: string,
): Promise<LuckyTokenCliConfig> {
  const configPath = resolve(inputPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to load LuckyToken config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  const root = requireRecord(parsed, "LuckyToken config root");
  assertKeys(root, ["server", "client", "pi", "limits"], "LuckyToken config root");
  const server = root.server === undefined ? {} : requireRecord(root.server, "server");
  const client = requireRecord(root.client, "client");
  const pi = requireRecord(root.pi, "pi");
  const limits = root.limits === undefined ? {} : requireRecord(root.limits, "limits");
  assertKeys(server, ["host", "port"], "server");
  assertKeys(client, ["apiKey", "projectDir"], "client");
  assertKeys(pi, ["directory"], "pi");
  assertKeys(limits, ["maxRequestBytes", "requestTimeoutMs"], "limits");

  const host = server.host === undefined
    ? "127.0.0.1"
    : nonEmptyString(server.host, "server.host");
  if (/\s|:\/\//u.test(host)) throw new Error("server.host must be a host name or address");
  const port = safeInteger(server.port, 3000, "server.port", 0, 65_535);
  const apiKey = nonEmptyString(client.apiKey, "client.apiKey");
  const piDirectoryValue = nonEmptyString(pi.directory, "pi.directory");
  const directory = dirname(configPath);
  const projectDir = client.projectDir === undefined
    ? undefined
    : fromConfigDirectory(nonEmptyString(client.projectDir, "client.projectDir"), directory);
  const result: LuckyTokenCliConfig = {
    configPath,
    server: Object.freeze({ host, port }),
    client: Object.freeze({
      apiKey,
      ...(projectDir === undefined ? {} : { projectDir }),
    }),
    pi: Object.freeze({
      directory: fromConfigDirectory(piDirectoryValue, directory),
    }),
    limits: Object.freeze({
      maxRequestBytes: safeInteger(
        limits.maxRequestBytes,
        1_048_576,
        "limits.maxRequestBytes",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      requestTimeoutMs: safeInteger(
        limits.requestTimeoutMs,
        120_000,
        "limits.requestTimeoutMs",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    }),
  };
  return Object.freeze(result);
}
