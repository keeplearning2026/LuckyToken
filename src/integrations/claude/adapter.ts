import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import lockfile from "proper-lockfile";

import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentInjectionScope,
} from "../agents/contract.js";
import type {
  AgentInjectionModel,
  AgentInjectionSnapshot,
} from "../agents/snapshot.js";

const STATE_SCHEMA = "Token-claude-integration-v1" as const;
const TOKEN_CLAUDE_AUTH_TOKEN = "token-local" as const;
const MODEL_ENV_KEYS = Object.freeze([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const);
const MANAGED_ENV_KEYS = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  ...MODEL_ENV_KEYS,
] as const);

type ClaudeManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

interface ClaudeState {
  readonly schemaVersion: typeof STATE_SCHEMA;
  readonly managed: boolean;
  readonly restoreEnv: Readonly<
    Partial<Record<ClaudeManagedEnvKey, string | null>>
  >;
  readonly lastInjectedBaseUrl: string | null;
}

export interface ClaudeIntegrationAdapter extends AgentIntegrationAdapter {
  readonly id: "claude";
}

export interface ClaudeModelSelections {
  readonly main: string | null;
  readonly opus: string | null;
  readonly sonnet: string | null;
  readonly haiku: string | null;
  readonly subagent: string | null;
}

export interface CreateClaudeIntegrationAdapterOptions {
  readonly settingsPath: string;
  readonly stateDirectory: string;
  readonly selectedModels: () => ClaudeModelSelections;
  readonly isPublicModelAlias: (alias: string) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function formattingOptions(raw: string): FormattingOptions {
  const indentation = /\r?\n([ \t]+)"/u.exec(raw)?.[1] ?? "  ";
  return Object.freeze({
    insertSpaces: !indentation.startsWith("\t"),
    tabSize: indentation.startsWith("\t") ? 1 : indentation.length,
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
  });
}

function parseSettings(raw: string | undefined): {
  readonly raw: string;
  readonly root: Record<string, unknown>;
} {
  const source = raw ?? "{}\n";
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error("Claude settings.json is not valid JSONC.");
  }
  if (parsed.env !== undefined && !isRecord(parsed.env)) {
    throw new Error('Claude settings.json "env" must be an object.');
  }
  return Object.freeze({ raw: source, root: parsed });
}

function patchPath(raw: string, path: readonly string[], value: unknown): string {
  return applyEdits(
    raw,
    modify(raw, [...path], value, { formattingOptions: formattingOptions(raw) }),
  );
}

function modelValue(model: AgentInjectionModel): string {
  if (model.contextWindow < 1_000_000) return model.alias;
  return model.alias.endsWith("[1m]") ? model.alias : `${model.alias}[1m]`;
}

interface ResolvedClaudeModels {
  readonly main: AgentInjectionModel;
  readonly opus: AgentInjectionModel;
  readonly sonnet: AgentInjectionModel;
  readonly haiku: AgentInjectionModel;
  readonly subagent: AgentInjectionModel;
}

