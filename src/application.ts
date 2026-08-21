import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectControlPlane,
  controlPlaneVersion,
  createLocalIpcAddress,
  createNodePipeTransport,
  startControlPlane,
  type ApplicationOwnership,
  type ApplicationStatus,
  type BackupCommandHandler,
  type CompatibilityIssue,
  type ControlPlaneEndpoint,
} from "@luckytoken/application-control-plane/control-plane";

import {
  buildServeAutoStartCommand,
  createUnsupportedAutoStartRegistrar,
  createWindowsAutoStartRegistrar,
  executeAutoStart,
  type AutoStartRegistrar,
} from "./auto-start.js";
import {
  createConfiguredBackupAuthority,
  recoveryBackupSnapshots,
} from "./backup/index.js";
import { loadLuckyTokenCliConfig } from "./cli-config.js";
import { createConfiguredLuckyTokenDataPlane } from "./composition.js";
import {
  createControlPlaneDiscovery,
  resolveControlPlaneDescriptorPath,
  type ControlPlaneDiscovery,
  type DiscoveryPublication,
} from "./control-plane-discovery.js";
import { createProductionControlPipe } from "./control-pipe-composition.js";
import { createCredentialControlPlaneHandler } from "./credentials/control-plane.js";
import { createAuthLoginControlPlaneHandler } from "./credentials/login-control-plane.js";
import type { LiveCredentialAuthority } from "./credentials/authority.js";
import {
  bindDeepDiagnosticsConfiguration,
  createDeepCaptureStoreFactory,
  type DeepCaptureStore,
} from "./deep-diagnostics/index.js";
import {
  createDesktopOwnerLeaseAuthority,
  executeDesktopOwnerLeaseCommand,
  type DesktopOwnerLeaseAuthority,
} from "./desktop-owner-lease.js";
import { createFirstRunConfig } from "./first-run-config.js";
import { createHistoryAuthority } from "./history/index.js";
import {
  createInstanceAuthority,
  InstanceAuthorityOwnedError,
  resolveBackendInstanceDatabasePath,
  type InstanceAuthority,
  type InstanceLease,
} from "./instance-authority.js";
import { createModelsJsonAuthority } from "./models-config/authority.js";
import { createModelsControlPlaneHandler } from "./models-config/control-plane.js";
import { createPublicModelAuthority } from "./public-models/authority.js";
import { createPublicModelsControlPlaneHandler } from "./public-models/control-plane.js";
import { publicModelRuntimeFacts } from "./public-models/runtime-facts.js";
import { createOperationalAttentionAuthority } from "./operational-attention/index.js";
import {
  configCompatibilityIssue,
  inspectOwnedCompatibility,
  recoveryProjection,
} from "./owned-storage/index.js";
import {
  createPersistenceDegradationAuthority,
  createUnavailableDeepCaptureStore,
  createUnavailableDiagnosticsStore,
  createUnavailableRequestLedgerStore,
  observeDiagnosticsStore,
} from "./persistence-degradation/index.js";
import { createCatalogCacheStore } from "./providers/catalog-cache.js";
import { createCatalogRefreshController } from "./providers/catalog-refresh.js";
import { composeEffectiveCatalog } from "./providers/effective-composition.js";
import { createProviderRuntime, type ProviderRuntime } from "./providers/runtime.js";
import { providerReadiness } from "./providers/readiness.js";
import {
  bindRequestLedgerConfiguration,
  createRequestLedgerStoreFactory,
  type RequestLedgerStore,
} from "./request-ledger/index.js";
import {
  bindRuntimeDiagnosticsConfiguration,
  createRuntimeDiagnosticsStoreFactory,
  type RuntimeDiagnosticsStore,
} from "./runtime-diagnostics/index.js";
import { createDataPlaneRuntimeSupervisor } from "./runtime-supervisor.js";
import { createSettingsRegistry } from "./settings/catalog.js";
import { createSettingsControlPlaneHandler } from "./settings/control-plane.js";
import { DATA_PLANE_LOOPBACK_HOST } from "./settings/data-plane.js";
import { createFileSettingsStore } from "./settings/file-store.js";
import { startLuckyTokenHttpServer } from "./server.js";
import { resolveCodexHome } from "./integrations/codex/home.js";
import { createCodexLocalCredentialAuthority } from "./integrations/codex/local-auth.js";
import { createCodexNativeCatalogSource } from "./integrations/codex/native-catalog-source.js";
import { buildCodexCatalog } from "./integrations/codex/catalog.js";
import { createCodexIntegrationAuthority } from "./integrations/codex/integration.js";
import { LUCKYTOKEN_RELEASE_VERSION } from "./version.js";

export type ApplicationOwnerKind = "cli" | "desktop";
export type ApplicationExitReason = "closed" | "drained" | "timed_out";

const DESKTOP_OWNER_LEASE_TTL_MS = 15_000;
const DESKTOP_OWNER_LEASE_CHECK_INTERVAL_MS = 1_000;

export interface ApplicationExit {
  readonly reason: ApplicationExitReason;
}

export interface RunningLuckyTokenApplication {
  readonly ownership: ApplicationOwnership;
  readonly exited: Promise<ApplicationExit>;
  requestShutdown(): Promise<ApplicationExit>;
  close(): Promise<void>;
}

export type StartLuckyTokenApplicationResult =
  | {
      readonly kind: "running";
      readonly application: RunningLuckyTokenApplication;
    }
  | {
      readonly kind: "attached";
      readonly ownership?: ApplicationOwnership;
    };

export interface ApplicationRouteFact {
  readonly method: string;
  readonly origin: string;
  readonly pathname: string;
}

export interface LuckyTokenApplicationEvents {
  readonly onRoute?: (route: ApplicationRouteFact) => void;
  readonly onAttached?: (ownership: ApplicationOwnership | undefined) => void;
  readonly onExit?: (exit: ApplicationExit) => void;
}

