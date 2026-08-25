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

import { validateModelsJsonValue } from "../../providers/models-json-schema.js";
import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentInjectionScope,
} from "../agents/contract.js";
import type {
  AgentInjectionModel,
  AgentInjectionSnapshot,
} from "../agents/snapshot.js";

const PROVIDER_ID = "luckytoken" as const;
const STATE_SCHEMA = "luckytoken-pi-integration-v1" as const;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiIntegrationResult = AgentIntegrationEffect;

export interface PiIntegrationAdapter extends AgentIntegrationAdapter {
  readonly id: "pi";
}

export interface CreatePiIntegrationAdapterOptions {
  readonly agentDirectory: string;
  readonly stateDirectory: string;
}

interface PiIntegrationState {
  readonly schemaVersion: typeof STATE_SCHEMA;
  readonly providerHash: string;
}

interface ParsedDocument {
  readonly raw: string;
  readonly present: boolean;
  readonly root: Record<string, unknown>;
  readonly providers: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function hashProvider(provider: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(provider)))
    .digest("hex");
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

function parseDocument(raw: string | undefined): ParsedDocument {
  if (raw === undefined) {
    const root = { providers: {} };
    return Object.freeze({
      raw: "{\n  \"providers\": {}\n}\n",
      present: false,
      root,
      providers: root.providers,
    });
  }
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error("Pi models.json is not valid JSONC.");
  }
  const providers = parsed.providers;
  if (!isRecord(providers)) {
    throw new Error('Pi models.json must contain a "providers" object.');
  }
  return Object.freeze({ raw, present: true, root: parsed, providers });
}

function formattingOptions(raw: string): FormattingOptions {
  const indentation = /\r?\n([ \t]+)"/u.exec(raw)?.[1] ?? "  ";
  return Object.freeze({
    insertSpaces: !indentation.startsWith("\t"),
    tabSize: indentation.startsWith("\t") ? 1 : indentation.length,
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
  });
}

