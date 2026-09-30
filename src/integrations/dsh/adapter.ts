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
const CREDENTIALS_FILENAME = ".credentials.yaml";
const CREDENTIALS_VERSION = 1;
const CREDENTIAL_REF = "TOKEN_API_KEY";
const CREDENTIAL_VALUE = "token-local";
const DSH_FILE_LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;

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

function lockHolderExited(record: string): boolean {
  if (!/^\d+\n$/u.test(record)) return false;
  const pid = Number(record.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

async function readLockRecord(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath);
  if (record === undefined || !lockHolderExited(record)) return false;
  const claim = `${lockPath}.takeover-${createHash("sha256").update(record).digest("hex").slice(0, 16)}`;
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST" || code === "EPERM") return false;
    throw error;
  }
  try {
    if ((await readLockRecord(lockPath)) !== record || !lockHolderExited(record)) return false;
    try {
      await rm(lockPath, { force: true });
    } catch {
      return false;
    }
    return true;
  } finally {
    await rm(claim, { force: true }).catch(() => undefined);
  }
}

async function withDshFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + DSH_FILE_LOCK_WAIT_MS;
  let delay = LOCK_RETRY_INITIAL_MS;
  let retriedUnconfirmedPermissionError = false;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") {
        if (await takeOverExitedLock(lockPath)) continue;
      } else if (code === "EPERM") {
        let exists = false;
        try {
          await stat(lockPath);
          exists = true;
        } catch {
          exists = false;
        }
        if (exists) {
          if (await takeOverExitedLock(lockPath)) continue;
        } else if (!retriedUnconfirmedPermissionError) {
          retriedUnconfirmedPermissionError = true;
          continue;
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`DSH writer lock timed out at ${lockPath}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
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
    apiKeyEnv: CREDENTIAL_REF,
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

function parseCredentials(raw: string | undefined): { doc: Document; versionMissing: boolean } {
  const doc: Document = parseDocument(raw?.trim() ? raw : "version: 1\n", {
    uniqueKeys: true,
    keepSourceTokens: true,
  });
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error("DSH .credentials.yaml must be a valid YAML map.");
  }
  const contents = doc.contents;
  for (const item of contents.items) {
    const key = isScalar(item.key) ? item.key.value : undefined;
    if (key !== "version" && key !== "refs" && key !== "records") {
      throw new Error("DSH .credentials.yaml has an unsupported top-level key.");
    }
  }
  const version = contents.get("version");
  if (version !== undefined && version !== CREDENTIALS_VERSION) {
    throw new Error(`DSH .credentials.yaml version must be ${CREDENTIALS_VERSION}.`);
  }
  const refs = contents.get("refs", true);
  if (refs !== undefined && !isMap(refs)) {
    throw new Error("DSH .credentials.yaml refs must be a YAML map.");
  }
  const records = contents.get("records", true);
  if (records !== undefined && !isMap(records)) {
    throw new Error("DSH .credentials.yaml records must be a YAML map.");
  }
  return { doc, versionMissing: version === undefined };
}

function patchCredentials(raw: string | undefined, insert: boolean): string | undefined {
  const { doc, versionMissing } = parseCredentials(raw);
  const contents = doc.contents;
  if (!isMap(contents)) throw new Error("DSH .credentials.yaml must be a YAML map.");
  if (versionMissing) contents.set("version", CREDENTIALS_VERSION);
  let refs: YAMLMap | undefined;
  const existingRefs = contents.get("refs", true);
  if (existingRefs !== undefined) {
    if (!isMap(existingRefs)) throw new Error("DSH .credentials.yaml refs must be a YAML map.");
    refs = existingRefs;
  } else if (insert) {
    const created = doc.createNode({});
    if (!isMap(created)) throw new Error("DSH .credentials.yaml refs map could not be created.");
    contents.set("refs", created);
    refs = created;
  } else {
    return undefined;
  }
  const current = refs.get(CREDENTIAL_REF);
  if (insert) {
    if (current === CREDENTIAL_VALUE && raw !== undefined && !versionMissing) return raw;
    refs.set(CREDENTIAL_REF, CREDENTIAL_VALUE);
  } else {
    if (current === undefined) return undefined;
    refs.delete(CREDENTIAL_REF);
    if (refs.items.length === 0) contents.delete("refs");
  }
  return doc.toString({ lineWidth: 0 });
}

export function createDshIntegrationAdapter(options: CreateDshIntegrationAdapterOptions): DshIntegrationAdapter {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(options.profile)) {
    throw new Error("DSH profile name is invalid.");
  }
  const profileDirectory = join(options.dshHome, "profiles", options.profile);
  const patchPath = join(profileDirectory, "cordis.patch.yml");
  const patchLockTarget = join(profileDirectory, "package.json");
  const credentialsPath = join(options.dshHome, CREDENTIALS_FILENAME);
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

  const applyCredentials = async (insert: boolean): Promise<boolean> => {
    if (!insert && (await readOptional(credentialsPath)) === undefined) return false;
    return withDshFileLock(credentialsPath, async () => {
      const original = await readOptional(credentialsPath);
      const next = patchCredentials(original, insert);
      if (next === undefined) return false;
      return replaceIfUnchanged(credentialsPath, original, next);
    });
  };

  const updatePatch = async (
    create: boolean,
    mutate: (originalPatch: string | undefined) => string | undefined,
  ): Promise<boolean> => {
    if (!create && (await readOptional(patchPath)) === undefined) return false;
    return withDshFileLock(patchLockTarget, async () => {
      const original = await readOptional(patchPath);
      const next = mutate(original);
      if (next === undefined) return false;
      return replaceIfUnchanged(patchPath, original, next);
    });
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
      const restored = await restoreLocked();
      return effect(restored.observedState, 0, snapshot.warnings, restored.changed,
        restored.message ?? `DSH ${scope === "favorite" ? "Favorite" : "All"} scope has no injectable models.`);
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
      if (credentialsChanged) await applyCredentials(false).catch(() => undefined);
      throw error;
    }
    return effect("managed", models.length, snapshot.warnings, credentialsChanged || patchChanged);
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = operationQueue.then(() => withLock(work));
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