export interface StartLuckyTokenApplicationOptions {
  readonly configPath: string;
  readonly descriptorOverride?: string;
  readonly ownerKind?: ApplicationOwnerKind;
  readonly desktopExe?: string;
  readonly buildId?: string;
  readonly createFirstRunConfig?: boolean;
  readonly events?: LuckyTokenApplicationEvents;
  /** Internal composition dependency used by integration tests. Production
   * derives one authority from LuckyToken-owned current-user application state. */
  readonly instanceAuthority?: InstanceAuthority;
}

function endpointForCurrentUser(runtimeDirectory: string): ControlPlaneEndpoint {
  return Object.freeze({
    address: createLocalIpcAddress({
      platform: process.platform,
      runtimeDirectory,
      randomId: `${(process.env.USERNAME ?? "current-user").replace(/[^A-Za-z0-9_.-]/gu, "_")}-${randomBytes(24).toString("hex")}`,
    }),
    capability: randomBytes(32).toString("base64url"),
  });
}

async function tryAttachToActiveInstance(
  discovery: ControlPlaneDiscovery,
  events: LuckyTokenApplicationEvents | undefined,
): Promise<{ readonly ownership: ApplicationOwnership | undefined } | undefined> {
  const endpoint = await discovery.read();
  if (endpoint === undefined) return undefined;
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    const hello = await client.hello(controlPlaneVersion);
    if (hello.type === "incompatible") {
      throw new Error(
        "the active instance speaks an incompatible Control Plane contract",
      );
    }
    const result = await client.executeApplicationCommand({ command: "attach" });
    const ownership = result.snapshot.ownership;
    events?.onAttached?.(ownership);
    return Object.freeze({ ownership });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function acquireInstanceAuthorityOrAttach(options: {
  readonly authority: InstanceAuthority;
  readonly discovery: ControlPlaneDiscovery;
  readonly events: LuckyTokenApplicationEvents | undefined;
}): Promise<
  | { readonly kind: "acquired"; readonly lease: InstanceLease }
  | { readonly kind: "attached"; readonly ownership: ApplicationOwnership | undefined }
> {
  let lastAttachError: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return Object.freeze({
        kind: "acquired" as const,
        lease: await options.authority.acquire(),
      });
    } catch (error) {
      if (!(error instanceof InstanceAuthorityOwnedError)) throw error;
    }

    try {
      const attached = await tryAttachToActiveInstance(
        options.discovery,
        options.events,
      );
      if (attached !== undefined) {
        return Object.freeze({
          kind: "attached" as const,
          ownership: attached.ownership,
        });
      }
    } catch (error) {
      lastAttachError = error;
    }

    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw lastAttachError instanceof Error
    ? lastAttachError
    : new Error("Active LuckyToken Backend is not management-ready yet");
}

function createAutoStartRegistrar(options: {
  readonly ownerKind: ApplicationOwnerKind;
  readonly configPath: string;
  readonly desktopExe?: string;
}): AutoStartRegistrar {
  if (process.platform !== "win32") return createUnsupportedAutoStartRegistrar();
  return createWindowsAutoStartRegistrar({
    name: "LuckyToken",
    command: buildServeAutoStartCommand({
      ownerKind: options.ownerKind,
      nodeExecutable: process.execPath,
      cliScript: fileURLToPath(new URL("./cli.js", import.meta.url)),
      configPath: resolve(options.configPath),
      ...(options.desktopExe === undefined ? {} : { desktopExe: options.desktopExe }),
    }),
  });
}

interface ControlledLuckyTokenApplication extends RunningLuckyTokenApplication {
  finish(reason: ApplicationExitReason): Promise<ApplicationExit>;
}

function createLifecycle(options: {
  readonly ownership: ApplicationOwnership;
  readonly cleanup: () => Promise<void>;
  readonly drain?: () => Promise<"drained" | "timed_out">;
  readonly events?: LuckyTokenApplicationEvents;
}): ControlledLuckyTokenApplication {
  let settled: ApplicationExit | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let resolveExited: ((exit: ApplicationExit) => void) | undefined;
  const exited = new Promise<ApplicationExit>((resolveExit) => {
    resolveExited = resolveExit;
  });

  const settle = async (reason: ApplicationExitReason): Promise<ApplicationExit> => {
    if (settled !== undefined) return settled;
    cleanupPromise ??= options.cleanup();
    await cleanupPromise;
    const exit = Object.freeze({ reason });
    settled = exit;
    resolveExited?.(exit);
    options.events?.onExit?.(exit);
    return exit;
  };

  return Object.freeze({
    ownership: options.ownership,
    exited,
    finish: settle,
    async requestShutdown(): Promise<ApplicationExit> {
      if (settled !== undefined) return settled;
      const reason = options.drain === undefined ? "closed" : await options.drain();
      return settle(reason);
    },
    async close(): Promise<void> {
      await settle("closed");
    },
  });
}

