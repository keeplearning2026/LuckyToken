import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CodexNativeModelSource } from "../../codex-native-seam.js";
import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentInjectionScope,
} from "../agents/contract.js";
import type { AgentInjectionSnapshot } from "../agents/snapshot.js";
import type {
  CodexNativeCatalogEntry,
  CodexNativeCatalogSource,
} from "./native-catalog-source.js";

const STATE_SCHEMA = "luckytoken-codex-integration-v4" as const;

const ROOT_KEYS = [
  "model_provider",
  "openai_base_url",
  "model_catalog_json",
] as const;

type RootKey = (typeof ROOT_KEYS)[number];

export type CodexIntegrationObservedState =
  | "native"
  | "managed"
  | "drifted"
  | "conflict"
  | "unavailable";

export type CodexIntegrationAction =
  | "startup"
  | "enable"
  | "disable"
  | "sync"
  | "shutdown";

export interface CodexCatalogBuildResult {
  readonly content: string;
  readonly modelCount: number;
  /** LuckyToken aliases actually projected, excluding preserved native models. */
  readonly injectedModelCount: number;
  readonly warnings: readonly string[];
}

export interface CodexIntegrationProjection {
  readonly desiredEnabled: boolean;
  readonly scope: AgentInjectionScope;
  readonly observedState: CodexIntegrationObservedState;
  readonly codexHome: string;
  readonly configPath: string;
  readonly catalogPath: string;
  readonly endpoint?: string;
  readonly modelCount?: number;
  readonly warnings: readonly string[];
  readonly restartRequired: boolean;
  readonly desiredGeneration: number;
  readonly appliedGeneration?: number;
  readonly needsSync: boolean;
  readonly message?: string;
}

export interface CodexIntegrationAuthority extends AgentIntegrationAdapter {
  readonly id: "codex";
  readonly nativeModels: CodexNativeModelSource;
  query(): Promise<CodexIntegrationProjection>;
  setScope(scope: AgentInjectionScope): Promise<CodexIntegrationProjection>;
  reconcile(action: CodexIntegrationAction): Promise<CodexIntegrationProjection>;
}

export interface CodexIntegrationAuthorityOptions {
  readonly codexHome: string;
  readonly stateDirectory: string;
  readonly endpoint: () => string | undefined;
  /** Monotonic generation of the complete Public Model runtime snapshot. */
  readonly generation?: () => number;
  readonly nativeCatalog: CodexNativeCatalogSource;
  readonly buildCatalog: (
    nativeEntries: readonly CodexNativeCatalogEntry[],
    scope: AgentInjectionScope,
  ) => Promise<CodexCatalogBuildResult>;
  readonly validateCatalog: (content: string) => Promise<void>;
  readonly restoreTarget?: () => CodexRestoreTarget;
  readonly projectionFingerprint?: (
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ) => Promise<string>;
}

export interface CodexRestoreTarget {
  readonly modelProvider: string | null;
  readonly openaiBaseUrl: string | null;
  readonly modelCatalogJson: string | null;
}

type RootValues = CodexRestoreTarget;

interface IntegrationState {
  readonly schemaVersion: typeof STATE_SCHEMA;
  readonly desiredEnabled: boolean;
  readonly scope: AgentInjectionScope;
  readonly managed: boolean;
  readonly modelCount?: number;
  readonly warnings?: readonly string[];
  readonly appliedGeneration?: number;
  readonly appliedScope?: AgentInjectionScope;
}

