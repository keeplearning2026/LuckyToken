import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  parseDiagnosticsConfiguration,
  type DiagnosticsConfiguration,
} from "./diagnostics/configuration.js";
import { assertProviderPackageSpecifier } from "./providers/package-loader.js";
import { parseAnthropicConfiguration } from "./protocols/anthropic/configuration.js";
import { parseOpenAIResponsesConfiguration } from "./protocols/openai-responses/configuration.js";
import { parseProviderNativeResponsesConfiguration } from "./provider-native-responses/configuration.js";
import { DEFAULT_MAX_REQUEST_BYTES } from "./data-plane-limits.js";
import {
  TOKEN_CONFIG_SCHEMA_VERSION,
  OwnedFileCompatibilityError,
} from "./owned-storage/compatibility.js";

export interface ClientProtocolCliConfiguration {
  readonly stateFile?: string;
  readonly adapterConfiguration?: unknown;
  readonly providerNativeConfiguration?: unknown;
}

export interface TokenCliConfig {
  readonly schemaVersion: typeof TOKEN_CONFIG_SCHEMA_VERSION;
  readonly configPath: string;
  readonly server: { readonly port: number };
  readonly clientProtocols: Readonly<
    Record<
      string,
      ClientProtocolCliConfiguration
    >
  >;
  readonly pi: {
    readonly directory: string;
    /** Canonical models.json path; defaults to `models.json` next to the
     *  config file (Token's own user data directory — the desktop
     *  layout's `~/.Token/models.json`). The Pi Agent default data
     *  directory is never read or written implicitly. */
    readonly modelsJson: string;
  };
  readonly limits: {
    readonly maxRequestBytes: number;
    readonly requestTimeoutMs: number;
  };
  readonly providerPackages: Readonly<Record<string, unknown>>;
  readonly diagnostics: DiagnosticsConfiguration;
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

export async function loadTokenCliConfig(
  inputPath: string,
): Promise<TokenCliConfig> {
  const configPath = resolve(inputPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to load Token config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  const root = requireRecord(parsed, "Token config root");
  if (root.schemaVersion !== TOKEN_CONFIG_SCHEMA_VERSION) {
    throw new OwnedFileCompatibilityError(
      Object.freeze({
        path: configPath,
        contract: "token-config",
        foundVersion:
          typeof root.schemaVersion === "string" ||
          typeof root.schemaVersion === "number"
            ? root.schemaVersion
            : "missing",
        expectedVersion: TOKEN_CONFIG_SCHEMA_VERSION,
        validationError:
          "Token config schemaVersion is incompatible with this application build.",
      }),
    );
  }
  if (Object.hasOwn(root, "providerAdapters")) {
    throw new Error(
      "providerAdapters is no longer supported; configure providerPackages",
    );
  }
  assertKeys(
    root,
    ["schemaVersion", "server", "clientProtocols", "providerPackages", "diagnostics", "pi", "limits"],
    "Token config root",
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
  assertKeys(server, ["port"], "server");
  assertKeys(pi, ["directory", "modelsJson"], "pi");
  assertKeys(limits, ["maxRequestBytes", "requestTimeoutMs"], "limits");

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
      readonly stateFile?: string;
      readonly adapterConfiguration?: unknown;
      readonly providerNativeConfiguration?: unknown;
    }
  >;
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
      ["stateFile", "conversion", "providerNative"],
      `clientProtocols.${protocolId}`,
    );
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
    const providerNativeConfiguration = protocolId === "openai-responses"
      ? parseProviderNativeResponsesConfiguration(
          protocol.providerNative,
          `clientProtocols.${protocolId}.providerNative`,
        )
      : undefined;
    if (providerNativeConfiguration === undefined && protocol.providerNative !== undefined) {
      throw new Error(`clientProtocols.${protocolId}.providerNative requires an installed lane parser`);
    }
    resolvedClientProtocols[protocolId] = Object.freeze({
      ...(stateFile === undefined ? {} : { stateFile }),
      ...(adapterConfiguration === undefined ? {} : { adapterConfiguration }),
      ...(providerNativeConfiguration === undefined
        ? {}
        : { providerNativeConfiguration }),
    });
  }
  Object.freeze(resolvedClientProtocols);
  const result: TokenCliConfig = {
    schemaVersion: TOKEN_CONFIG_SCHEMA_VERSION,
    configPath,
    server: Object.freeze({ port }),
    clientProtocols: resolvedClientProtocols,
    pi: Object.freeze({
      directory: fromConfigDirectory(piDirectoryValue, directory),
      modelsJson: fromConfigDirectory(
        modelsJsonValue ?? "models.json",
        directory,
      ),
    }),
    limits: Object.freeze({
      maxRequestBytes: safeInteger(
        limits.maxRequestBytes,
        DEFAULT_MAX_REQUEST_BYTES,
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
    diagnostics: parseDiagnosticsConfiguration(root.diagnostics, directory),
  };
  return Object.freeze(result);
}
