/**
 * Config-value resolution: literal values, `$VAR`/`${VAR}` environment
 * references (with `$$`/`$!` escapes) and `!command` shell commands.
 *
 * Mirrors the pinned Pi implementation
 * (`pi-agent/packages/coding-agent/src/core/resolve-config-value.ts` in
 * `@earendil-works/pi-coding-agent` 0.84.1) with two deliberate local
 * adaptations:
 *
 * - resolution is always UNCACHED: the pinned request path resolves API keys
 *   and headers through `resolveConfigValueUncached`, so every request
 *   re-reads environment and re-runs commands. This module has no cache;
 * - failure messages are bounded and secret-free: the pinned wording echoes
 *   environment-variable names and command text, which Ticket 10 forbids on
 *   any surface. The message keeps only the structural description.
 *
 * Env lookup and command execution are injected adapters: production uses
 * `process.env` and a bounded real shell; tests inject deterministic stubs
 * and never execute arbitrary real credential commands.
 */

import { execSync } from "node:child_process";

/** Deterministic environment lookup. Defaults to `process.env`. */
export type EnvSource = (name: string) => string | undefined;

/** Deterministic command execution; returns trimmed stdout or undefined. */
export type CommandRunner = (command: string) => string | undefined;

export interface ConfigValueAdapters {
  readonly envSource?: EnvSource;
  readonly commandRunner?: CommandRunner;
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/u;
const COMMAND_TIMEOUT_MS = 10_000;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference =
  | { type: "command"; config: string }
  | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previousPart = parts[parts.length - 1];
  if (previousPart?.type === "literal") {
    previousPart.value += value;
    return;
  }
  parts.push({ type: "literal", value });
}

/** Pinned `parseConfigValueTemplate` (resolve-config-value.ts). */
function parseConfigValueTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;

  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }

    appendLiteral(parts, config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];

    if (nextChar === "$" || nextChar === "!") {
      appendLiteral(parts, nextChar);
      index = dollarIndex + 2;
      continue;
    }

    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, "$");
        index = dollarIndex + 1;
        continue;
      }

      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) {
        parts.push({ type: "env", name });
      } else {
        appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      }
      index = endIndex + 1;
      continue;
    }

    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }

    appendLiteral(parts, "$");
    index = dollarIndex + 1;
  }

  return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
  if (config.startsWith("!")) {
    return { type: "command", config };
  }
  return { type: "template", parts: parseConfigValueTemplate(config) };
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
  const names: string[] = [];
  for (const part of parts) {
    if (part.type !== "env" || names.includes(part.name)) continue;
    names.push(part.name);
  }
  return names;
}

/** Pinned `resolveEnvConfigValue`: explicit env first, then the source. */
function resolveEnvConfigValue(
  name: string,
  env: Readonly<Record<string, string>> | undefined,
  envSource: EnvSource,
): string | undefined {
  return env?.[name] || envSource(name) || undefined;
}

function resolveTemplate(
  parts: TemplatePart[],
  env: Readonly<Record<string, string>> | undefined,
  envSource: EnvSource,
): string | undefined {
  let resolved = "";
  for (const part of parts) {
    if (part.type === "literal") {
      resolved += part.value;
      continue;
    }
    const envValue = resolveEnvConfigValue(part.name, env, envSource);
    if (envValue === undefined) return undefined;
    resolved += envValue;
  }
  return resolved;
}

/** Bounded real-shell command runner (never used by the test suite). */
function defaultCommandRunner(command: string): string | undefined {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultEnvSource(name: string): string | undefined {
  return process.env[name];
}

export interface ConfigValueResolver {
  /** The env var names a template references (empty for commands/literals). */
  getEnvVarNames(config: string): readonly string[];
  /** Whether the value is a `!command`. */
  isCommandConfigValue(config: string): boolean;
  /** Whether every referenced env var currently resolves. */
  isConfigValueConfigured(
    config: string,
    env?: Readonly<Record<string, string>>,
  ): boolean;
  /**
   * Resolve one config value, uncached, per request. Throws a bounded
   * secret-free error when the value cannot be resolved (missing env var,
   * failed/empty command, unresolvable literal).
   */
  resolveValueOrThrow(
    config: string,
    description: string,
    env?: Readonly<Record<string, string>>,
  ): string;
  /** Resolve every header value with the same rules; undefined when absent. */
  resolveHeadersOrThrow(
    headers: Readonly<Record<string, string>> | undefined,
    description: string,
    env?: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> | undefined;
}

/** Create the per-request config value resolver with deterministic adapters. */
export function createConfigValueResolver(
  adapters: ConfigValueAdapters = {},
): ConfigValueResolver {
  const envSource = adapters.envSource ?? defaultEnvSource;
  const commandRunner = adapters.commandRunner ?? defaultCommandRunner;

  const resolveUncached = (
    config: string,
    env: Readonly<Record<string, string>> | undefined,
  ): string | undefined => {
    const reference = parseConfigValueReference(config);
    if (reference.type === "command") {
      return commandRunner(reference.config.slice(1));
    }
    return resolveTemplate(reference.parts, env, envSource);
  };

  return Object.freeze({
    getEnvVarNames(config: string): readonly string[] {
      const reference = parseConfigValueReference(config);
      return reference.type === "template"
        ? Object.freeze(getTemplateEnvVarNames(reference.parts))
        : Object.freeze([]);
    },
    isCommandConfigValue(config: string): boolean {
      return parseConfigValueReference(config).type === "command";
    },
    isConfigValueConfigured(
      config: string,
      env?: Readonly<Record<string, string>>,
    ): boolean {
      return this.getEnvVarNames(config).every(
        (name) => resolveEnvConfigValue(name, env, envSource) !== undefined,
      );
    },
    resolveValueOrThrow(
      config: string,
      description: string,
      env?: Readonly<Record<string, string>>,
    ): string {
      const resolvedValue = resolveUncached(config, env);
      if (resolvedValue !== undefined) {
        return resolvedValue;
      }
      const reference = parseConfigValueReference(config);
      // Bounded secret-free failure: never echo env var names or command
      // text (they may reference or contain credentials).
      if (reference.type === "command") {
        throw new Error(
          `Failed to resolve ${description} from shell command`,
        );
      }
      throw new Error(`Failed to resolve ${description}`);
    },
    resolveHeadersOrThrow(
      headers: Readonly<Record<string, string>> | undefined,
      description: string,
      env?: Readonly<Record<string, string>>,
    ): Readonly<Record<string, string>> | undefined {
      if (headers === undefined) return undefined;
      const resolved: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        resolved[key] = this.resolveValueOrThrow(
          value,
          `${description} header "${key}"`,
          env,
        );
      }
      // Pinned resolveHeadersOrThrow: an empty resolved set is undefined.
      return Object.keys(resolved).length > 0 ? Object.freeze(resolved) : undefined;
    },
  });
}