interface RootInspection {
  readonly values: RootValues;
  readonly duplicate: boolean;
  readonly invalid: boolean;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function parseTomlString(value: string): string | undefined {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return undefined;
}

function eol(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function propertyForKey(key: RootKey): keyof RootValues {
  switch (key) {
    case "model_provider":
      return "modelProvider";
    case "openai_base_url":
      return "openaiBaseUrl";
    case "model_catalog_json":
      return "modelCatalogJson";
  }
}

function rootKeyTokenPattern(key: RootKey): string {
  return `(?:${key}|"${key}"|'${key}')`;
}

function normalizedRootKey(token: string): RootKey {
  return token.replace(/^["']|["']$/gu, "") as RootKey;
}

function parseRootAssignment(line: string): { readonly key: RootKey; readonly value: string } | undefined {
  const assignment = line.match(
    /^\s*(model_provider|"model_provider"|'model_provider'|openai_base_url|"openai_base_url"|'openai_base_url'|model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=\s*(.*)$/u,
  );
  if (assignment === null) return undefined;
  const remainder = (assignment[2] as string).trimStart();
  if (remainder.length === 0) return undefined;
  const quote = remainder[0];
  if (quote !== '"' && quote !== "'") return undefined;

  let closing = -1;
  if (quote === "'") {
    closing = remainder.indexOf("'", 1);
  } else {
    let escaped = false;
    for (let index = 1; index < remainder.length; index += 1) {
      const character = remainder[index] as string;
      if (character === '"' && !escaped) {
        closing = index;
        break;
      }
      if (character === "\\") escaped = !escaped;
      else escaped = false;
    }
  }
  if (closing < 0) return undefined;

  const tail = remainder.slice(closing + 1).trim();
  if (tail.length > 0 && !tail.startsWith("#")) return undefined;
  const parsed = parseTomlString(remainder.slice(0, closing + 1));
  if (parsed === undefined) return undefined;
  return Object.freeze({
    key: normalizedRootKey(assignment[1] as string),
    value: parsed,
  });
}

function inspectRoot(content: string): RootInspection {
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const hits = new Map<RootKey, string[]>();
  let invalid = false;

  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] as string;
    if (/^\s*#/u.test(line)) continue;
    const keyMatch = line.match(
      /^\s*(model_provider|"model_provider"|'model_provider'|openai_base_url|"openai_base_url"|'openai_base_url'|model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=/u,
    );
    if (keyMatch === null) continue;
    const assignment = parseRootAssignment(line);
    if (assignment === undefined) {
      invalid = true;
      continue;
    }
    const values = hits.get(assignment.key) ?? [];
    values.push(assignment.value);
    hits.set(assignment.key, values);
  }

  return Object.freeze({
    values: Object.freeze({
      modelProvider: hits.get("model_provider")?.[0] ?? null,
      openaiBaseUrl: hits.get("openai_base_url")?.[0] ?? null,
      modelCatalogJson: hits.get("model_catalog_json")?.[0] ?? null,
    }),
    duplicate: ROOT_KEYS.some((key) => (hits.get(key)?.length ?? 0) > 1),
    invalid,
  });
}

function rootError(inspection: RootInspection): string | undefined {
  if (inspection.duplicate) {
    return "Codex config.toml contains duplicate root routing keys.";
  }
  if (inspection.invalid) {
    return "Codex config.toml contains an invalid root routing value.";
  }
  return undefined;
}

function rootValue(values: RootValues, key: RootKey): string | null {
  return values[propertyForKey(key)];
}

function sameRoot(left: RootValues, right: RootValues): boolean {
  return ROOT_KEYS.every((key) => rootValue(left, key) === rootValue(right, key));
}

function findRootKeyIndices(lines: readonly string[], key: RootKey): readonly number[] {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${rootKeyTokenPattern(key)}\\s*=`);
  const indices: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    if (pattern.test(lines[index] as string)) indices.push(index);
  }
  return indices;
}

function insertionIndex(lines: readonly string[]): number {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTable >= 0) return firstTable;
  return lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function convergeRoot(content: string, target: RootValues): string {
  const ending = eol(content);
  const lines = content.replace(/\r\n/gu, "\n").split("\n");

  for (const key of ROOT_KEYS) {
    const desired = rootValue(target, key);
    const indices = [...findRootKeyIndices(lines, key)];
    if (desired === null) {
      for (const index of indices.reverse()) lines.splice(index, 1);
      continue;
    }
    if (indices.length > 0) {
      const first = indices[0] as number;
      for (const index of indices.slice(1).reverse()) lines.splice(index, 1);
      const current = parseRootAssignment(lines[first] as string)?.value;
      if (current !== desired) lines[first] = `${key} = ${tomlString(desired)}`;
      continue;
    }
    lines.splice(insertionIndex(lines), 0, `${key} = ${tomlString(desired)}`);
  }

  const normalized = lines.join("\n");
  return ending === "\n" ? normalized : normalized.replace(/\n/gu, "\r\n");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicWriteIfChanged(path: string, content: string): Promise<boolean> {
  if ((await readOptional(path)) === content) return false;
  await atomicWrite(path, content);
  return true;
}

function emptyState(): IntegrationState {
  return {
    schemaVersion: STATE_SCHEMA,
    desiredEnabled: false,
    scope: "favorite",
    managed: false,
  };
}

function fallbackFingerprint(
  snapshot: AgentInjectionSnapshot,
  scope: AgentInjectionScope,
): string {
  const selected = snapshot[scope];
  const value = selected.length === 0
    ? { scope, models: [] }
    : { endpoint: snapshot.endpoint.openaiBaseUrl, scope, models: selected };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function integrationEffect(
  projection: CodexIntegrationProjection,
  restoring = false,
): AgentIntegrationEffect {
  const message = projection.message ?? (
    projection.restartRequired
      ? restoring
        ? "Codex configuration restored. Restart Codex to apply the change."
        : "Codex synced. Restart Codex to load the updated model catalog."
      : undefined
  );
  return Object.freeze({
    observedState:
      projection.observedState === "drifted"
        ? "conflict"
        : projection.observedState,
    modelCount: restoring ? 0 : (projection.modelCount ?? 0),
    warnings: projection.warnings,
    changed: projection.restartRequired,
    ...(message === undefined ? {} : { message }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidState(): never {
  throw new Error("Codex integration state is invalid");
}

async function readState(path: string): Promise<IntegrationState> {
  const raw = await readOptional(path);
  if (raw === undefined) return emptyState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return invalidState();
  }
  if (!isRecord(parsed)) return invalidState();
  if (
    parsed.schemaVersion === "luckytoken-codex-integration-v1" ||
    parsed.schemaVersion === "luckytoken-codex-integration-v2"
  ) {
    if (typeof parsed.desiredEnabled !== "boolean") return invalidState();
    const managed =
      parsed.schemaVersion === "luckytoken-codex-integration-v2"
        ? parsed.preimage !== undefined
        : parsed.originalConfigBase64 !== undefined ||
          parsed.injectedConfigSha256 !== undefined ||
          parsed.managedBaseUrl !== undefined ||
          parsed.managedCatalogPath !== undefined;
    return Object.freeze({
      schemaVersion: STATE_SCHEMA,
      desiredEnabled: parsed.desiredEnabled,
      scope: "favorite",
      managed,
    });
  }
  if (parsed.schemaVersion === "luckytoken-codex-integration-v3") {
    if (
      typeof parsed.desiredEnabled !== "boolean" ||
      typeof parsed.managed !== "boolean"
    ) {
      return invalidState();
    }
    return Object.freeze({
      schemaVersion: STATE_SCHEMA,
      desiredEnabled: parsed.desiredEnabled,
      scope: "favorite",
      managed: parsed.managed,
      ...(typeof parsed.modelCount === "number"
        ? { modelCount: parsed.modelCount }
        : {}),
      ...(Array.isArray(parsed.warnings)
        ? { warnings: Object.freeze([...parsed.warnings] as string[]) }
        : {}),
    });
  }
  if (parsed.schemaVersion !== STATE_SCHEMA) return emptyState();
  if (typeof parsed.desiredEnabled !== "boolean") return invalidState();
  if (parsed.scope !== "favorite" && parsed.scope !== "full") return invalidState();
  if (typeof parsed.managed !== "boolean") return invalidState();
  const modelCount = parsed.modelCount;
  if (
    modelCount !== undefined &&
    (!Number.isSafeInteger(modelCount) || (modelCount as number) < 0)
  ) {
    return invalidState();
  }
  const warnings = parsed.warnings;
  if (
    warnings !== undefined &&
    (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== "string"))
  ) {
    return invalidState();
  }
  const appliedGeneration = parsed.appliedGeneration;
  if (
    appliedGeneration !== undefined &&
    (!Number.isSafeInteger(appliedGeneration) || (appliedGeneration as number) < 0)
  ) {
    return invalidState();
  }
  const appliedScope = parsed.appliedScope;
  if (
    appliedScope !== undefined &&
    appliedScope !== "favorite" &&
    appliedScope !== "full"
  ) {
    return invalidState();
  }

  return Object.freeze({
    schemaVersion: STATE_SCHEMA,
    desiredEnabled: parsed.desiredEnabled,
    scope: parsed.scope,
    managed: parsed.managed,
    ...(modelCount === undefined ? {} : { modelCount: modelCount as number }),
    ...(warnings === undefined ? {} : { warnings: Object.freeze([...warnings]) }),
    ...(appliedGeneration === undefined
      ? {}
      : { appliedGeneration: appliedGeneration as number }),
    ...(appliedScope === undefined
      ? {}
      : { appliedScope: appliedScope as AgentInjectionScope }),
  });
}

function activeTarget(endpoint: string, catalogPath: string): RootValues {
  return Object.freeze({
    modelProvider: "openai",
    openaiBaseUrl: endpoint,
    modelCatalogJson: catalogPath,
  });
}

export function createCodexIntegrationAuthority(
  options: CodexIntegrationAuthorityOptions,
): CodexIntegrationAuthority {
  const configPath = join(options.codexHome, "config.toml");
  const statePath = join(options.stateDirectory, "integration-state.json");
  const catalogPath = join(options.codexHome, "luckytoken-model-catalog.json");
  let currentNativeIds: ReadonlySet<string> = new Set<string>();
  let operationQueue = Promise.resolve();

  const nativeModels: CodexNativeModelSource = Object.freeze({
    has(modelId: string): boolean {
      return currentNativeIds.has(modelId);
    },
  });

  const writeState = async (state: IntegrationState): Promise<void> => {
    await atomicWriteIfChanged(
      statePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
  };

  const project = async (
    state: IntegrationState,
    override: Partial<CodexIntegrationProjection> = {},
  ): Promise<CodexIntegrationProjection> => {
    const config = await readOptional(configPath);
    const endpoint = options.endpoint();
    let observedState: CodexIntegrationObservedState = "unavailable";
    let message: string | undefined;

    if (config === undefined) {
      message = "Codex config.toml was not found.";
    } else {
      const inspection = inspectRoot(config);
      const error = rootError(inspection);
      if (error !== undefined) {
        observedState = "conflict";
        message = error;
      } else if (
        state.managed &&
        endpoint !== undefined &&
        sameRoot(inspection.values, activeTarget(endpoint, catalogPath))
      ) {
        observedState = "managed";
      } else if (state.managed) {
        observedState = "drifted";
      } else {
        observedState = "native";
      }
    }

    const desiredGeneration = options.generation?.() ?? 0;
    return Object.freeze({
      desiredEnabled: state.desiredEnabled,
      scope: state.scope,
      observedState,
      codexHome: options.codexHome,
      configPath,
      catalogPath,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(state.modelCount === undefined ? {} : { modelCount: state.modelCount }),
      warnings: Object.freeze([...(state.warnings ?? [])]),
      restartRequired: false,
      desiredGeneration,
      ...(state.appliedGeneration === undefined
        ? {}
        : { appliedGeneration: state.appliedGeneration }),
      needsSync:
        state.desiredEnabled &&
        ((!state.managed && state.modelCount !== 0) ||
          state.appliedGeneration !== desiredGeneration ||
          state.appliedScope !== state.scope),
      ...(message === undefined ? {} : { message }),
      ...override,
    });
  };

  const setDesired = async (
    state: IntegrationState,
    desiredEnabled: boolean,
  ): Promise<IntegrationState> => {
    if (state.desiredEnabled === desiredEnabled) return state;
    const next = { ...state, desiredEnabled };
    await writeState(next);
    return next;
  };

  const activate = async (state: IntegrationState): Promise<CodexIntegrationProjection> => {
    const syncGeneration = options.generation?.() ?? 0;
    const endpoint = options.endpoint();
    if (endpoint === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "LuckyToken Data Plane endpoint is unavailable.",
      });
    }

    const initialConfig = await readOptional(configPath);
    if (initialConfig === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "Codex config.toml was not found.",
      });
    }
    const nativeSnapshot = await options.nativeCatalog.load();
    if (nativeSnapshot.source === "unavailable") {
      return project(state, {
        observedState: "unavailable",
        warnings: nativeSnapshot.warnings,
        message: "The Codex model catalog could not be read. No Codex files were changed.",
      });
    }
    const catalog = await options.buildCatalog(nativeSnapshot.entries, state.scope);
    const warnings = Object.freeze([
      ...nativeSnapshot.warnings,
      ...catalog.warnings,
    ]);
    if (catalog.injectedModelCount === 0) {
      let restoredState = state;
      let restartRequired = false;
      if (state.managed) {
        const restored = await restore(state);
        if (restored.observedState !== "native") return restored;
        restoredState = await readState(statePath);
        restartRequired = restored.restartRequired;
      }
      const committed: IntegrationState = {
        ...restoredState,
        desiredEnabled: true,
        managed: false,
        modelCount: 0,
        warnings,
        appliedGeneration: syncGeneration,
        appliedScope: state.scope,
      };
      await writeState(committed);
      currentNativeIds = new Set<string>();
      const scopeLabel = state.scope === "favorite" ? "Favorite" : "Full";
      return project(committed, {
        observedState: "native",
        restartRequired,
        message: `Codex is enabled in ${scopeLabel} scope, but no model can be injected.`,
      });
    }
    try {
      await options.validateCatalog(catalog.content);
    } catch (error) {
      const detail =
        error instanceof Error && error.message.length > 0
          ? ` ${error.message}`
          : "";
      return project(state, {
        observedState: "unavailable",
        warnings,
        message:
          `The LuckyToken model catalog failed installed Codex validation. No Codex files were changed.${detail}`,
      });
    }
    const committedBeforeApply: IntegrationState = {
      ...state,
      modelCount: catalog.injectedModelCount,
      warnings,
    };
    await writeState(committedBeforeApply);
    await atomicWrite(catalogPath, catalog.content);

    const currentConfig = await readOptional(configPath);
    if (currentConfig === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "Codex config.toml was not found.",
      });
    }
    const desired = activeTarget(endpoint, catalogPath);
    const nextConfig = convergeRoot(currentConfig, desired);
    await atomicWrite(configPath, nextConfig);

    const verified = await readOptional(configPath);
    if (verified === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "Codex config.toml was not found after integration update.",
      });
    }
    const verifiedInspection = inspectRoot(verified);
    const verifiedError = rootError(verifiedInspection);
    if (verifiedError !== undefined || !sameRoot(verifiedInspection.values, desired)) {
      return project(state, {
        observedState: "conflict",
        message: verifiedError ?? "Codex config.toml did not converge to the LuckyToken routing target.",
      });
    }

    currentNativeIds = new Set(nativeSnapshot.entries.map((entry) => entry.slug));
    const committed: IntegrationState = {
      ...committedBeforeApply,
      desiredEnabled: true,
      managed: true,
      appliedGeneration: syncGeneration,
      appliedScope: state.scope,
    };
    await writeState(committed);
    return project(committed, {
      observedState: "managed",
      restartRequired: true,
    });
  };

  const restore = async (state: IntegrationState): Promise<CodexIntegrationProjection> => {
    if (!state.managed) {
      currentNativeIds = new Set<string>();
      return project(state);
    }

    const currentConfig = await readOptional(configPath);
    if (currentConfig === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "Codex config.toml was not found while restoring the integration.",
      });
    }
    const restoreTarget = options.restoreTarget?.() ?? {
      modelProvider: null,
      openaiBaseUrl: null,
      modelCatalogJson: null,
    };
    const restoredConfig = convergeRoot(currentConfig, restoreTarget);
    const configChanged = restoredConfig !== currentConfig;
    if (configChanged) await atomicWrite(configPath, restoredConfig);

    const verified = await readOptional(configPath);
    if (verified === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "Codex config.toml was not found after restore.",
      });
    }
    const verifiedInspection = inspectRoot(verified);
    const verifiedError = rootError(verifiedInspection);
    if (verifiedError !== undefined || !sameRoot(verifiedInspection.values, restoreTarget)) {
      return project(state, {
        observedState: "conflict",
        message: verifiedError ?? "Codex config.toml did not converge to the restore target.",
      });
    }

    const restoredState: IntegrationState = {
      ...state,
      managed: false,
    };
    await writeState(restoredState);
    currentNativeIds = new Set<string>();
    return project(restoredState, {
      observedState: "native",
      restartRequired: configChanged,
    });
  };

  const perform = async (
    action: CodexIntegrationAction,
  ): Promise<CodexIntegrationProjection> => {
    let state = await readState(statePath);
    switch (action) {
      case "enable":
        {
          const activated = await activate(state);
          if (activated.observedState !== "managed") return activated;
          state = await setDesired(await readState(statePath), true);
          return project(state, { restartRequired: activated.restartRequired });
        }
      case "disable":
        {
          const restored = await restore(state);
          if (state.managed && restored.observedState !== "native") return restored;
          state = await setDesired(await readState(statePath), false);
          return project(state, { restartRequired: restored.restartRequired });
        }
      case "startup":
      case "sync":
        return state.desiredEnabled ? activate(state) : restore(state);
      case "shutdown": {
        const restorationRequired = state.managed;
        const restored = await restore(state);
        if (restorationRequired && restored.observedState !== "native") {
          throw new Error(
            "Codex integration could not be restored before LuckyToken shutdown",
          );
        }
        return restored;
      }
    }
  };

  const reconcile = (
    action: CodexIntegrationAction,
  ): Promise<CodexIntegrationProjection> => {
    const operation = operationQueue.then(() => perform(action));
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const setScope = (
    scope: AgentInjectionScope,
  ): Promise<CodexIntegrationProjection> => {
    const operation = operationQueue.then(async () => {
      const state = await readState(statePath);
      if (state.scope === scope) return project(state);
      const next = { ...state, scope };
      await writeState(next);
      return project(next);
    });
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const restoreAdapter = (): Promise<AgentIntegrationEffect> => {
    const operation = operationQueue.then(async () => {
      const before = await readState(statePath);
      const projection = await perform("disable");
      if (!before.managed) {
        return Object.freeze({
          observedState: "native" as const,
          modelCount: 0,
          warnings: projection.warnings,
          changed: false,
        });
      }
      return integrationEffect(projection, true);
    });
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return Object.freeze({
    id: "codex",
    nativeModels,
    query: async () => {
      await operationQueue;
      return project(await readState(statePath));
    },
    projectionFingerprint: (
      snapshot: AgentInjectionSnapshot,
      scope: AgentInjectionScope,
    ) =>
      options.projectionFingerprint?.(snapshot, scope) ??
      Promise.resolve(fallbackFingerprint(snapshot, scope)),
    inject: async (
      _snapshot: AgentInjectionSnapshot,
      scope: AgentInjectionScope,
    ) => {
      await setScope(scope);
      return integrationEffect(await reconcile("enable"));
    },
    restore: restoreAdapter,
    setScope,
    reconcile,
  });
}