const CLAUDE_MODEL_SLOTS = Object.freeze([
  ["main", "Main"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["subagent", "Subagent"],
] as const);

function desiredEnv(
  snapshot: AgentInjectionSnapshot,
  models: ResolvedClaudeModels,
  authToken: string,
) {
  return Object.freeze({
    ANTHROPIC_BASE_URL: snapshot.endpoint.origin,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_MODEL: modelValue(models.main),
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelValue(models.opus),
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelValue(models.sonnet),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelValue(models.haiku),
    CLAUDE_CODE_SUBAGENT_MODEL: modelValue(models.subagent),
  });
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function result(
  observedState: AgentIntegrationEffect["observedState"],
  modelCount: number,
  warnings: readonly string[],
  changed: boolean,
  message?: string,
): AgentIntegrationEffect {
  return Object.freeze({
    observedState,
    modelCount,
    warnings: Object.freeze([...warnings]),
    changed,
    ...(message === undefined ? {} : { message }),
  });
}

export function createClaudeIntegrationAdapter(
  options: CreateClaudeIntegrationAdapterOptions,
): ClaudeIntegrationAdapter {
  const statePath = join(options.stateDirectory, "claude-integration.json");
  const lockTarget = join(options.stateDirectory, "claude-integration.lock");
  let operationQueue = Promise.resolve();

  const readState = async (): Promise<ClaudeState> => {
    const raw = await readOptional(statePath);
    if (raw === undefined) {
      return Object.freeze({
        schemaVersion: STATE_SCHEMA,
        managed: false,
        restoreEnv: Object.freeze({}),
        lastInjectedBaseUrl: null,
      });
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== STATE_SCHEMA ||
      typeof parsed.managed !== "boolean" ||
      !isRecord(parsed.restoreEnv) ||
      (parsed.lastInjectedBaseUrl !== null &&
        typeof parsed.lastInjectedBaseUrl !== "string")
    ) {
      throw new Error("Claude integration state is invalid.");
    }
    const restoreEnv: Partial<Record<ClaudeManagedEnvKey, string | null>> = {};
    for (const key of MANAGED_ENV_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(parsed.restoreEnv, key)) continue;
      const value = parsed.restoreEnv[key];
      if (value !== null && typeof value !== "string") {
        throw new Error("Claude integration state is invalid.");
      }
      restoreEnv[key] = value;
    }
    return Object.freeze({
      schemaVersion: STATE_SCHEMA,
      managed: parsed.managed,
      restoreEnv: Object.freeze(restoreEnv),
      lastInjectedBaseUrl: parsed.lastInjectedBaseUrl as string | null,
    });
  };

  const writeState = async (state: ClaudeState): Promise<void> => {
    await mkdir(options.stateDirectory, { recursive: true });
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(state, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(temporary, statePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };

  const withLock = async <T>(work: () => Promise<T>): Promise<T> => {
    await mkdir(options.stateDirectory, { recursive: true });
    await writeFile(lockTarget, "", { flag: "a", encoding: "utf8", mode: 0o600 });
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 250 },
      stale: 30_000,
    });
    try {
      return await work();
    } finally {
      await release().catch(() => undefined);
    }
  };

  const replaceIfUnchanged = async (
    expected: string | undefined,
    next: string,
  ): Promise<"unchanged" | "written" | "conflict"> => {
    const actualExpected = expected;
    if ((expected ?? "{}\n") === next && expected !== undefined) return "unchanged";
    await mkdir(dirname(options.settingsPath), { recursive: true });
    const temporary = `${options.settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
      if ((await readOptional(options.settingsPath)) !== actualExpected) return "conflict";
      await rename(temporary, options.settingsPath);
      return "written";
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };

  const resolveSelected = (
    snapshot: AgentInjectionSnapshot,
  ):
    | { readonly ok: true; readonly models: ResolvedClaudeModels }
    | { readonly ok: false; readonly message: string } => {
    const selections = options.selectedModels();
    const resolved: Partial<Record<keyof ResolvedClaudeModels, AgentInjectionModel>> = {};
    for (const [slot, label] of CLAUDE_MODEL_SLOTS) {
      const alias = selections[slot]?.trim();
      if (!alias) {
        return {
          ok: false,
          message: `Select a Favorite model for the Claude Code ${label} slot before enabling the integration.`,
        };
      }
      const model = snapshot.favorite.find((entry) => entry.alias === alias);
      if (model === undefined) {
        return {
          ok: false,
          message: `Claude Code ${label} model "${alias}" is not currently a Favorite model.`,
        };
      }
      if (model.contextWindow < 1_000_000 && model.alias.endsWith("[1m]")) {
        return {
          ok: false,
          message: `Claude Code ${label} model "${alias}" ends with [1m] but its context window is below 1M.`,
        };
      }
      resolved[slot] = model;
    }
    return {
      ok: true,
      models: resolved as ResolvedClaudeModels,
    };
  };

  const inject = async (
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ): Promise<AgentIntegrationEffect> => {
    void scope;
    return withLock(async () => {
      const state = await readState();
      const selected = resolveSelected(snapshot);
      if (!selected.ok) {
        return result(
          "unavailable",
          0,
          snapshot.warnings,
          false,
          selected.message,
        );
      }
      const uniqueModelCount = new Set(
        CLAUDE_MODEL_SLOTS.map(([slot]) => selected.models[slot].alias),
      ).size;

      const original = await readOptional(options.settingsPath);
      const desired = desiredEnv(
        snapshot,
        selected.models,
        TOKEN_CLAUDE_AUTH_TOKEN,
      );
      let next: string;
      const nextRestoreEnv: Partial<
        Record<ClaudeManagedEnvKey, string | null>
      > = { ...state.restoreEnv };
      try {
        const document = parseSettings(original);
        const currentEnv = isRecord(document.root.env) ? document.root.env : {};

        for (const key of MANAGED_ENV_KEYS) {
          const current = currentEnv[key];
          if (current !== undefined && typeof current !== "string") {
            throw new Error(
              `Claude settings.json env.${key} must be a string.`,
            );
          }
          const currentString = typeof current === "string" ? current : undefined;

          let isOwned = false;
          if ((MODEL_ENV_KEYS as readonly string[]).includes(key)) {
            isOwned =
              currentString !== undefined &&
              (options.isPublicModelAlias(currentString) ||
                (currentString.endsWith("[1m]") &&
                  options.isPublicModelAlias(currentString.slice(0, -4))));
          } else if (key === "ANTHROPIC_BASE_URL") {
            isOwned =
              currentString !== undefined &&
              (currentString === desired.ANTHROPIC_BASE_URL ||
                (state.managed &&
                  currentString === state.lastInjectedBaseUrl));
          } else if (key === "ANTHROPIC_AUTH_TOKEN") {
            isOwned = currentString === TOKEN_CLAUDE_AUTH_TOKEN;
          }

          if (!isOwned) {
            nextRestoreEnv[key] = currentString ?? null;
          }
        }

        next = document.raw;
        for (const key of MANAGED_ENV_KEYS) {
          next = patchPath(next, ["env", key], desired[key]);
        }
        parseSettings(next);
      } catch (error) {
        return result(
          "conflict",
          0,
          snapshot.warnings,
          false,
          error instanceof Error ? error.message : "Claude settings.json could not be patched safely.",
        );
      }

      // Persist recovery before changing Claude's file, including the first injection.
      await writeState(
        Object.freeze({
          schemaVersion: STATE_SCHEMA,
          managed: true,
          restoreEnv: Object.freeze(nextRestoreEnv),
          lastInjectedBaseUrl: desired.ANTHROPIC_BASE_URL,
        }),
      );
      let write: Awaited<ReturnType<typeof replaceIfUnchanged>>;
      try {
        write = await replaceIfUnchanged(original, next);
      } catch (error) {
        // Replacement did not commit; restore the previous ownership record.
        await writeState(state);
        throw error;
      }
      if (write === "conflict") {
        await writeState(state);
        return result(
          "conflict",
          0,
          snapshot.warnings,
          false,
          "Claude settings.json changed while Token was preparing the injection.",
        );
      }

      const verified = parseSettings(await readOptional(options.settingsPath));
      const env = isRecord(verified.root.env) ? verified.root.env : {};
      if (MANAGED_ENV_KEYS.some((key) => env[key] !== desired[key])) {
        throw new Error("Claude settings.json did not retain the Token-managed environment.");
      }

      return result(
        "managed",
        uniqueModelCount,
        snapshot.warnings,
        write === "written",
      );
    });
  };

  const restore = async (): Promise<AgentIntegrationEffect> =>
    withLock(async () => {
      const state = await readState();
      if (!state.managed) return result("native", 0, [], false);

      const original = await readOptional(options.settingsPath);
      if (original === undefined) {
        await writeState(
          Object.freeze({
            schemaVersion: STATE_SCHEMA,
            managed: false,
            restoreEnv: Object.freeze({}),
            lastInjectedBaseUrl: null,
          }),
        );
        return result("native", 0, [], false);
      }

      let next: string;
      try {
        const document = parseSettings(original);
        next = document.raw;
        for (const key of MANAGED_ENV_KEYS) {
          const hasRestore = Object.prototype.hasOwnProperty.call(
            state.restoreEnv,
            key,
          );
          const restoreValue = hasRestore ? state.restoreEnv[key] : null;
          next = patchPath(
            next,
            ["env", key],
            restoreValue === null || restoreValue === undefined
              ? undefined
              : restoreValue,
          );
        }
        parseSettings(next);
      } catch (error) {
        return result(
          "conflict",
          0,
          [],
          false,
          error instanceof Error ? error.message : "Claude settings.json could not be restored safely.",
        );
      }

      const write = await replaceIfUnchanged(original, next);
      if (write === "conflict") {
        return result(
          "conflict",
          0,
          [],
          false,
          "Claude settings.json changed while Token was preparing the restore.",
        );
      }

      const verified = parseSettings(await readOptional(options.settingsPath));
      const env = isRecord(verified.root.env) ? verified.root.env : {};
      for (const key of MANAGED_ENV_KEYS) {
        const hasRestore = Object.prototype.hasOwnProperty.call(
          state.restoreEnv,
          key,
        );
        const restoreValue = hasRestore ? state.restoreEnv[key] : null;
        if (restoreValue === null || restoreValue === undefined) {
          if (Object.prototype.hasOwnProperty.call(env, key)) {
            throw new Error(
              `Claude settings.json retained Token-managed ${key} after restore.`,
            );
          }
        } else if (env[key] !== restoreValue) {
          throw new Error(
            `Claude settings.json did not restore ${key} to its recorded value.`,
          );
        }
      }
      await writeState(
        Object.freeze({
          schemaVersion: STATE_SCHEMA,
          managed: false,
          restoreEnv: Object.freeze({}),
          lastInjectedBaseUrl: null,
        }),
      );
      return result("native", 0, [], write === "written");
    });

  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = operationQueue.then(work);
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return Object.freeze({
    id: "claude",
    projectionFingerprint: async (snapshot: AgentInjectionSnapshot) => {
      const selected = resolveSelected(snapshot);
      return canonicalHash(
        selected.ok
          ? {
              endpoint: snapshot.endpoint.origin,
              models: Object.fromEntries(
                CLAUDE_MODEL_SLOTS.map(([slot]) => [
                  slot,
                  modelValue(selected.models[slot]),
                ]),
              ),
            }
          : {
              selections: options.selectedModels(),
              unavailable: true,
            },
      );
    },
    inject: (
      snapshot: AgentInjectionSnapshot,
      scope: AgentInjectionScope,
    ) => queue(() => inject(snapshot, scope)),
    restore: () => queue(restore),
  });
}