function thinkingLevelMap(
  model: AgentInjectionModel,
): Readonly<Record<string, string | null>> | undefined {
  if (!model.reasoning) return undefined;
  const supported = new Set(model.thinkingLevels);
  const result: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    if (!supported.has(level)) {
      result[level] = null;
    } else if (level === "xhigh" || level === "max") {
      result[level] = level;
    }
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

function projectModel(model: AgentInjectionModel): Record<string, unknown> {
  const levelMap = thinkingLevelMap(model);
  return Object.freeze({
    id: model.alias,
    name: model.alias,
    reasoning: model.reasoning,
    ...(levelMap === undefined ? {} : { thinkingLevelMap: levelMap }),
    input: Object.freeze([...model.input]),
    cost: Object.freeze({
      ...model.cost,
      ...(model.cost.tiers === undefined
        ? {}
        : {
            tiers: Object.freeze(
              model.cost.tiers.map((tier) => Object.freeze({ ...tier })),
            ),
          }),
    }),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  });
}

function buildProvider(
  snapshot: AgentInjectionSnapshot,
  scope: AgentInjectionScope,
): Record<string, unknown> {
  const selected = [...snapshot[scope]].sort((left, right) =>
    left.alias.localeCompare(right.alias),
  );
  return Object.freeze({
    name: "Token",
    baseUrl: snapshot.endpoint.origin,
    apiKey: "luckytoken-local",
    api: "anthropic-messages",
    compat: Object.freeze({
      forceAdaptiveThinking: true,
      supportsEagerToolInputStreaming: false,
      allowEmptySignature: true,
      sendSessionAffinityHeaders: true,
    }),
    models: Object.freeze(selected.map(projectModel)),
  });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readState(path: string): Promise<PiIntegrationState | undefined> {
  const raw = await readOptional(path);
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== STATE_SCHEMA ||
    typeof parsed.providerHash !== "string"
  ) {
    throw new Error("LuckyToken Pi integration state is invalid.");
  }
  return Object.freeze({
    schemaVersion: STATE_SCHEMA,
    providerHash: parsed.providerHash,
  });
}

function result(
  observedState: AgentIntegrationEffect["observedState"],
  modelCount: number,
  warnings: readonly string[],
  changed: boolean,
  message?: string,
): PiIntegrationResult {
  return Object.freeze({
    observedState,
    modelCount,
    warnings: Object.freeze([...warnings]),
    changed,
    ...(message === undefined ? {} : { message }),
  });
}

export function createPiIntegrationAdapter(
  options: CreatePiIntegrationAdapterOptions,
): PiIntegrationAdapter {
  const modelsPath = join(options.agentDirectory, "models.json");
  const statePath = join(options.stateDirectory, "pi-integration-state.json");
  const lockTarget = join(options.stateDirectory, "pi-integration.lock");
  let operationQueue = Promise.resolve();

  const inject = async (
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ): Promise<PiIntegrationResult> => {
    const models = snapshot[scope];
    if (models.length === 0) {
      const restored = await restore();
      if (restored.observedState !== "native") return restored;
      const scopeLabel = scope === "favorite" ? "Favorite" : "Full";
      return result(
        "native",
        0,
        snapshot.warnings,
        restored.changed,
        `Pi is enabled in ${scopeLabel} scope, but no model can be injected.`,
      );
    }
    const provider = buildProvider(snapshot, scope);
    await mkdir(options.agentDirectory, { recursive: true });
    await mkdir(options.stateDirectory, { recursive: true });
    await writeFile(lockTarget, "", { flag: "a", encoding: "utf8", mode: 0o600 });
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 250 },
      stale: 30_000,
    });
    try {
      const originalRaw = await readOptional(modelsPath);
      const document = parseDocument(originalRaw);
      const state = await readState(statePath);
      const current = document.providers[PROVIDER_ID];
      if (
        current !== undefined &&
        (state === undefined || hashProvider(current) !== state.providerHash)
      ) {
        return result(
          "conflict",
          0,
          snapshot.warnings,
          false,
          'Pi provider "luckytoken" exists but is not the last value injected by LuckyToken.',
        );
      }

      const providerHash = hashProvider(provider);
      if (current !== undefined && providerHash === hashProvider(current)) {
        return result("managed", models.length, snapshot.warnings, false);
      }
      const edits = modify(
        document.raw,
        ["providers", PROVIDER_ID],
        provider,
        { formattingOptions: formattingOptions(document.raw) },
      );
      const nextRaw = applyEdits(document.raw, edits);
      const nextParsed = parse(nextRaw, [], {
        allowTrailingComma: true,
        disallowComments: false,
      }) as unknown;
      const validation = validateModelsJsonValue(nextParsed);
      if (!validation.valid) {
        return result(
          "unavailable",
          0,
          snapshot.warnings,
          false,
          "The projected Pi models.json document is invalid.",
        );
      }

      const temporaryPath = `${modelsPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, nextRaw, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      try {
        if ((await readOptional(modelsPath)) !== originalRaw) {
          return result(
            "conflict",
            0,
            snapshot.warnings,
            false,
            "Pi models.json changed while LuckyToken was preparing the injection.",
          );
        }
        await atomicWrite(
          statePath,
          `${JSON.stringify({ schemaVersion: STATE_SCHEMA, providerHash }, null, 2)}\n`,
        );
        await rename(temporaryPath, modelsPath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }

      const verified = parseDocument(await readOptional(modelsPath));
      if (hashProvider(verified.providers[PROVIDER_ID]) !== providerHash) {
        throw new Error("Pi models.json did not retain the injected LuckyToken provider.");
      }
      return result("managed", models.length, snapshot.warnings, true);
    } finally {
      await release().catch(() => undefined);
    }
  };

  const queueInject = (
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ): Promise<PiIntegrationResult> => {
    const operation = operationQueue.then(() => inject(snapshot, scope));
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const restore = async (): Promise<PiIntegrationResult> => {
    await mkdir(options.stateDirectory, { recursive: true });
    await writeFile(lockTarget, "", { flag: "a", encoding: "utf8", mode: 0o600 });
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 250 },
      stale: 30_000,
    });
    try {
      const originalRaw = await readOptional(modelsPath);
      const state = await readState(statePath);
      if (originalRaw === undefined) {
        await rm(statePath, { force: true });
        return result("native", 0, [], false);
      }
      const document = parseDocument(originalRaw);
      const current = document.providers[PROVIDER_ID];
      if (current === undefined) {
        await rm(statePath, { force: true });
        return result("native", 0, [], false);
      }
      if (state === undefined || hashProvider(current) !== state.providerHash) {
        return result(
          "conflict",
          0,
          [],
          false,
          'Pi provider "luckytoken" no longer matches the last value injected by LuckyToken.',
        );
      }

      const edits = modify(
        document.raw,
        ["providers", PROVIDER_ID],
        undefined,
        { formattingOptions: formattingOptions(document.raw) },
      );
      const nextRaw = applyEdits(document.raw, edits);
      const nextParsed = parse(nextRaw, [], {
        allowTrailingComma: true,
        disallowComments: false,
      }) as unknown;
      if (!validateModelsJsonValue(nextParsed).valid) {
        return result(
          "unavailable",
          0,
          [],
          false,
          "Removing the LuckyToken provider would leave an invalid Pi models.json document.",
        );
      }

      const temporaryPath = `${modelsPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, nextRaw, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      try {
        if ((await readOptional(modelsPath)) !== originalRaw) {
          return result(
            "conflict",
            0,
            [],
            false,
            "Pi models.json changed while LuckyToken was preparing the restore.",
          );
        }
        await rename(temporaryPath, modelsPath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      await rm(statePath, { force: true });
      const verified = parseDocument(await readOptional(modelsPath));
      if (verified.providers[PROVIDER_ID] !== undefined) {
        throw new Error("Pi models.json retained the LuckyToken provider after restore.");
      }
      return result("native", 0, [], true);
    } finally {
      await release().catch(() => undefined);
    }
  };

  const queueRestore = (): Promise<PiIntegrationResult> => {
    const operation = operationQueue.then(restore);
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return Object.freeze({
    id: "pi",
    projectionFingerprint: async (
      snapshot: AgentInjectionSnapshot,
      scope: AgentInjectionScope,
    ) => {
      if (snapshot[scope].length === 0) {
        return hashProvider({ providerId: PROVIDER_ID, models: [] });
      }
      return hashProvider(buildProvider(snapshot, scope));
    },
    inject: queueInject,
    restore: queueRestore,
  });
}