async function startRecoveryApplication(options: {
  readonly configPath: string;
  readonly issues: readonly CompatibilityIssue[];
  readonly descriptorPath: string;
  readonly discovery: ControlPlaneDiscovery;
  readonly instanceLease: InstanceLease;
  readonly backupCommandHandler?: BackupCommandHandler;
  readonly ownerKind: ApplicationOwnerKind;
  readonly desktopExe?: string;
  readonly buildId?: string;
  readonly events?: LuckyTokenApplicationEvents;
}): Promise<StartLuckyTokenApplicationResult> {
  const endpoint = endpointForCurrentUser(dirname(options.descriptorPath));
  let publication: DiscoveryPublication | undefined;

  const ownership: ApplicationOwnership = Object.freeze({
    owner: {
      kind: options.ownerKind,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
  });
  const controlPipe = await createProductionControlPipe();
  const autoStartRegistrar = createAutoStartRegistrar(options);
  const lifecycleHolder: { current?: ControlledLuckyTokenApplication } = {};
  let desktopOwnerLeaseTimer: ReturnType<typeof setInterval> | undefined;
  const desktopOwnerLease =
    options.ownerKind === "desktop"
      ? createDesktopOwnerLeaseAuthority({
          ttlMs: DESKTOP_OWNER_LEASE_TTL_MS,
          now: Date.now,
          requireInitialClaim: true,
          onExpired: async () => {
            await lifecycleHolder.current?.finish("drained");
          },
        })
      : undefined;

  const controlPlane = await startControlPlane({
    endpoint,
    application: {
      id: "luckytoken",
      version: LUCKYTOKEN_RELEASE_VERSION,
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
    },
    initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
    ownership,
    recoveryProjection: () => recoveryProjection(options.issues),
    ...(options.backupCommandHandler === undefined
      ? {}
      : { backupCommandHandler: options.backupCommandHandler }),
    applicationCommandHandler: async (command) => {
      if (command.command === "attach") return { outcome: "attached" };
      if (command.command === "desktop_owner") {
        return executeDesktopOwnerLeaseCommand(desktopOwnerLease, command);
      }
      if (command.command === "quit") return { outcome: "drained" };
      const execution = await executeAutoStart(autoStartRegistrar, command.action);
      return {
        outcome: execution.outcome,
        ...(execution.error === undefined ? {} : { error: execution.error }),
        ...(execution.enabled === undefined
          ? {}
          : { autoStart: { enabled: execution.enabled } }),
      };
    },
    onApplicationCommandResultDelivered: (command) => {
      if (command.command !== "quit") return;
      setImmediate(() => {
        void lifecycleHolder.current?.finish("drained");
      });
    },
    pipeServerFactory: controlPipe.pipeServerFactory,
    access: controlPipe.access,
  });
  try {
    publication = await options.discovery.publish(endpoint);
  } catch (error) {
    await controlPlane.close().catch(() => undefined);
    throw error;
  }

  const cleanup = async (): Promise<void> => {
    if (desktopOwnerLeaseTimer !== undefined) {
      clearInterval(desktopOwnerLeaseTimer);
      desktopOwnerLeaseTimer = undefined;
    }
    const failures: unknown[] = [];
    await publication?.close().catch((error: unknown) => failures.push(error));
    await controlPlane.close().catch((error: unknown) => failures.push(error));
    await options.instanceLease.close().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
      throw new Error("LuckyToken recovery Control Plane cleanup failed");
    }
  };
  const lifecycle = createLifecycle({
    ownership,
    cleanup,
    ...(options.events === undefined ? {} : { events: options.events }),
  });
  lifecycleHolder.current = lifecycle;
  if (desktopOwnerLease !== undefined) {
    let checkingLease = false;
    desktopOwnerLeaseTimer = setInterval(() => {
      if (checkingLease) return;
      checkingLease = true;
      void desktopOwnerLease
        .expireIfNeeded()
        .catch(() => undefined)
        .finally(() => {
          checkingLease = false;
        });
    }, DESKTOP_OWNER_LEASE_CHECK_INTERVAL_MS);
    desktopOwnerLeaseTimer.unref();
  }
  return { kind: "running", application: lifecycle };
}

