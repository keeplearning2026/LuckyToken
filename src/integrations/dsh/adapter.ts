import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";

import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentInjectionScope,
} from "../agents/contract.js";
import type { AgentInjectionModel, AgentInjectionSnapshot } from "../agents/snapshot.js";

const PROVIDER_ID = "Token";
const MANAGED_COMMENT = " Token managed";
const ROW_COMMENT = " Token managed row";
const ENV_MARKER = "# Token managed";
const ENV_KEY = "TOKEN_API_KEY";
const LOCAL_KEY = "token-local";
const DSH_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface CreateDshIntegrationAdapterOptions {
  readonly dshHome: string;
  readonly profile: string;
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
  try {
    await writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
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

function hasOwnedMarker(value: unknown): boolean {
  return typeof value === "string" && value.trim() === ROW_COMMENT.trim();
}

function ownedRow(row: YAMLMap): boolean {
  if (hasOwnedMarker(row.commentBefore)) return true;
  const id = row.items.find((item) => isScalar(item.key) && item.key.value === "id");
  return id !== undefined && isScalar(id.key) && hasOwnedMarker(id.key.commentBefore);
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

/**
 * Pi canonical levels only, mapped to the same-named DSH selectable level.
 * A level Pi does not offer is never invented, defaulted, or downgraded, and
 * Provider-private wire spellings stay behind the Pi model/adapter.
 */
function dshReasoningEfforts(model: AgentInjectionModel): Record<string, string> | undefined {
  if (!model.reasoning) return undefined;
  const offered = new Set(model.thinkingLevels);
  const levels = DSH_THINKING_LEVELS.filter((level) => offered.has(level));
  if (levels.length === 0) return undefined;
  return Object.fromEntries(levels.map((level) => [level, level]));
}

function desiredProvider(snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope) {
  return {
    displayName: "Token",
    apiKeyEnv: ENV_KEY,
    api: "openai-responses",
    baseURL: snapshot.endpoint.openaiBaseUrl,
    models: [...snapshot[scope]].sort((a, b) => a.alias.localeCompare(b.alias)).map((model) => {
      const efforts = dshReasoningEfforts(model);
      return {
        id: model.alias,
        name: model.alias,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: [...model.input],
        ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
      };
    }),
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
  const profileDirectory = join(options.dshHome, "profiles", options.profile);
  const patchPath = join(profileDirectory, "cordis.patch.yml");
  const envPath = join(options.dshHome, ".env");
  let operationQueue = Promise.resolve();

  const applyCredentials = async (insert: boolean): Promise<boolean> => {
    const original = await readOptional(envPath);
    const next = patchEnv(original, insert);
    if (next === undefined) return false;
    return replaceIfUnchanged(envPath, original, next);
  };

  const updatePatch = async (
    create: boolean,
    mutate: (originalPatch: string | undefined) => string | undefined,
  ): Promise<boolean> => {
    const original = await readOptional(patchPath);
    if (!create && original === undefined) return false;
    const next = mutate(original);
    if (next === undefined) return false;
    return replaceIfUnchanged(patchPath, original, next);
  };

  const restoreLocked = async (): Promise<AgentIntegrationEffect> => {
    const patchChanged = await updatePatch(false, (originalPatch) => {
      const { doc, rows } = parsePatch(originalPatch);
      const row = targetRow(rows);
      const providers = row === undefined ? undefined : providerMap(row);
      if (!providers?.has(PROVIDER_ID)) return undefined;
      providers.delete(PROVIDER_ID);
      const config = row!.get("config", true);
      if (!isMap(config)) throw new Error("DSH llm-pi-ai config must be a YAML map.");
      if (providers.items.length === 0) config.delete("providers");
      if (config.items.length === 0 && ownedRow(row!)) rows.items.splice(rows.items.indexOf(row!), 1);
      return doc.toString({ lineWidth: 0 });
    });
    let credentialsChanged = false;
    try {
      credentialsChanged = await applyCredentials(false);
    } catch (error) {
      return effect("conflict", 0, [], false, error instanceof Error ? error.message : String(error));
    }
    return effect("native", 0, [], patchChanged || credentialsChanged);
  };

  const injectLocked = async (
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ): Promise<AgentIntegrationEffect> => {
    try {
      if (!(await stat(profileDirectory)).isDirectory()) {
        return effect("unavailable", 0, snapshot.warnings, false, `DSH ${options.profile} profile is unavailable.`);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return effect("unavailable", 0, snapshot.warnings, false,
          options.profile === "desktop"
            ? "Launch DeepSeek Harness Desktop once before enabling the integration."
            : `Start dsh ${options.profile} once before enabling the integration.`);
      }
      throw error;
    }
    const models = snapshot[scope];
    if (models.length === 0) {
      return effect("unavailable", 0, snapshot.warnings, false,
        `DSH ${scope === "favorite" ? "Favorite" : "All"} scope has no injectable models; ` +
        "existing DSH configuration was left unchanged.");
    }
    let credentialsChanged: boolean;
    try {
      credentialsChanged = await applyCredentials(true);
    } catch (error) {
      return effect("conflict", 0, snapshot.warnings, false, error instanceof Error ? error.message : String(error));
    }
    let patchChanged: boolean;
    try {
      patchChanged = await updatePatch(true, (originalPatch) => {
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
        return doc.toString({ lineWidth: 0 });
      });
    } catch (error) {
      return effect("conflict", 0, snapshot.warnings, credentialsChanged,
        error instanceof Error ? error.message : String(error));
    }
    return effect("managed", models.length, snapshot.warnings, credentialsChanged || patchChanged);
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = operationQueue.then(work);
    operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return Object.freeze({
    id: "dsh",
    projectionFingerprint: async (snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope) => createHash("sha256")
      .update(JSON.stringify({
        profile: options.profile,
        provider: desiredProvider(snapshot, scope),
      }))
      .digest("hex"),
    inject: (snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope) => enqueue(() => injectLocked(snapshot, scope)),
    restore: () => enqueue(restoreLocked),
  });
}
