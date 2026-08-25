import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PublicModelFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
}

const nodeFileSystem: PublicModelFileSystem = Object.freeze({
  readFile: (path: string) => readFile(path, "utf8"),
  writeFile: (path: string, content: string) =>
    writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  rename,
  mkdir: async (path: string) => {
    await mkdir(path, { recursive: true });
  },
  rm: (path: string) => rm(path, { force: true }),
});

export interface PublicModelRuntimeProviderFacts {
  readonly providerId: string;
  readonly usable: boolean;
  readonly models: readonly string[];
}

export interface PublicModelRuntimeFacts {
  readonly version: number;
  readonly providers: readonly PublicModelRuntimeProviderFacts[];
}

interface StoredPublicModel {
  readonly target: string;
  readonly enabled: boolean;
  readonly favorite: boolean;
}

interface StoredPublicProvider {
  readonly enabled: boolean;
  readonly favorite: boolean;
  readonly models: Readonly<Record<string, StoredPublicModel>>;
}

export interface PublicModelEndpoint {
  readonly host: string;
  readonly port: number;
}

interface PublicModelsDocument {
  readonly schemaVersion: 2;
  readonly endpoint: PublicModelEndpoint;
  readonly providers: Readonly<Record<string, StoredPublicProvider>>;
}

export interface PublicModelProjection {
  readonly alias: string;
  readonly target: string;
  readonly on: boolean;
  readonly favorite: boolean;
}

export interface PublicProviderProjection {
  readonly providerId: string;
  readonly on: boolean;
  readonly favorite: boolean;
  readonly models: readonly PublicModelProjection[];
}