async function startNormalApplication(options: {
  readonly configPath: string;
  readonly config: Awaited<ReturnType<typeof loadLuckyTokenCliConfig>>;
  readonly descriptorPath: string;
  readonly discovery: ControlPlaneDiscovery;
  readonly instanceLease: InstanceLease;
  readonly ownerKind: ApplicationOwnerKind;
  readonly desktopExe?: string;
  readonly buildId?: string;
  readonly events?: LuckyTokenApplicationEvents;
}): Promise<StartLuckyTokenApplicationResult> {
  const { config } = options;
  const endpoint = endpointForCurrentUser(dirname(options.descriptorPath));

  let publication: DiscoveryPublication | undefined;
  let supervisor: Awaited<ReturnType<typeof createDataPlaneRuntimeSupervisor>> | undefined;
  let controlPlane: Awaited<ReturnType<typeof startControlPlane>> | undefined;
  let diagnosticsStore: RuntimeDiagnosticsStore | undefined;
  let requestLedgerStore: RequestLedgerStore | undefined;
  let deepCaptureStore: DeepCaptureStore | undefined;
  let attentionLedgerSubscription: { readonly unsubscribe: () => void } | undefined;
  let attentionRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let lifecycle: ControlledLuckyTokenApplication | undefined;
  let desktopOwnerLease: DesktopOwnerLeaseAuthority | undefined;
  let desktopOwnerLeaseTimer: ReturnType<typeof setInterval> | undefined;
  let catalogControllerForCleanup:
    | ReturnType<typeof createCatalogRefreshController>
    | undefined;
  let publicModelAuthorityForCleanup:
    | ReturnType<typeof createPublicModelAuthority>
    | undefined;
  let restoreCodexForCleanup: (() => Promise<void>) | undefined;
  let publicModelReconcileChain: Promise<void> = Promise.resolve();
  let lastPublishedStatus: ApplicationStatus = Object.freeze({
    modelDataPlane: "stopped",
    provider: "unconfigured",
  });

  const closeOwnedResources = async (): Promise<readonly unknown[]> => {
    const failures: unknown[] = [];
    if (attentionRefreshTimer !== undefined) {
      clearInterval(attentionRefreshTimer);
      attentionRefreshTimer = undefined;
    }
    if (desktopOwnerLeaseTimer !== undefined) {
      clearInterval(desktopOwnerLeaseTimer);
      desktopOwnerLeaseTimer = undefined;
    }
    try {
      attentionLedgerSubscription?.unsubscribe();
    } catch (error) {
      failures.push(error);
    }
    attentionLedgerSubscription = undefined;
    await restoreCodexForCleanup?.().catch((error: unknown) => failures.push(error));
    if (supervisor !== undefined) {
      await supervisor
        .execute(
          "stop",
          (status) => controlPlane?.publishStatus(status) ?? Promise.resolve(),
        )
        .catch((error: unknown) => failures.push(error));
    }
    await publication?.close().catch((error: unknown) => failures.push(error));
    await controlPlane?.close().catch((error: unknown) => failures.push(error));
    await catalogControllerForCleanup
      ?.dispose()
      .catch((error: unknown) => failures.push(error));
    await publicModelReconcileChain.catch((error: unknown) => failures.push(error));
    await publicModelAuthorityForCleanup
      ?.flush()
      .catch((error: unknown) => failures.push(error));
    const storageResults = await Promise.allSettled([
      diagnosticsStore?.close() ?? Promise.resolve(),
      requestLedgerStore?.close() ?? Promise.resolve(),
      deepCaptureStore?.close() ?? Promise.resolve(),
    ]);
    for (const result of storageResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    await options.instanceLease.close().catch((error: unknown) => failures.push(error));
    return Object.freeze(failures);
  };

  const ownership: ApplicationOwnership = Object.freeze({
    owner: {
      kind: options.ownerKind,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
  });

  try {
    let diagnosticsOpenFailed = false;
    try {
      diagnosticsStore = await createRuntimeDiagnosticsStoreFactory({
        configuration: bindRuntimeDiagnosticsConfiguration(config.runtimeDiagnostics),
      }).open();
    } catch {
      diagnosticsOpenFailed = true;
    }

    const persistenceAuthority = createPersistenceDegradationAuthority({
      ...(diagnosticsStore === undefined ? {} : { diagnosticsStore }),
      onStateChange: () => {
        controlPlane?.publishStatus(lastPublishedStatus).catch(() => undefined);
      },
    });
    if (diagnosticsOpenFailed) {
      persistenceAuthority.reportFailure("diagnostics");
      diagnosticsStore = createUnavailableDiagnosticsStore(persistenceAuthority);
    } else {
      diagnosticsStore = observeDiagnosticsStore(
        diagnosticsStore as RuntimeDiagnosticsStore,
        persistenceAuthority,
      );
    }
    const ownedDiagnosticsStore = diagnosticsStore;

    try {
      requestLedgerStore = await createRequestLedgerStoreFactory({
        configuration: bindRequestLedgerConfiguration(config.requestLedger),
        onPersistenceFailure: (failure) => {
          persistenceAuthority.reportFailure("requestLedger", {
            ...(failure.requestId.length === 0
              ? {}
              : { requestId: failure.requestId }),
            messageHash: failure.messageHash,
          });
        },
        onPersistenceRecovery: () => {
          persistenceAuthority.reportRecovery("requestLedger");
        },
      }).open();
    } catch {
      requestLedgerStore = createUnavailableRequestLedgerStore();
      persistenceAuthority.reportFailure("requestLedger");
    }
    const ownedLedgerStore = requestLedgerStore;

    try {
      deepCaptureStore = await createDeepCaptureStoreFactory({
        configuration: bindDeepDiagnosticsConfiguration(config.deepDiagnostics),
      }).open();
    } catch {
      deepCaptureStore = createUnavailableDeepCaptureStore();
      persistenceAuthority.reportFailure("capture");
    }
    const ownedCaptureStore = deepCaptureStore;
    const controlPipe = await createProductionControlPipe();
    const modelsAuthority = createModelsJsonAuthority({
      path: config.pi.modelsJson,
      compose: (providers) => composeEffectiveCatalog(providers),
    });
    const catalogCacheStore = createCatalogCacheStore({
      path: join(config.pi.directory, "models-catalog-cache.json"),
    });
    const settingsRegistry = createSettingsRegistry(
      createFileSettingsStore(join(dirname(options.configPath), "settings.json")),
      {
        initial: {
          "diagnostics.deepCapture.enabled": config.deepDiagnostics.enabled,
        },
      },
    );
    await settingsRegistry.load();
    const publicModelAuthority = createPublicModelAuthority({
      path: join(dirname(config.pi.modelsJson), "public-models.json"),
      initialEndpoint: {
        host: DATA_PLANE_LOOPBACK_HOST,
        port: config.server.port,
      },
    });
    publicModelAuthorityForCleanup = publicModelAuthority;
    const reconcilePublicModels = (
      snapshot: Parameters<typeof publicModelRuntimeFacts>[0],
    ): Promise<void> => {
      const task = publicModelReconcileChain
        .catch(() => undefined)
        .then(async () => {
          await publicModelAuthority.reconcile(
            publicModelRuntimeFacts(snapshot, credentialAuthority?.snapshot()),
          );
        });
      publicModelReconcileChain = task;
      return task;
    };

    // These bindings are assigned once after the Catalog controller exists
    // (below); the Control Plane handlers close over them, so they must be
    // declared before their creation site and cannot be const.
    // eslint-disable-next-line prefer-const
    let credentialAuthority: LiveCredentialAuthority | undefined;
    // eslint-disable-next-line prefer-const
    let providerRuntime: ProviderRuntime | undefined;
    let requestIdentities:
      | Awaited<
          ReturnType<typeof createConfiguredLuckyTokenDataPlane>
        >["requestIdentities"]
      | undefined;

    const operationalAttention = createOperationalAttentionAuthority({
      now: Date.now,
      credentials: () => credentialAuthority?.snapshot(),
      persistence: () => persistenceAuthority.projection(),
      requestFailureCount: (from, to) => {
        const result = ownedLedgerStore.analyze({
          version: 1,
          command: "summary",
          from,
          to,
        });
        return result.command === "summary"
          ? result.totals.failed + result.totals.other
          : 0;
      },
    });
    const baseCredentialCommandHandler = createCredentialControlPlaneHandler({
      authority: () => credentialAuthority,
    });
    const credentialCommandHandler: typeof baseCredentialCommandHandler = async (
      command,
    ) => {
      const result = await baseCredentialCommandHandler(command);
      if (result.outcome !== "unavailable") {
        await reconcilePublicModels(catalogController.snapshot());
      }
      return result;
    };
    // Provider Activation (Spec v1.0 §10.2): the Auth handler is wired to
    // the Backend-lifetime Provider Runtime — never to optional slots
    // populated by Data Plane startup.
    const authCommandHandler = createAuthLoginControlPlaneHandler({
      models: () => providerRuntime?.models,
      authority: () => providerRuntime?.credentialAuthority,
      providerSource: (providerId) =>
        providerRuntime?.providerSource(providerId) ?? "user",
    });
    const settingsCommandHandler = createSettingsControlPlaneHandler(settingsRegistry);
    const drainTimeoutMs = (): number => {
      const setting = settingsRegistry.query([
        "application.quitDrainTimeoutMs",
      ])["application.quitDrainTimeoutMs"];
      if (setting === undefined) return 5000;
      const value = Number(setting.value);
      return Number.isSafeInteger(value) && value >= 0 ? value : 5000;
    };

    const catalogController = createCatalogRefreshController({
      store: catalogCacheStore,
      authority: modelsAuthority,
      diagnostics: ownedDiagnosticsStore,
      now: Date.now,
      onSnapshot: () => {
        // Provider Activation (Spec v1.0 §14): the coarse Provider
        // readiness is a pure derivation of the authoritative Catalog
        // snapshot — at least one model must be currently available. It
        // is recomputed and republished on every catalog publication.
        const snapshot = catalogController.snapshot();
        const nextProvider = providerReadiness(snapshot);
        if (lastPublishedStatus.provider !== nextProvider) {
          lastPublishedStatus = Object.freeze({
            ...lastPublishedStatus,
            provider: nextProvider,
          });
        }
        void reconcilePublicModels(snapshot).catch(() => undefined);
        controlPlane?.publishStatus(lastPublishedStatus).catch(() => undefined);
      },
    });
    catalogControllerForCleanup = catalogController;
    // Provider Activation (Spec v1.0 §6, §11.2): the Backend-lifetime
    // Provider Runtime is created BEFORE the Data Plane Supervisor and
    // before the Control Plane starts. Provider discovery, credentials,
    // login and the authoritative Catalog live for the whole Backend
    // lifetime; Data Plane stop/start/restart never recreates them.
    providerRuntime = await createProviderRuntime({
      piDirectory: config.pi.directory,
      modelsJsonPath: config.pi.modelsJson,
      userProviderPackages: config.providerPackages,
      fetch: globalThis.fetch,
      modelsStore: catalogCacheStore,
      onInvalidModelsJson: (error) => {
        ownedDiagnosticsStore.append({
          level: "warning",
          text: "models.json is not loadable; Provider composition keeps compatible built-in Providers until the file is fixed.",
          details: Object.freeze({
            kind:
              typeof error === "object" && error !== null && "kind" in error
                ? String((error as { readonly kind?: unknown }).kind)
                : "load",
          }),
        });
      },
      onProviderLogin: (providerId) =>
        catalogController.onProviderLogin(providerId),
    });
    credentialAuthority = providerRuntime.credentialAuthority;
    // The Catalog refresh controller binds to the Provider Runtime BEFORE
    // Data Plane startup and stays bound for the Backend lifetime (Spec
    // §11.2): stopping the Data Plane never aborts the Catalog. Credential
    // Authority is already bound so the first Catalog publication can derive
    // Provider ON from the real login authority rather than Catalog health.
    await catalogController.bind(providerRuntime.catalog);
    await reconcilePublicModels(catalogController.snapshot());
    const codexHome = resolveCodexHome();
    const codexLocalAuth = createCodexLocalCredentialAuthority({ codexHome });
    const codexDialHost = (host: string): string => {
      const normalized = host.trim().toLowerCase();
      if (
        normalized === "0.0.0.0" ||
        normalized === "::" ||
        normalized === "[::]" ||
        normalized === "localhost"
      ) {
        return "127.0.0.1";
      }
      if (normalized === "::1" || normalized === "[::1]") return "[::1]";
      return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    };
    const codexIntegrationAuthority = createCodexIntegrationAuthority({
      codexHome,
      stateDirectory: join(dirname(options.configPath), "integrations", "codex"),
      endpoint: () => {
        const address = publicModelAuthority.snapshot().endpoint;
        return `http://${codexDialHost(address.host)}:${address.port}/v1`;
      },
      generation: () => publicModelAuthority.snapshot().version,
      nativeCatalog: createCodexNativeCatalogSource({ codexHome }),
      buildCatalog: async (nativeCatalogEntries) => {
        const models = providerRuntime?.models;
        if (models === undefined) {
          throw new Error("LuckyToken model catalog is unavailable");
        }
        return buildCodexCatalog({
          nativeCatalogEntries,
          models,
          aliases: publicModelAuthority
            .snapshot()
            .publishedModels()
            .map((entry) => ({
              alias: entry.alias,
              target: {
                providerId: entry.providerId,
                modelId: entry.modelId,
              },
            })),
        });
      },
    });
    const restoreCodexBeforeShutdown = async (): Promise<void> => {
      await codexIntegrationAuthority.reconcile("shutdown");
    };
    restoreCodexForCleanup = restoreCodexBeforeShutdown;
    // Backend startup is the one automatic Codex apply point. Data Plane
    // listener restarts (for example after a port edit) never resync Codex.
    await codexIntegrationAuthority.reconcile("startup");

    const historyAuthority = createHistoryAuthority({
      sources: {
        ledger: ownedLedgerStore,
        diagnostics: ownedDiagnosticsStore,
        capture: ownedCaptureStore,
      },
      persistence: persistenceAuthority,
      applicationVersion: LUCKYTOKEN_RELEASE_VERSION,
      ownedRoots: [
        resolve(dirname(options.configPath)),
        resolve(config.pi.directory),
        resolve(dirname(config.pi.modelsJson)),
        resolve(
          bindRuntimeDiagnosticsConfiguration(config.runtimeDiagnostics).directory,
        ),
        resolve(bindRequestLedgerConfiguration(config.requestLedger).directory),
        resolve(bindDeepDiagnosticsConfiguration(config.deepDiagnostics).directory),
      ],
      onSourceFailure: (authority, fact) => {
        persistenceAuthority.reportFailure(authority, fact);
      },
    });
    const backupAuthority = createConfiguredBackupAuthority({
      configPath: options.configPath,
      config,
      applicationVersion: LUCKYTOKEN_RELEASE_VERSION,
      snapshots: [
        {
          id: "request-ledger",
          contract: "luckytoken-request-ledger-sqlite",
          version: ownedLedgerStore.schemaVersion,
          category: "history",
          sourcePath: join(
            bindRequestLedgerConfiguration(config.requestLedger).directory,
            "ledger.sqlite3",
          ),
          snapshot: (signal) => ownedLedgerStore.createBackupSnapshot(signal),
        },
        {
          id: "runtime-diagnostics",
          contract: "luckytoken-runtime-diagnostics-sqlite",
          version: ownedDiagnosticsStore.schemaVersion,
          category: "history",
          sourcePath: join(
            bindRuntimeDiagnosticsConfiguration(config.runtimeDiagnostics).directory,
            "diagnostics.sqlite3",
          ),
          snapshot: (signal) => ownedDiagnosticsStore.createBackupSnapshot(signal),
        },
        {
          id: "deep-capture",
          contract: "luckytoken-deep-capture-sqlite",
          version: ownedCaptureStore.schemaVersion,
          category: "capture",
          sourcePath: join(
            bindDeepDiagnosticsConfiguration(config.deepDiagnostics).directory,
            "capture.sqlite3",
          ),
          snapshot: (signal) => ownedCaptureStore.createBackupSnapshot(signal),
        },
      ],
    });

    // The provider readiness already reflects the bound Catalog snapshot
    // (updated by onSnapshot); the supervisor starts with the current
    // coarse status and a stopped Data Plane.
    lastPublishedStatus = Object.freeze({
      modelDataPlane: "stopped",
      provider: lastPublishedStatus.provider,
    });
    const initialPublicEndpoint = publicModelAuthority.snapshot().endpoint;
    let dataPlaneStartedOnce = false;
    supervisor = createDataPlaneRuntimeSupervisor({
      host: initialPublicEndpoint.host,
      port: initialPublicEndpoint.port,
      readProvider: () => lastPublishedStatus.provider,
      resolveAddress: () => publicModelAuthority.snapshot().endpoint,
      startListener: async (address) => {
        const shutdownController = new AbortController();
        try {
          const composition = await createConfiguredLuckyTokenDataPlane({
            config,
            fetch: globalThis.fetch,
            shutdownSignal: shutdownController.signal,
            diagnosticsStore: ownedDiagnosticsStore,
            requestLedgerStore: ownedLedgerStore,
            deepCaptureStore: ownedCaptureStore,
            settingsRegistry,
            providerRuntime,
            publicModelAuthority,
            codexLocalAuth,
            codexNativeModels: codexIntegrationAuthority.nativeModels,
            onCapturePersistenceFailure: (failure) => {
              persistenceAuthority.reportFailure("capture", {
                ...(failure.requestId.length === 0
                  ? {}
                  : { requestId: failure.requestId }),
                code: failure.code,
              });
            },
            onCapturePersistenceRecovery: () => {
              persistenceAuthority.reportRecovery("capture");
            },
          });
          requestIdentities = composition.requestIdentities;
          const server = await startLuckyTokenHttpServer({
            runtime: composition.runtime,
            host: address.host,
            port: address.port,
          });
          dataPlaneStartedOnce = true;
          for (const route of composition.runtime.routes) {
            options.events?.onRoute?.({
              method: route.method,
              origin: server.origin,
              pathname: route.pathname,
            });
          }
          return {
            async close() {
              shutdownController.abort(
                new Error("LuckyToken model gateway is stopping"),
              );
              await server.close();
            },
            async drain(timeoutMs) {
              return server.drain(timeoutMs);
            },
          };
        } catch (error) {
          shutdownController.abort(
            new Error("LuckyToken model gateway startup failed"),
          );
          if (!dataPlaneStartedOnce) {
            try {
              await restoreCodexBeforeShutdown();
            } catch (restoreError) {
              throw new AggregateError(
                [error, restoreError],
                "LuckyToken model gateway startup failed and Codex integration could not be restored",
              );
            }
          }
          throw error;
        }
      },
    });

    const autoStartRegistrar = createAutoStartRegistrar(options);
    const publish = (status: ApplicationStatus): Promise<void> => {
      lastPublishedStatus = status;
      const plane = controlPlane;
      return plane === undefined
        ? Promise.reject(new Error("Control Plane is not ready"))
        : plane.publishStatus(status);
    };
    const basePublicModelsCommandHandler = createPublicModelsControlPlaneHandler(
      publicModelAuthority,
    );
    const publicModelsCommandHandler = async (
      command: Parameters<typeof basePublicModelsCommandHandler>[0],
    ): ReturnType<typeof basePublicModelsCommandHandler> => {
      const previousPort = publicModelAuthority.snapshot().endpoint.port;
      const result = await basePublicModelsCommandHandler(command);
      if (
        command.command === "set_port" &&
        result.outcome === "ok" &&
        result.state.endpoint.port !== previousPort &&
        lastPublishedStatus.modelDataPlane === "running"
      ) {
        await supervisor?.execute("restart", publish);
      }
      return result;
    };

    if (options.ownerKind === "desktop") {
      desktopOwnerLease = createDesktopOwnerLeaseAuthority({
        ttlMs: DESKTOP_OWNER_LEASE_TTL_MS,
        now: Date.now,
        requireInitialClaim: true,
        onExpired: async () => {
          await restoreCodexBeforeShutdown();
          const outcome = await supervisor?.quit({
            timeoutMs: drainTimeoutMs(),
            publishStatus: publish,
          });
          await lifecycle?.finish(outcome ?? "timed_out");
        },
      });
    }

    const cleanup = async (): Promise<void> => {
      cleanupPromise ??= (async () => {
        const failures = await closeOwnedResources();
        if (failures.length > 0) {
          throw new Error("LuckyToken application resource cleanup failed");
        }
      })();
      await cleanupPromise;
    };

    controlPlane = await startControlPlane({
      endpoint,
      application: {
        id: "luckytoken",
        version: LUCKYTOKEN_RELEASE_VERSION,
        ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      },
      initialStatus: supervisor.initialStatus,
      ownership,
      // Provider Activation (Spec v1.0 §14.3): runtime transitions must
      // also update the application's lastPublishedStatus, because the
      // coarse Provider readiness published by Catalog snapshot changes
      // must never resurrect a stale Gateway state. `publish` both keeps
      // the application's authoritative copy in sync and publishes to the
      // Control Plane host (whose publisher parameter is the same host
      // publishStatus), so a transition publishes exactly once.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      runtimeCommandHandler: (command, _publishStatus) => {
        const active = supervisor;
        if (active === undefined) {
          return Promise.resolve({
            outcome: "conflict" as const,
            conflict: {
              code: "runtime_unavailable" as const,
              message: "Runtime lifecycle is not available yet.",
            },
          });
        }
        return active.execute(command, (status) => {
          return publish(status);
        });
      },
      settingsCommandHandler,
      settingsProjection: () => settingsRegistry.snapshot(),
      requestLedger: ownedLedgerStore,
      analyticsHandler: (query) => ownedLedgerStore.analyze(query),
      capture: ownedCaptureStore,
      historyCommandHandler: (command, signal) =>
        historyAuthority.handle(command, signal),
      backupCommandHandler: (command, signal) =>
        backupAuthority.handle(command, signal),
      persistenceProjection: () => persistenceAuthority.projection(),
      attentionProjection: (status) => operationalAttention.project(status),
      requestIdentitiesHandler: () =>
        Promise.resolve({
          records: requestIdentities?.list() ?? Object.freeze([]),
        }),
      modelsCommandHandler: createModelsControlPlaneHandler(modelsAuthority),
      modelsProjection: () => modelsAuthority.snapshot(),
      credentialCommandHandler,
      credentialProjection: () => credentialAuthority?.snapshot(),
      authCommandHandler,
      catalogCommandHandler: async (command) => {
        if (command.command === "query") {
          return { outcome: "ok", snapshot: catalogController.snapshot() };
        }
        if (command.mode === "background") {
          if (!catalogController.isBound()) {
            return {
              outcome: "unavailable",
              snapshot: catalogController.snapshot(),
            };
          }
          catalogController.scheduleBackground("page_open");
          return {
            outcome: "scheduled",
            snapshot: catalogController.snapshot(),
          };
        }
        const refresh = await catalogController.refreshManual();
        return {
          outcome: "ok",
          snapshot: catalogController.snapshot(),
          refresh,
        };
      },
      catalogProjection: () => {
        const snapshot = catalogController.snapshot();
        return Object.freeze({
          version: snapshot.version,
          refreshing: snapshot.providers.some(
            (catalogProvider) => catalogProvider.state === "refreshing",
          ),
          ...(snapshot.refreshedAt === undefined
            ? {}
            : { refreshedAt: snapshot.refreshedAt }),
          failedProviderIds: Object.freeze(
            snapshot.providers
              .filter((catalogProvider) => catalogProvider.state === "failed")
              .map((catalogProvider) => catalogProvider.providerId),
          ),
        });
      },
      publicModelsCommandHandler,
      codexIntegrationCommandHandler: async (command) => {
        const state =
          command.command === "query"
            ? await codexIntegrationAuthority.query()
            : command.command === "sync"
              ? await codexIntegrationAuthority.reconcile("sync")
              : await codexIntegrationAuthority.reconcile(
                  command.enabled ? "enable" : "disable",
                );
        return { state };
      },
      applicationCommandHandler: async (command, publishStatus) => {
        switch (command.command) {
          case "attach":
            return { outcome: "attached" };
          case "desktop_owner":
            return executeDesktopOwnerLeaseCommand(desktopOwnerLease, command);
          case "auto_start": {
            const execution = await executeAutoStart(autoStartRegistrar, command.action);
            return {
              outcome: execution.outcome,
              ...(execution.error === undefined ? {} : { error: execution.error }),
              ...(execution.enabled === undefined
                ? {}
                : { autoStart: { enabled: execution.enabled } }),
            };
          }
          case "quit": {
            try {
              await restoreCodexBeforeShutdown();
            } catch {
              return {
                outcome: "failed",
                error: "Codex integration could not be restored; LuckyToken remains running.",
              };
            }
            const outcome = await supervisor?.quit({
              timeoutMs: drainTimeoutMs(),
              publishStatus,
            });
            return { outcome: outcome ?? "timed_out" };
          }
        }
      },
      onApplicationCommandResultDelivered: (command, result) => {
        if (
          command.command !== "quit" ||
          (result.outcome !== "drained" && result.outcome !== "timed_out")
        ) {
          return;
        }
        const exitReason = result.outcome;
        setImmediate(() => {
          void lifecycle?.finish(exitReason);
        });
      },
      pipeServerFactory: controlPipe.pipeServerFactory,
      access: controlPipe.access,
      diagnostics: ownedDiagnosticsStore,
    });
    publication = await options.discovery.publish(endpoint);

    attentionLedgerSubscription = ownedLedgerStore.subscribe((event) => {
      if (
        event.record.completedAt !== undefined &&
        event.record.outcome !== "success" &&
        event.record.outcome !== "running" &&
        event.record.outcome !== "aborted"
      ) {
        controlPlane?.publishStatus(lastPublishedStatus).catch(() => undefined);
      }
    });
    let attentionRefreshInFlight = false;
    attentionRefreshTimer = setInterval(() => {
      if (attentionRefreshInFlight) return;
      attentionRefreshInFlight = true;
      void (async () => {
        try {
          await credentialAuthority?.query();
          await controlPlane?.publishStatus(lastPublishedStatus);
        } catch {
          // Existing diagnostics surfaces own refresh faults.
        } finally {
          attentionRefreshInFlight = false;
        }
      })();
    }, 60_000);
    attentionRefreshTimer.unref();

    await supervisor.execute("start", publish);
    lifecycle = createLifecycle({
      ownership,
      cleanup,
      drain: async () => {
        await restoreCodexBeforeShutdown();
        return (
          (await supervisor?.quit({
            timeoutMs: drainTimeoutMs(),
            publishStatus: publish,
          })) ?? "timed_out"
        );
      },
      ...(options.events === undefined ? {} : { events: options.events }),
    });
    if (desktopOwnerLease !== undefined) {
      let checkingLease = false;
      desktopOwnerLeaseTimer = setInterval(() => {
        if (checkingLease) return;
        checkingLease = true;
        void desktopOwnerLease
          ?.expireIfNeeded()
          .catch(() => undefined)
          .finally(() => {
            checkingLease = false;
          });
      }, DESKTOP_OWNER_LEASE_CHECK_INTERVAL_MS);
      desktopOwnerLeaseTimer.unref();
    }
    return { kind: "running", application: lifecycle };
  } catch (error) {
    await closeOwnedResources();
    throw error;
  }
}

export async function startLuckyTokenApplication(
  options: StartLuckyTokenApplicationOptions,
): Promise<StartLuckyTokenApplicationResult> {
  const ownerKind = options.ownerKind ?? "cli";
  const configPath = resolve(options.configPath);
  const descriptorPath = resolveControlPlaneDescriptorPath({
    homeDirectory: homedir(),
    ...(options.descriptorOverride === undefined
      ? {}
      : { overridePath: options.descriptorOverride }),
  });
  await mkdir(dirname(descriptorPath), { recursive: true });
  const discovery = createControlPlaneDiscovery({
    path: descriptorPath,
    createTemporaryId: randomUUID,
  });
  const instanceAuthority =
    options.instanceAuthority ??
    createInstanceAuthority({
      path: resolveBackendInstanceDatabasePath({ homeDirectory: homedir() }),
    });

  const arbitration = await acquireInstanceAuthorityOrAttach({
    authority: instanceAuthority,
    discovery,
    events: options.events,
  });
  if (arbitration.kind === "attached") {
    return {
      kind: "attached",
      ...(arbitration.ownership === undefined
        ? {}
        : { ownership: arbitration.ownership }),
    };
  }
  const instanceLease = arbitration.lease;

  try {
    if (options.createFirstRunConfig === true) {
      await createFirstRunConfig(configPath);
    }

    let config: Awaited<ReturnType<typeof loadLuckyTokenCliConfig>>;
    try {
      config = await loadLuckyTokenCliConfig(configPath);
    } catch (error) {
      return await startRecoveryApplication({
        configPath,
        issues: [configCompatibilityIssue(configPath, error)],
        descriptorPath,
        discovery,
        instanceLease,
        ownerKind,
        ...(options.desktopExe === undefined ? {} : { desktopExe: options.desktopExe }),
        ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
        ...(options.events === undefined ? {} : { events: options.events }),
      });
    }

    const compatibilityIssues = await inspectOwnedCompatibility(config);
    if (compatibilityIssues.length > 0) {
      const recoveryBackupAuthority = createConfiguredBackupAuthority({
        configPath,
        config,
        applicationVersion: LUCKYTOKEN_RELEASE_VERSION,
        snapshots: recoveryBackupSnapshots(config),
      });
      return await startRecoveryApplication({
        configPath,
        issues: compatibilityIssues,
        descriptorPath,
        discovery,
        instanceLease,
        backupCommandHandler: (command, signal) =>
          recoveryBackupAuthority.handle(command, signal),
        ownerKind,
        ...(options.desktopExe === undefined ? {} : { desktopExe: options.desktopExe }),
        ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
        ...(options.events === undefined ? {} : { events: options.events }),
      });
    }

    return await startNormalApplication({
      configPath,
      config,
      descriptorPath,
      discovery,
      instanceLease,
      ownerKind,
      ...(options.desktopExe === undefined ? {} : { desktopExe: options.desktopExe }),
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      ...(options.events === undefined ? {} : { events: options.events }),
    });
  } catch (error) {
    await instanceLease.close().catch(() => undefined);
    throw error;
  }
}
