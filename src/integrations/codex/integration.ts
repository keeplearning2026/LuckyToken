import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CodexDirectModelSource } from "../../codex-direct-seam.js";
import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentInjectionScope,
} from "../agents/contract.js";
import type { AgentInjectionSnapshot } from "../agents/snapshot.js";
import {
  CODEX_NATIVE_CONFIG_TARGET,
  inspectCodexManagedConfig,
  patchCodexManagedConfig,
  sameCodexManagedConfigValues,
  type CodexManagedConfigValues,
} from "./config-toml.js";
import { replaceTextFileIfUnchanged } from "./file-update.js";
import type {
  CodexNativeCatalogEntry,
  CodexNativeCatalogSource,
} from "./native-catalog-source.js";

const STATE_SCHEMA = "Token-codex-integration-v4" as const;

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
  /** Token aliases actually projected, excluding preserved native models. */
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
  readonly directModels: CodexDirectModelSource;
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
  /** Validate the candidate with the exact runtime identity that produced the
   * native snapshot. A different runtime must not commit the injection. */
  readonly validateCatalog: (
    content: string,
    runtime: { readonly command: string } | undefined,
  ) => Promise<void>;
  readonly projectionFingerprint?: (
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ) => Promise<string>;
}

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
  if (parsed.schemaVersion !== STATE_SCHEMA) return invalidState();
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

function activeTarget(
  endpoint: string,
  catalogPath: string,
): CodexManagedConfigValues {
  return Object.freeze({
    modelProvider: "openai",
    openaiBaseUrl: endpoint,
    modelCatalogJson: catalogPath,
    standaloneWebSearch: true,
  });
}

export function createCodexIntegrationAuthority(
  options: CodexIntegrationAuthorityOptions,
): CodexIntegrationAuthority {
  const configPath = join(options.codexHome, "config.toml");
  const statePath = join(options.stateDirectory, "integration-state.json");
  const catalogPath = join(options.codexHome, "token-model-catalog.json");
  let currentNativeIds: ReadonlySet<string> = new Set<string>();
  let operationQueue = Promise.resolve();

  const directModels: CodexDirectModelSource = Object.freeze({
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
      const inspection = inspectCodexManagedConfig(config);
      if (!inspection.ok) {
        observedState = "conflict";
        message = inspection.message;
      } else if (
        state.managed &&
        endpoint !== undefined &&
        sameCodexManagedConfigValues(
          inspection.values,
          activeTarget(endpoint, catalogPath),
        )
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
        message: "Token Data Plane endpoint is unavailable.",
      });
    }

    const initialConfig = await readOptional(configPath);
    if (initialConfig === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "Codex config.toml was not found.",
      });
    }
    const initialInspection = inspectCodexManagedConfig(initialConfig);
    if (!initialInspection.ok) {
      return project(state, {
        observedState: "conflict",
        message: initialInspection.message,
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
      await options.validateCatalog(
        catalog.content,
        nativeSnapshot.runtimeIdentity === undefined
          ? undefined
          : { command: nativeSnapshot.runtimeIdentity.command },
      );
    } catch (error) {
      const detail =
        error instanceof Error && error.message.length > 0
          ? ` ${error.message}`
          : "";
      return project(state, {
        observedState: "unavailable",
        warnings,
        message:
          `The Token model catalog failed installed Codex validation. No Codex files were changed.${detail}`,
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
    const currentInspection = inspectCodexManagedConfig(currentConfig);
    if (!currentInspection.ok) {
      return project(state, {
        observedState: "conflict",
        message: currentInspection.message,
      });
    }
    const desired = activeTarget(endpoint, catalogPath);
    let nextConfig: string;
    try {
      nextConfig = patchCodexManagedConfig(currentConfig, desired);
    } catch (error) {
      return project(state, {
        observedState: "conflict",
        message:
          error instanceof Error
            ? error.message
            : "Codex config.toml could not be patched safely.",
      });
    }
    // Record recovery ownership before config.toml can point at Token.
    await writeState({ ...committedBeforeApply, managed: true });
    let configWrite: Awaited<ReturnType<typeof replaceTextFileIfUnchanged>>;
    try {
      configWrite = await replaceTextFileIfUnchanged(
        configPath,
        currentConfig,
        nextConfig,
      );
    } catch (error) {
      await writeState(committedBeforeApply);
      throw error;
    }
    if (configWrite === "conflict") {
      await writeState(committedBeforeApply);
      return project(state, {
        observedState: "conflict",
        message:
          "Codex config.toml changed while Token was preparing the integration update.",
      });
    }

    const verified = await readOptional(configPath);
    if (verified === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "Codex config.toml was not found after integration update.",
      });
    }
    const verifiedInspection = inspectCodexManagedConfig(verified);
    if (
      !verifiedInspection.ok ||
      !sameCodexManagedConfigValues(verifiedInspection.values, desired)
    ) {
      return project(state, {
        observedState: "conflict",
        message: verifiedInspection.ok
          ? "Codex config.toml did not converge to the Token routing target."
          : verifiedInspection.message,
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
    const currentInspection = inspectCodexManagedConfig(currentConfig);
    if (!currentInspection.ok) {
      return project(state, {
        observedState: "conflict",
        message: currentInspection.message,
      });
    }
    let restoredConfig: string;
    try {
      restoredConfig = patchCodexManagedConfig(
        currentConfig,
        CODEX_NATIVE_CONFIG_TARGET,
      );
    } catch (error) {
      return project(state, {
        observedState: "conflict",
        message:
          error instanceof Error
            ? error.message
            : "Codex config.toml could not be patched safely.",
      });
    }
    const configWrite = await replaceTextFileIfUnchanged(
      configPath,
      currentConfig,
      restoredConfig,
    );
    if (configWrite === "conflict") {
      return project(state, {
        observedState: "conflict",
        message:
          "Codex config.toml changed while Token was preparing the restore.",
      });
    }
    const configChanged = configWrite === "written";

    const verified = await readOptional(configPath);
    if (verified === undefined) {
      return project(state, {
        observedState: "unavailable",
        message: "Codex config.toml was not found after restore.",
      });
    }
    const verifiedInspection = inspectCodexManagedConfig(verified);
    if (
      !verifiedInspection.ok ||
      !sameCodexManagedConfigValues(
        verifiedInspection.values,
        CODEX_NATIVE_CONFIG_TARGET,
      )
    ) {
      return project(state, {
        observedState: "conflict",
        message: verifiedInspection.ok
          ? "Codex config.toml did not converge to native defaults."
          : verifiedInspection.message,
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
            "Codex integration could not be restored before Token shutdown",
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
    directModels,
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