export interface PublishedPublicModel {
  readonly alias: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface PublicModelSnapshot {
  readonly version: number;
  readonly endpoint: PublicModelEndpoint;
  readonly providers: readonly PublicProviderProjection[];
  resolve(alias: string):
    | { readonly providerId: string; readonly modelId: string }
    | undefined;
  publishedModels(): readonly PublishedPublicModel[];
  favoriteModels(): readonly PublishedPublicModel[];
}

export interface PublicModelState {
  readonly revision: number;
  readonly snapshot: PublicModelSnapshot;
}

export type PublicModelCommandOutcome =
  | "ok"
  | "conflict"
  | "invalid"
  | "limit_exceeded"
  | "unavailable"
  | "storage_failure";

export interface PublicModelCommandResult {
  readonly outcome: PublicModelCommandOutcome;
  readonly state: PublicModelState;
}

export interface PublicModelAuthority {
  reconcile(facts: PublicModelRuntimeFacts): Promise<PublicModelState>;
  setPort(input: {
    readonly revision: number;
    readonly port: number;
  }): Promise<PublicModelCommandResult>;
  setProviderOn(input: {
    readonly revision: number;
    readonly providerId: string;
    readonly on: boolean;
  }): Promise<PublicModelCommandResult>;
  setProviderFavorite(input: {
    readonly revision: number;
    readonly providerId: string;
    readonly favorite: boolean;
  }): Promise<PublicModelCommandResult>;
  setModelOn(input: {
    readonly revision: number;
    readonly providerId: string;
    readonly modelId: string;
    readonly on: boolean;
  }): Promise<PublicModelCommandResult>;
  setModelFavorite(input: {
    readonly revision: number;
    readonly providerId: string;
    readonly modelId: string;
    readonly favorite: boolean;
  }): Promise<PublicModelCommandResult>;
  reorderModels(input: {
    readonly revision: number;
    readonly providerId: string;
    readonly modelIds: readonly string[];
  }): Promise<PublicModelCommandResult>;
  renameModel(input: {
    readonly revision: number;
    readonly providerId: string;
    readonly modelId: string;
    readonly modelName: string;
  }): Promise<PublicModelCommandResult>;
  restoreModelName(input: {
    readonly revision: number;
    readonly providerId: string;
    readonly modelId: string;
  }): Promise<PublicModelCommandResult>;
  state(): PublicModelState;
  snapshot(): PublicModelSnapshot;
  /** Force the latest in-memory durable configuration to disk. */
  flush(): Promise<void>;
}

export interface PublicModelPersistenceOptions {
  readonly delayMs: number;
  readonly schedule: (task: () => void, delayMs: number) => () => void;
}

export interface PublicModelAuthorityOptions {
  readonly path: string;
  readonly fileSystem?: PublicModelFileSystem;
  readonly persistence?: PublicModelPersistenceOptions;
  readonly initialEndpoint?: PublicModelEndpoint;
}

const MAX_ALIAS_LENGTH = 128;
export const MAX_FAVORITE_MODELS = 10;
export const MAX_FAVORITE_PROVIDERS = 5;

function normalizeModelName(modelId: string): string {
  return modelId.slice(modelId.lastIndexOf("/") + 1);
}

function allocateDefaultAlias(
  providerId: string,
  modelId: string,
  occupiedAliases: ReadonlySet<string>,
): string {
  const prefix = `${providerId}/`;
  const maxNameLength = Math.max(1, MAX_ALIAS_LENGTH - prefix.length);
  const baseName = normalizeModelName(modelId).slice(0, maxNameLength);
  const base = `${prefix}${baseName}`;
  if (!occupiedAliases.has(base)) return base;
  let suffix = 2;
  while (true) {
    const marker = `-${suffix}`;
    const fitted = baseName.slice(0, Math.max(1, maxNameLength - marker.length));
    const alias = `${prefix}${fitted}${marker}`;
    if (!occupiedAliases.has(alias)) return alias;
    suffix += 1;
  }
}

function validModelName(providerId: string, modelName: string): boolean {
  return (
    modelName.length > 0 &&
    modelName.trim() === modelName &&
    !modelName.includes("/") &&
    `${providerId}/${modelName}`.length <= MAX_ALIAS_LENGTH
  );
}

function emptyDocument(endpoint: PublicModelEndpoint): PublicModelsDocument {
  return { schemaVersion: 2, endpoint, providers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(raw: string): {
  readonly document: PublicModelsDocument;
  readonly migrated: boolean;
} {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !isRecord(value.endpoint) ||
    typeof value.endpoint.host !== "string" ||
    value.endpoint.host.length === 0 ||
    !Number.isSafeInteger(value.endpoint.port) ||
    (value.endpoint.port as number) < 1 ||
    (value.endpoint.port as number) > 65_535 ||
    !isRecord(value.providers)
  ) {
    throw new Error("public-models.json has an invalid schema");
  }
  const migrated = value.schemaVersion === 1;
  const providers: Record<string, StoredPublicProvider> = {};
  for (const [providerId, providerValue] of Object.entries(value.providers)) {
    if (
      !isRecord(providerValue) ||
      typeof providerValue.enabled !== "boolean" ||
      (!migrated && typeof providerValue.favorite !== "boolean") ||
      !isRecord(providerValue.models)
    ) {
      throw new Error("public-models.json has an invalid provider entry");
    }
    const models: Record<string, StoredPublicModel> = {};
    for (const [alias, modelValue] of Object.entries(providerValue.models)) {
      if (
        !isRecord(modelValue) ||
        typeof modelValue.target !== "string" ||
        modelValue.target.length === 0 ||
        typeof modelValue.enabled !== "boolean" ||
        (!migrated && typeof modelValue.favorite !== "boolean")
      ) {
        throw new Error("public-models.json has an invalid model entry");
      }
      models[alias] = {
        target: modelValue.target,
        enabled: modelValue.enabled,
        favorite: migrated ? false : (modelValue.favorite as boolean),
      };
    }
    providers[providerId] = {
      enabled: providerValue.enabled,
      favorite: migrated ? false : (providerValue.favorite as boolean),
      models,
    };
  }
  return {
    migrated,
    document: {
      schemaVersion: 2,
      endpoint: {
        host: value.endpoint.host as string,
        port: value.endpoint.port as number,
      },
      providers,
    },
  };
}

function targetKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function replaceModelAlias(
  models: Readonly<Record<string, StoredPublicModel>>,
  currentAlias: string,
  nextAlias: string,
): Record<string, StoredPublicModel> {
  const next: Record<string, StoredPublicModel> = {};
  for (const [alias, model] of Object.entries(models)) {
    next[alias === currentAlias ? nextAlias : alias] = model;
  }
  return next;
}

function sameRuntimeFacts(
  left: PublicModelRuntimeFacts,
  right: PublicModelRuntimeFacts,
): boolean {
  if (left.providers.length !== right.providers.length) return false;
  const rightByProvider = new Map(
    right.providers.map((provider) => [provider.providerId, provider] as const),
  );
  for (const provider of left.providers) {
    const other = rightByProvider.get(provider.providerId);
    if (other === undefined || other.usable !== provider.usable) return false;
    if (other.models.length !== provider.models.length) return false;
    const otherModels = new Set(other.models);
    if (provider.models.some((modelId) => !otherModels.has(modelId))) return false;
  }
  return true;
}

function buildSnapshot(
  version: number,
  document: PublicModelsDocument,
  facts: PublicModelRuntimeFacts,
): PublicModelSnapshot {
  const runtimeProviders = new Map(
    facts.providers.map((provider) => [provider.providerId, provider] as const),
  );
  const runtimeTargets = new Set<string>();
  for (const provider of facts.providers) {
    for (const modelId of provider.models) {
      runtimeTargets.add(targetKey(provider.providerId, modelId));
    }
  }

  const providers = Object.freeze(
    Object.entries(document.providers).map(([providerId, provider]) => {
      const runtime = runtimeProviders.get(providerId);
      return Object.freeze({
        providerId,
        on: provider.enabled && runtime?.usable === true,
        favorite: provider.favorite,
        models: Object.freeze(
          Object.entries(provider.models).map(([alias, model]) =>
            Object.freeze({
              alias,
              target: model.target,
              on: model.enabled,
              favorite: model.favorite,
            }),
          ),
        ),
      });
    }),
  );

  const byAlias = new Map<string, { providerId: string; modelId: string }>();
  const published: PublishedPublicModel[] = [];
  const favorites: PublishedPublicModel[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      const target = { providerId: provider.providerId, modelId: model.target };
      byAlias.set(model.alias, target);
      if (model.favorite) {
        favorites.push(
          Object.freeze({
            alias: model.alias,
            providerId: target.providerId,
            modelId: target.modelId,
          }),
        );
      }
      if (
        provider.on &&
        model.on &&
        runtimeTargets.has(targetKey(target.providerId, target.modelId))
      ) {
        published.push(
          Object.freeze({
            alias: model.alias,
            providerId: target.providerId,
            modelId: target.modelId,
          }),
        );
      }
    }
  }

  const frozenPublished = Object.freeze(published);
  const frozenFavorites = Object.freeze(favorites);
  return Object.freeze({
    version,
    endpoint: Object.freeze({ ...document.endpoint }),
    providers,
    resolve: (alias: string) => byAlias.get(alias),
    publishedModels: () => frozenPublished,
    favoriteModels: () => frozenFavorites,
  });
}

function materializeRuntime(
  document: PublicModelsDocument,
  facts: PublicModelRuntimeFacts,
): { readonly document: PublicModelsDocument; readonly changed: boolean } {
  const providers: Record<string, StoredPublicProvider> = {};
  for (const [providerId, provider] of Object.entries(document.providers)) {
    providers[providerId] = {
      enabled: provider.enabled,
      favorite: provider.favorite,
      models: { ...provider.models },
    };
  }

  let changed = false;
  for (const runtimeProvider of facts.providers) {
    const existing = providers[runtimeProvider.providerId];
    const provider: {
      enabled: boolean;
      favorite: boolean;
      models: Record<string, StoredPublicModel>;
    } = existing === undefined
      ? { enabled: true, favorite: false, models: {} }
      : {
          enabled: existing.enabled,
          favorite: existing.favorite,
          models: { ...existing.models },
        };
    if (existing === undefined) changed = true;

    const knownTargets = new Set(
      Object.values(provider.models).map((model) => model.target),
    );
    const occupiedAliases = new Set(Object.keys(provider.models));
    for (const modelId of runtimeProvider.models) {
      if (knownTargets.has(modelId)) continue;
      const alias = allocateDefaultAlias(
        runtimeProvider.providerId,
        modelId,
        occupiedAliases,
      );
      provider.models[alias] = { target: modelId, enabled: true, favorite: false };
      occupiedAliases.add(alias);
      knownTargets.add(modelId);
      changed = true;
    }
    providers[runtimeProvider.providerId] = provider;
  }

  return {
    document: { schemaVersion: 2, endpoint: document.endpoint, providers },
    changed,
  };
}

async function readInitialDocument(
  path: string,
  fileSystem: PublicModelFileSystem,
  initialEndpoint: PublicModelEndpoint,
): Promise<{ readonly document: PublicModelsDocument; readonly migrated: boolean }> {
  try {
    return parseDocument(await fileSystem.readFile(path));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { document: emptyDocument(initialEndpoint), migrated: false };
    }
    throw error;
  }
}

