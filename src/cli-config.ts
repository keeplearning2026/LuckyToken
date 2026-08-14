import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { parseFailureLoggingConfiguration, type FailureLoggingConfiguration } from "./invocation-diagnostics/configuration.js";
import { assertProviderPackageSpecifier } from "./providers/package-loader.js";
import { parseAnthropicConfiguration } from "./protocols/anthropic/configuration.js";
import { parseOpenAIResponsesConfiguration } from "./protocols/openai-responses/configuration.js";

export interface ClientProtocolCliConfiguration {
  readonly authFile: string;
  readonly stateFile?: string;
  readonly adapterConfiguration?: unknown;
}

export interface LuckyTokenCliConfig {
  readonly configPath: string;
  readonly server: { readonly host: string; readonly port: number };
  readonly clientProtocols: Readonly<
    Record<
      string,
      ClientProtocolCliConfiguration
    >
  >;
  readonly pi: {
    readonly directory: string;
    /** Optional models.json path; defaults to `<pi.directory>/models.json`. */
    readonly modelsJson?: string;
  };
  readonly limits: {
    readonly maxRequestBytes: number;
    readonly requestTimeoutMs: number;
  };
  readonly providerPackages: Readonly<Record<string, unknown>>;
  readonly failureLogging: FailureLoggingConfiguration;
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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function existingFileIdentity(path: string): Promise<string | undefined> {
  try {
    const file = await stat(path, { bigint: true });
    return `${file.dev}:${file.ino}`;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
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
  if (Object.hasOwn(root, "providerAdapters")) {
    throw new Error(
      "providerAdapters is no longer supported; configure providerPackages",
    );
  }
  assertKeys(
    root,
    ["server", "clientProtocols", "providerPackages", "failureLogging", "pi", "limits"],
    "LuckyToken config root",
  );
  const server = root.server === undefined ? {} : requireRecord(root.server, "server");
  const clientProtocols = requireRecord(root.clientProtocols, "clientProtocols");
  const pi = requireRecord(root.pi, "pi");
  const limits = root.limits === undefined ? {} : requireRecord(root.limits, "limits");
  const providerPackages = root.providerPackages === undefined
    ? {}
    : requireRecord(root.providerPackages, "providerPackages");
  const resolvedProviderPackages = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [specifier, configuration] of Object.entries(providerPackages)) {
    assertProviderPackageSpecifier(specifier);
    resolvedProviderPackages[specifier] = configuration;
  }
  Object.freeze(resolvedProviderPackages);
  assertKeys(server, ["host", "port"], "server");
  assertKeys(pi, ["directory", "modelsJson"], "pi");
  assertKeys(limits, ["maxRequestBytes", "requestTimeoutMs"], "limits");

  const host = server.host === undefined
    ? "127.0.0.1"
    : nonEmptyString(server.host, "server.host");
  if (/\s|:\/\//u.test(host)) throw new Error("server.host must be a host name or address");
  const port = safeInteger(server.port, 3000, "server.port", 0, 65_535);
  const piDirectoryValue = nonEmptyString(pi.directory, "pi.directory");
  const modelsJsonValue =
    pi.modelsJson === undefined
      ? undefined
      : nonEmptyString(pi.modelsJson, "pi.modelsJson");
  const directory = dirname(configPath);
  if (Object.keys(clientProtocols).length === 0) {
    throw new Error("clientProtocols must configure at least one Client Protocol");
  }
  const resolvedClientProtocols = Object.create(null) as Record<
    string,
    {
      readonly authFile: string;
      readonly stateFile?: string;
      readonly adapterConfiguration?: unknown;
    }
  >;
  const authFiles = new Set<string>();
  const physicalAuthFiles = new Set<string>();
  for (const [protocolId, rawProtocol] of Object.entries(clientProtocols)) {
    nonEmptyString(protocolId, "Client Protocol id");
    if (/\s/u.test(protocolId)) {
      throw new Error("Client Protocol id must contain no whitespace");
    }
    const protocol = requireRecord(
      rawProtocol,
      `clientProtocols.${protocolId}`,
    );
    assertKeys(
      protocol,
      ["authFile", "stateFile", "conversion"],
      `clientProtocols.${protocolId}`,
    );
    const authFile = fromConfigDirectory(
      nonEmptyString(
        protocol.authFile,
        `clientProtocols.${protocolId}.authFile`,
      ),
      directory,
    );
    const identity = process.platform === "win32" ? authFile.toLowerCase() : authFile;
    if (authFiles.has(identity)) {
      throw new Error("Client Protocol auth files must be unique");
    }
    const physicalIdentity = await existingFileIdentity(authFile);
    if (
      physicalIdentity !== undefined &&
      physicalAuthFiles.has(physicalIdentity)
    ) {
      throw new Error("Client Protocol auth files must be unique");
    }
    authFiles.add(identity);
    if (physicalIdentity !== undefined) physicalAuthFiles.add(physicalIdentity);
    const stateFile =
      protocol.stateFile === undefined
        ? undefined
        : fromConfigDirectory(
            nonEmptyString(
              protocol.stateFile,
              `clientProtocols.${protocolId}.stateFile`,
            ),
            directory,
          );
    const adapterConfiguration = protocolId === "anthropic-messages"
      ? parseAnthropicConfiguration(
          protocol.conversion === undefined ? {} : { conversion: protocol.conversion },
          `clientProtocols.${protocolId}`,
        )
      : protocolId === "openai-responses"
        ? parseOpenAIResponsesConfiguration(
            protocol.conversion === undefined ? {} : { conversion: protocol.conversion },
            `clientProtocols.${protocolId}`,
          )
        : undefined;
    if (adapterConfiguration === undefined && protocol.conversion !== undefined) {
      throw new Error(`clientProtocols.${protocolId}.conversion requires an installed adapter parser`);
    }
    resolvedClientProtocols[protocolId] = Object.freeze({
      authFile,
      ...(stateFile === undefined ? {} : { stateFile }),
      ...(adapterConfiguration === undefined ? {} : { adapterConfiguration }),
    });
  }
  Object.freeze(resolvedClientProtocols);
  const result: LuckyTokenCliConfig = {
    configPath,
    server: Object.freeze({ host, port }),
    clientProtocols: resolvedClientProtocols,
    pi: Object.freeze({
      directory: fromConfigDirectory(piDirectoryValue, directory),
      ...(modelsJsonValue === undefined
        ? {}
        : { modelsJson: fromConfigDirectory(modelsJsonValue, directory) }),
    }),
    limits: Object.freeze({
      maxRequestBytes: safeInteger(
        limits.maxRequestBytes,
        32 * 1024 * 1024,
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
    providerPackages: resolvedProviderPackages,
    failureLogging: parseFailureLoggingConfiguration(root.failureLogging, directory),
  };
  return Object.freeze(result);
}
