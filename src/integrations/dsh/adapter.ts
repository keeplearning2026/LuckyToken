import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import lockfile from "proper-lockfile";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";

import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentInjectionScope,
} from "../agents/contract.js";
import type { AgentInjectionSnapshot } from "../agents/snapshot.js";

const PROVIDER_ID = "Token";
const MANAGED_COMMENT = " Token managed";
const ROW_COMMENT = " Token managed row";
const ENV_MARKER = "# Token managed";
const ENV_KEY = "TOKEN_API_KEY";
const LOCAL_KEY = "token-local";

export interface CreateDshIntegrationAdapterOptions {
  readonly dshHome: string;
  readonly profile: string;
  readonly stateDirectory: string;
}

export interface DshIntegrationAdapter extends AgentIntegrationAdapter {
  readonly id: "dsh";
}

function effect(
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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceIfUnchanged(
  path: string,
  original: string | undefined,
  next: string,
): Promise<boolean> {
  if (original === next) return false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    if ((await readOptional(path)) !== original) {
      throw new Error(`${path} changed while Token was preparing the update.`);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return true;
}

function parsePatch(raw: string | undefined): { doc: Document; rows: YAMLSeq } {
  const doc = parseDocument(raw?.trim() ? raw : "[]\n", { uniqueKeys: true, keepSourceTokens: true });
  if (doc.errors.length > 0 || !isSeq(doc.contents)) {
    throw new Error("DSH cordis.patch.yml must be a valid YAML list.");
  }
  return { doc, rows: doc.contents };
}

function targetRow(rows: YAMLSeq): YAMLMap | undefined {
  const matches = rows.items.filter((row) => isMap(row) && row.get("id") === "llm-pi-ai");
  if (matches.length > 1) throw new Error("DSH patch has multiple llm-pi-ai entries.");
  return matches[0] as YAMLMap | undefined;
}

function ownedRow(row: YAMLMap): boolean {
  const id = row.items.find((item) => item.key === "id" ||
    (isScalar(item.key) && item.key.value === "id"));
  return id !== undefined && isScalar(id.key) && id.key.commentBefore?.trim() === ROW_COMMENT.trim();
}

function providerMap(row: YAMLMap): YAMLMap | undefined {
  const config = row.get("config", true);
  if (config === undefined) return undefined;
  if (!isMap(config)) throw new Error("DSH llm-pi-ai config must be a YAML map.");
  const providers = config.get("providers", true);
  if (providers === undefined) return undefined;
  if (!isMap(providers)) throw new Error("DSH llm-pi-ai providers must be a YAML map.");
  return providers;
}

function desiredProvider(snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope) {
  return {
    displayName: "Token",
    apiKeyEnv: ENV_KEY,
    api: "openai-responses",
    baseURL: snapshot.endpoint.openaiBaseUrl,
    models: [...snapshot[scope]].sort((a, b) => a.alias.localeCompare(b.alias)).map((model) => ({
      id: model.alias,
      name: model.alias,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
    })),
  };
}

function patchEnv(raw: string | undefined, insert: boolean): string | undefined {
  const source = raw ?? "";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/u);
  const indices = lines.flatMap((line, index) => /^\s*TOKEN_API_KEY\s*=/u.test(line) ? [index] : []);
  if (indices.length > 1) throw new Error("DSH .env defines TOKEN_API_KEY more than once.");
  const keyIndex = indices[0] ?? -1;
  if (insert) {
    if (keyIndex >= 0 && lines[keyIndex - 1] === ENV_MARKER && lines[keyIndex] === `${ENV_KEY}=${LOCAL_KEY}`) {
      return source;
    }
  } else if (keyIndex < 0) {
    return undefined;
  }
  if (keyIndex >= 0) {
    lines.splice(keyIndex, 1);
    if (lines[keyIndex - 1] === ENV_MARKER) lines.splice(keyIndex - 1, 1);
  }
  const remaining = keyIndex < 0 ? source : lines.join(eol);
  if (!insert) return remaining;
  return `${remaining}${remaining.length > 0 && !remaining.endsWith("\n") ? eol : ""}${ENV_MARKER}${eol}${ENV_KEY}=${LOCAL_KEY}${eol}`;
}

export function createDshIntegrationAdapter(options: CreateDshIntegrationAdapterOptions): DshIntegrationAdapter {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(options.profile)) {
    throw new Error("DSH profile name is invalid.");
  }
  const patchPath = join(options.dshHome, "profiles", options.profile, "cordis.patch.yml");
  const envPath = join(options.dshHome, ".env");
  const lockTarget = join(options.stateDirectory, "dsh-integration.lock");
  let operationQueue = Promise.resolve();

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

  const restoreLocked = async (): Promise<AgentIntegrationEffect> => {
    const originalPatch = await readOptional(patchPath);
    const { doc, rows } = parsePatch(originalPatch);
    const row = targetRow(rows);
    const providers = row === undefined ? undefined : providerMap(row);
    let patchChanged = false;
    if (providers?.has(PROVIDER_ID)) {
      providers.delete(PROVIDER_ID);
      patchChanged = true;
      const config = row!.get("config", true);
      if (!isMap(config)) throw new Error("DSH llm-pi-ai config must be a YAML map.");
      if (providers.items.length === 0) config.delete("providers");
      if (config.items.length === 0 && ownedRow(row!)) rows.items.splice(rows.items.indexOf(row!), 1);
    }
    const originalEnv = await readOptional(envPath);
    let nextEnv: string | undefined;
    try {
      nextEnv = patchEnv(originalEnv, false);
    } catch (error) {
      return effect("conflict", 0, [], false, error instanceof Error ? error.message : String(error));
    }
    if (patchChanged) await replaceIfUnchanged(patchPath, originalPatch, doc.toString({ lineWidth: 0 }));
    const envChanged = nextEnv !== undefined && await replaceIfUnchanged(envPath, originalEnv, nextEnv);
    return effect("native", 0, [], patchChanged || envChanged);
  };

  const injectLocked = async (
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ): Promise<AgentIntegrationEffect> => {
    try {
      if (!(await stat(dirname(patchPath))).isDirectory()) {
        return effect("unavailable", 0, snapshot.warnings, false, `DSH ${options.profile} profile is unavailable.`);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return effect("unavailable", 0, snapshot.warnings, false,
          `Start dsh ${options.profile} once before enabling the integration.`);
      }
      throw error;
    }
    const models = snapshot[scope];
    if (models.length === 0) {
      const restored = await restoreLocked();
      return effect(restored.observedState, 0, snapshot.warnings, restored.changed,
        restored.message ?? `DSH ${scope === "favorite" ? "Favorite" : "All"} scope has no injectable models.`);
    }
    const originalPatch = await readOptional(patchPath);
    const { doc, rows } = parsePatch(originalPatch);
    let row = targetRow(rows);
    if (row === undefined) {
      const newRow = doc.createNode({ id: "llm-pi-ai", config: { providers: {} } });
      if (!isMap(newRow)) throw new Error("DSH llm-pi-ai entry could not be created.");
      row = newRow;
      const id = row.items.find((item) => item.key === "id" ||
        (isScalar(item.key) && item.key.value === "id"));
      if (id === undefined) throw new Error("DSH llm-pi-ai entry has no id.");
      if (!isScalar(id.key)) id.key = doc.createNode("id");
      if (!isScalar(id.key)) throw new Error("DSH llm-pi-ai id key is invalid.");
      id.key.commentBefore = ROW_COMMENT;
      rows.add(row);
    }
    let providers = providerMap(row);
    if (providers === undefined) {
      if (row.get("config", true) === undefined) {
        const newConfig = doc.createNode({});
        if (!isMap(newConfig)) throw new Error("DSH llm-pi-ai config could not be created.");
        row.set("config", newConfig);
      }
      const newProviders = doc.createNode({});
      const config = row.get("config", true);
      if (!isMap(newProviders) || !isMap(config)) throw new Error("DSH providers map could not be created.");
      providers = newProviders;
      config.set("providers", providers);
    }
    const desired = desiredProvider(snapshot, scope);
    providers.set(PROVIDER_ID, desired);
    const entry = providers.items.find((item) => item.key === PROVIDER_ID ||
      (isScalar(item.key) && item.key.value === PROVIDER_ID));
    if (entry === undefined) throw new Error("DSH Token provider key is missing.");
    if (!isScalar(entry.key)) entry.key = doc.createNode(PROVIDER_ID);
    if (!isScalar(entry.key)) throw new Error("DSH Token provider key is invalid.");
    entry.key.commentBefore = MANAGED_COMMENT;
    const nextPatch = doc.toString({ lineWidth: 0 });
    const originalEnv = await readOptional(envPath);
    let nextEnv: string;
    try {
      nextEnv = patchEnv(originalEnv, true)!;
    } catch (error) {
      return effect("conflict", 0, snapshot.warnings, false, error instanceof Error ? error.message : String(error));
    }
    const envChanged = await replaceIfUnchanged(envPath, originalEnv, nextEnv);
    let patchChanged: boolean;
    try {
      patchChanged = await replaceIfUnchanged(patchPath, originalPatch, nextPatch);
    } catch (error) {
      if (envChanged) {
        const rollback = patchEnv(nextEnv, false);
        if (rollback !== undefined) await replaceIfUnchanged(envPath, nextEnv, rollback).catch(() => undefined);
      }
      throw error;
    }
    return effect("managed", models.length, snapshot.warnings, envChanged || patchChanged);
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = operationQueue.then(() => withLock(work));
    operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return Object.freeze({
    id: "dsh",
    projectionFingerprint: async (snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope) => createHash("sha256")
      .update(JSON.stringify(desiredProvider(snapshot, scope)))
      .digest("hex"),
    inject: (snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope) => enqueue(() => injectLocked(snapshot, scope)),
    restore: () => enqueue(restoreLocked),
  });
}