async function writeAtomic(
  path: string,
  document: PublicModelsDocument,
  fileSystem: PublicModelFileSystem,
): Promise<void> {
  await fileSystem.mkdir(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fileSystem.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`);
    await fileSystem.rename(temp, path);
  } catch (error) {
    await fileSystem.rm(temp).catch(() => undefined);
    throw error;
  }
}

export function createPublicModelAuthority(
  options: PublicModelAuthorityOptions,
): PublicModelAuthority {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const initialEndpoint = Object.freeze(
    options.initialEndpoint ?? { host: "127.0.0.1", port: 3000 },
  );
  const persistence: PublicModelPersistenceOptions =
    options.persistence ??
    Object.freeze({
      delayMs: 1_000,
      schedule: (task: () => void, delayMs: number) => {
        const handle = setTimeout(task, delayMs);
        return () => clearTimeout(handle);
      },
    });
  let loaded: PublicModelsDocument | undefined;
  let revision = 0;
  let persistedRevision = 0;
  let snapshotVersion = 0;
  let currentFacts: PublicModelRuntimeFacts = { version: 0, providers: [] };
  let currentSnapshot = buildSnapshot(
    0,
    emptyDocument(initialEndpoint),
    currentFacts,
  );
  let cancelScheduledFlush: (() => void) | undefined;
  let operationTail = Promise.resolve();

  const currentState = (): PublicModelState =>
    Object.freeze({ revision, snapshot: currentSnapshot });

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const flushLatest = async (): Promise<void> => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = undefined;
    if (loaded === undefined || persistedRevision >= revision) return;
    await writeAtomic(options.path, loaded, fileSystem);
    persistedRevision = revision;
  };

  const scheduleFlush = (): void => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = persistence.schedule(
      () => {
        cancelScheduledFlush = undefined;
        void serialize(flushLatest).catch(() => undefined);
      },
      persistence.delayMs,
    );
  };

  const commitUserDocument = async (
    document: PublicModelsDocument,
    changed: boolean,
  ): Promise<PublicModelCommandResult> => {
    const nextRevision = changed ? revision + 1 : revision;
    try {
      if (changed || persistedRevision < revision) {
        await writeAtomic(options.path, document, fileSystem);
      }
    } catch {
      return Object.freeze({ outcome: "storage_failure", state: currentState() });
    }
    if (!changed) {
      persistedRevision = revision;
      cancelScheduledFlush?.();
      cancelScheduledFlush = undefined;
      return Object.freeze({ outcome: "ok", state: currentState() });
    }
    loaded = document;
    revision = nextRevision;
    persistedRevision = nextRevision;
    snapshotVersion += 1;
    currentSnapshot = buildSnapshot(snapshotVersion, loaded, currentFacts);
    cancelScheduledFlush?.();
    cancelScheduledFlush = undefined;
    return Object.freeze({ outcome: "ok", state: currentState() });
  };

  return Object.freeze({
    reconcile(facts: PublicModelRuntimeFacts): Promise<PublicModelState> {
      return serialize(async () => {
        if (loaded === undefined) {
          const initial = await readInitialDocument(
            options.path,
            fileSystem,
            initialEndpoint,
          );
          loaded = initial.document;
          if (initial.migrated) {
            await writeAtomic(options.path, loaded, fileSystem);
          }
        }
        const next = materializeRuntime(loaded, facts);
        const runtimeChanged = !sameRuntimeFacts(currentFacts, facts);
        if (next.changed) {
          loaded = next.document;
          revision += 1;
          scheduleFlush();
        }
        currentFacts = facts;
        if (next.changed || runtimeChanged) {
          snapshotVersion += 1;
          currentSnapshot = buildSnapshot(snapshotVersion, loaded, currentFacts);
        }
        return currentState();
      });
    },
    setPort(
      input: Parameters<PublicModelAuthority["setPort"]>[0],
    ): Promise<PublicModelCommandResult> {
      return serialize(async () => {
        if (loaded === undefined || input.revision !== revision) {
          return Object.freeze({ outcome: "conflict", state: currentState() });
        }
        if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const changed = loaded.endpoint.port !== input.port;
        const next: PublicModelsDocument = changed
          ? {
              schemaVersion: 2,
              endpoint: { host: loaded.endpoint.host, port: input.port },
              providers: loaded.providers,
            }
          : loaded;
        return commitUserDocument(next, changed);
      });
    },
    setProviderOn(
      input: Parameters<PublicModelAuthority["setProviderOn"]>[0],
    ): Promise<PublicModelCommandResult> {
      return serialize(async () => {
        if (loaded === undefined || input.revision !== revision) {
          return Object.freeze({ outcome: "conflict", state: currentState() });
        }
        const provider = loaded.providers[input.providerId];
        const runtime = currentFacts.providers.find(
          (candidate) => candidate.providerId === input.providerId,
        );
        if (provider === undefined || runtime === undefined || (input.on && !runtime.usable)) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        if (provider.enabled === input.on) {
          return commitUserDocument(loaded, false);
        }
        const next: PublicModelsDocument = {
          schemaVersion: 2,
          endpoint: loaded.endpoint,
          providers: {
            ...loaded.providers,
            [input.providerId]: {
              enabled: input.on,
              favorite: provider.favorite,
              models: { ...provider.models },
            },
          },
        };
        return commitUserDocument(next, true);
      });
    },
    setProviderFavorite(
      input: Parameters<PublicModelAuthority["setProviderFavorite"]>[0],
    ): Promise<PublicModelCommandResult> {
      return serialize(async () => {
        if (loaded === undefined || input.revision !== revision) {
          return Object.freeze({ outcome: "conflict", state: currentState() });
        }
        const provider = loaded.providers[input.providerId];
        if (provider === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        if (provider.favorite === input.favorite) {
          return commitUserDocument(loaded, false);
        }
        if (
          input.favorite &&
          Object.values(loaded.providers).filter((candidate) => candidate.favorite)
            .length >= MAX_FAVORITE_PROVIDERS
        ) {
          return Object.freeze({
            outcome: "limit_exceeded",
            state: currentState(),
          });
        }
        const next: PublicModelsDocument = {
          schemaVersion: 2,
          endpoint: loaded.endpoint,
          providers: {
            ...loaded.providers,
            [input.providerId]: {
              enabled: provider.enabled,
              favorite: input.favorite,
              models: { ...provider.models },
            },
          },
        };
        return commitUserDocument(next, true);
      });
    },
    setModelOn(
      input: Parameters<PublicModelAuthority["setModelOn"]>[0],
    ): Promise<PublicModelCommandResult> {
      return serialize(async () => {
        if (loaded === undefined || input.revision !== revision) {
          return Object.freeze({ outcome: "conflict", state: currentState() });
        }
        const provider = loaded.providers[input.providerId];
        if (provider === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const entry = Object.entries(provider.models).find(
          ([, model]) => model.target === input.modelId,
        );
        if (entry === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const [alias, model] = entry;
        if (model.enabled === input.on) {
          return commitUserDocument(loaded, false);
        }
        const next: PublicModelsDocument = {
          schemaVersion: 2,
          endpoint: loaded.endpoint,
          providers: {
            ...loaded.providers,
            [input.providerId]: {
              enabled: provider.enabled,
              favorite: provider.favorite,
              models: {
                ...provider.models,
                [alias]: {
                  target: model.target,
                  enabled: input.on,
                  favorite: model.favorite,
                },
              },
            },
          },
        };
        return commitUserDocument(next, true);
      });
    },
    setModelFavorite(
      input: Parameters<PublicModelAuthority["setModelFavorite"]>[0],
    ): Promise<PublicModelCommandResult> {
      return serialize(async () => {
        if (loaded === undefined || input.revision !== revision) {
          return Object.freeze({ outcome: "conflict", state: currentState() });
        }
        const provider = loaded.providers[input.providerId];
        if (provider === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const entry = Object.entries(provider.models).find(
          ([, model]) => model.target === input.modelId,
        );
        if (entry === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const [alias, model] = entry;
        if (model.favorite === input.favorite) {
          return commitUserDocument(loaded, false);
        }
        if (
          input.favorite &&
          Object.values(loaded.providers).reduce(
            (count, candidate) =>
              count + Object.values(candidate.models).filter((item) => item.favorite).length,
            0,
          ) >= MAX_FAVORITE_MODELS
        ) {
          return Object.freeze({
            outcome: "limit_exceeded",
            state: currentState(),
          });
        }
        const next: PublicModelsDocument = {
          schemaVersion: 2,
          endpoint: loaded.endpoint,
          providers: {
            ...loaded.providers,
            [input.providerId]: {
              enabled: provider.enabled,
              favorite: provider.favorite,
              models: {
                ...provider.models,
                [alias]: { ...model, favorite: input.favorite },
              },
            },
          },
        };
        return commitUserDocument(next, true);
      });
    },
    reorderModels(
      input: Parameters<PublicModelAuthority["reorderModels"]>[0],
    ): Promise<PublicModelCommandResult> {
      return serialize(async () => {
        if (loaded === undefined || input.revision !== revision) {
          return Object.freeze({ outcome: "conflict", state: currentState() });
        }
        const provider = loaded.providers[input.providerId];
        if (provider === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const entries = Object.entries(provider.models);
        if (
          input.modelIds.length !== entries.length ||
          new Set(input.modelIds).size !== input.modelIds.length
        ) {
          return Object.freeze({ outcome: "invalid", state: currentState() });
        }
        const byTarget = new Map(entries.map((entry) => [entry[1].target, entry] as const));
        if (
          byTarget.size !== entries.length ||
          input.modelIds.some((modelId) => !byTarget.has(modelId))
        ) {
          return Object.freeze({ outcome: "invalid", state: currentState() });
        }
        const currentOrder = entries.map(([, model]) => model.target);
        const changed = input.modelIds.some(
          (modelId, index) => currentOrder[index] !== modelId,
        );
        if (!changed) return commitUserDocument(loaded, false);

        const models: Record<string, StoredPublicModel> = {};
        for (const modelId of input.modelIds) {
          const entry = byTarget.get(modelId);
          if (entry === undefined) {
            return Object.freeze({ outcome: "invalid", state: currentState() });
          }
          models[entry[0]] = entry[1];
        }
        const next: PublicModelsDocument = {
          schemaVersion: 2,
          endpoint: loaded.endpoint,
          providers: {
            ...loaded.providers,
            [input.providerId]: {
              enabled: provider.enabled,
              favorite: provider.favorite,
              models,
            },
          },
        };
        return commitUserDocument(next, true);
      });
    },
    renameModel(
      input: Parameters<PublicModelAuthority["renameModel"]>[0],
    ): Promise<PublicModelCommandResult> {
      return serialize(async () => {
        if (loaded === undefined || input.revision !== revision) {
          return Object.freeze({ outcome: "conflict", state: currentState() });
        }
        if (!validModelName(input.providerId, input.modelName)) {
          return Object.freeze({ outcome: "invalid", state: currentState() });
        }
        const provider = loaded.providers[input.providerId];
        if (provider === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const entry = Object.entries(provider.models).find(
          ([, model]) => model.target === input.modelId,
        );
        if (entry === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const [currentAlias] = entry;
        const alias = `${input.providerId}/${input.modelName}`;
        if (alias === currentAlias) {
          return commitUserDocument(loaded, false);
        }
        if (provider.models[alias] !== undefined) {
          return Object.freeze({ outcome: "invalid", state: currentState() });
        }
        const models = replaceModelAlias(provider.models, currentAlias, alias);
        const next: PublicModelsDocument = {
          schemaVersion: 2,
          endpoint: loaded.endpoint,
          providers: {
            ...loaded.providers,
            [input.providerId]: {
              enabled: provider.enabled,
              favorite: provider.favorite,
              models,
            },
          },
        };
        return commitUserDocument(next, true);
      });
    },
    restoreModelName(
      input: Parameters<PublicModelAuthority["restoreModelName"]>[0],
    ): Promise<PublicModelCommandResult> {
      return serialize(async () => {
        if (loaded === undefined || input.revision !== revision) {
          return Object.freeze({ outcome: "conflict", state: currentState() });
        }
        const provider = loaded.providers[input.providerId];
        if (provider === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const entry = Object.entries(provider.models).find(
          ([, model]) => model.target === input.modelId,
        );
        if (entry === undefined) {
          return Object.freeze({ outcome: "unavailable", state: currentState() });
        }
        const [currentAlias] = entry;
        const occupied = new Set(Object.keys(provider.models));
        occupied.delete(currentAlias);
        const alias = allocateDefaultAlias(input.providerId, input.modelId, occupied);
        if (alias === currentAlias) {
          return commitUserDocument(loaded, false);
        }
        const models = replaceModelAlias(provider.models, currentAlias, alias);
        const next: PublicModelsDocument = {
          schemaVersion: 2,
          endpoint: loaded.endpoint,
          providers: {
            ...loaded.providers,
            [input.providerId]: {
              enabled: provider.enabled,
              favorite: provider.favorite,
              models,
            },
          },
        };
        return commitUserDocument(next, true);
      });
    },
    state(): PublicModelState {
      return currentState();
    },
    snapshot(): PublicModelSnapshot {
      return currentSnapshot;
    },
    flush: () => serialize(flushLatest),
  });
}
