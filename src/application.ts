import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  type RequestJourneySummary,
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
import { createCredentialProfilesControlPlaneHandlers } from "./credentials/profile-control-plane.js";
import {
  createDiagnosticsAuthority,
  createUnavailableDiagnosticsAuthority,
  type DiagnosticsConfiguration,
  type DiagnosticsManagementAuthority,
} from "./diagnostics/index.js";
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
import { createCatalogCacheStore } from "./providers/catalog-cache.js";
import { createCatalogRefreshController } from "./providers/catalog-refresh.js";
import { composeEffectiveCatalog } from "./providers/effective-composition.js";
import { createProviderRuntime } from "./providers/runtime.js";
import { providerReadiness } from "./providers/readiness.js";
import { createDataPlaneRuntimeSupervisor } from "./runtime-supervisor.js";
import { createSettingsRegistry } from "./settings/catalog.js";
import { createSettingsControlPlaneHandler } from "./settings/control-plane.js";
import { DATA_PLANE_LOOPBACK_HOST } from "./settings/data-plane.js";
import { createFileSettingsStore } from "./settings/file-store.js";
import { startRunningDataPlaneListener } from "./running-data-plane-listener.js";
import { resolveCodexHome } from "./integrations/codex/home.js";
import { createCodexNativeCatalogSource } from "./integrations/codex/native-catalog-source.js";
import { buildCodexCatalog } from "./integrations/codex/catalog.js";
import {
  createCodexCatalogValidator,
  type CodexCatalogValidator,
} from "./integrations/codex/catalog-validator.js";
import { createCodexIntegrationAuthority } from "./integrations/codex/integration.js";
import { createAgentInjectionSnapshot } from "./integrations/agents/snapshot.js";
import { createAgentIntegrationCoordinator } from "./integrations/agents/coordinator.js";
import { createPiIntegrationAdapter } from "./integrations/pi/adapter.js";
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

export interface DiagnosticsAuthorityFactoryInput {
  readonly configuration: DiagnosticsConfiguration;
  readonly runtimeId: string;
}

export type DiagnosticsAuthorityFactory = (
  input: DiagnosticsAuthorityFactoryInput,
) => Promise<DiagnosticsManagementAuthority>;

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
  /** Internal process-boundary test seam. Production always validates with
   * an installed Codex CLI before publishing integration files. */
  readonly codexCatalogValidator?: CodexCatalogValidator;
  /** @internal Backend-lifetime diagnostics construction seam for tests. */
  readonly diagnosticsAuthorityFactory?: DiagnosticsAuthorityFactory;
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
    : new Error("Active Token Backend is not management-ready yet");
}

function createAutoStartRegistrar(options: {
  readonly ownerKind: ApplicationOwnerKind;
  readonly configPath: string;
  readonly desktopExe?: string;
}): AutoStartRegistrar {
  if (process.platform !== "win32") return createUnsupportedAutoStartRegistrar();
  return createWindowsAutoStartRegistrar({
    name: "Token",
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
  readonly codexCatalogValidator?: CodexCatalogValidator;
  readonly diagnosticsAuthorityFactory?: DiagnosticsAuthorityFactory;
}): Promise<StartLuckyTokenApplicationResult> {
  const { config } = options;
  const endpoint = endpointForCurrentUser(dirname(options.descriptorPath));

  let publication: DiscoveryPublication | undefined;
  let supervisor: Awaited<ReturnType<typeof createDataPlaneRuntimeSupervisor>> | undefined;
  let controlPlane: Awaited<ReturnType<typeof startControlPlane>> | undefined;
  let diagnosticsAuthority: DiagnosticsManagementAuthority | undefined;
  let attentionDiagnosticsSubscription:
    | { readonly unsubscribe: () => void }
    | undefined;
  let profileUsageDiagnosticsSubscription:
    | { readonly unsubscribe: () => void }
    | undefined;
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
  let restoreAgentsForCleanup: (() => Promise<void>) | undefined;
  const recentRequestFailures: number[] = [];
  let lastPublishedStatus: ApplicationStatus = Object.freeze({
    modelDataPlane: "stopped",
    provider: "unconfigured",
    activeRequests: 0,
  });
  let activeRequestCount = 0;

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
      attentionDiagnosticsSubscription?.unsubscribe();
    } catch (error) {
      failures.push(error);
    }
    attentionDiagnosticsSubscription = undefined;
    try {
      profileUsageDiagnosticsSubscription?.unsubscribe();
    } catch (error) {
      failures.push(error);
    }
    profileUsageDiagnosticsSubscription = undefined;
    await restoreAgentsForCleanup?.().catch((error: unknown) => failures.push(error));
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
    await publicModelAuthorityForCleanup
      ?.flush()
      .catch((error: unknown) => failures.push(error));
    await diagnosticsAuthority
      ?.close()
      .catch((error: unknown) => failures.push(error));
    diagnosticsAuthority = undefined;
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
    const diagnosticsFactory =
      options.diagnosticsAuthorityFactory ??
      ((input: DiagnosticsAuthorityFactoryInput) =>
        createDiagnosticsAuthority(input));
    try {
      diagnosticsAuthority = await diagnosticsFactory({
        configuration: config.diagnostics,
        runtimeId: randomUUID(),
      });
    } catch {
      diagnosticsAuthority = createUnavailableDiagnosticsAuthority();
    }
    const ownedDiagnosticsAuthority = diagnosticsAuthority;
    const credentialUsageById = new Map<
      string,
      {
        readonly credentialId: string;
        readonly lastUsedAt: number;
        readonly lastSucceededAt?: number;
      }
    >();
    const observeCredentialUsage = (
      record: RequestJourneySummary,
    ): void => {
      if (record.profileId === undefined || record.closedAt === undefined) return;
      const current = credentialUsageById.get(record.profileId);
      const lastUsedAt = Math.max(current?.lastUsedAt ?? 0, record.closedAt);
      const succeededAt = record.outcome === "success" ? record.closedAt : undefined;
      const lastSucceededAt = Math.max(
        current?.lastSucceededAt ?? 0,
        succeededAt ?? 0,
      );
      credentialUsageById.set(record.profileId, {
        credentialId: record.profileId,
        lastUsedAt,
        ...(lastSucceededAt === 0 ? {} : { lastSucceededAt }),
      });
    };
    try {
      let afterId: number | undefined;
      for (;;) {
        const page = await ownedDiagnosticsAuthority.queryRequestJourneys({
          limit: 1_000,
          ...(afterId === undefined ? {} : { afterId }),
        });
        for (const record of page.records) observeCredentialUsage(record);
        const newestId = page.records.at(-1)?.id;
        if (!page.hasMore || newestId === undefined) break;
        afterId = newestId;
      }
    } catch {
      // Profile usage is a fail-open diagnostic projection only.
    }
    profileUsageDiagnosticsSubscription =
      ownedDiagnosticsAuthority.subscribeRequestJourneys(observeCredentialUsage);
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
    type PublicModelCatalogSnapshot = Parameters<
      typeof publicModelRuntimeFacts
    >[0];
    let reconcilePublicModelsNow: (
      snapshot: PublicModelCatalogSnapshot,
    ) => Promise<void> = () => Promise.resolve();
    let publicModelReconciliation = Promise.resolve();
    const reconcilePublicModels = (
      snapshot: PublicModelCatalogSnapshot,
    ): Promise<void> => {
      const scheduled = publicModelReconciliation
        .catch(() => undefined)
        .then(() => reconcilePublicModelsNow(snapshot));
      publicModelReconciliation = scheduled;
      return scheduled;
    };
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
      diagnostics: ownedDiagnosticsAuthority,
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
        void reconcilePublicModels(snapshot)
          .then(() => controlPlane?.publishStatus(lastPublishedStatus))
          .catch(() => undefined);
      },
    });
    catalogControllerForCleanup = catalogController;
    // Provider Activation (Spec v1.0 §6, §11.2): the Backend-lifetime
    // Provider Runtime is created BEFORE the Data Plane Supervisor and
    // before the Control Plane starts. Provider discovery, Profile state,
    // login, and the authoritative Catalog live for the whole Backend
    // lifetime; Data Plane stop/start/restart never recreates them.
    const providerRuntime = await createProviderRuntime({
      piDirectory: config.pi.directory,
      modelsJsonPath: config.pi.modelsJson,
      userProviderPackages: config.providerPackages,
      fetch: globalThis.fetch,
      modelsStore: catalogCacheStore,
      onInvalidModelsJson: () => {
        ownedDiagnosticsAuthority.observeRuntime({
          level: "warning",
          classification: "provider_models_json_invalid",
          safeMessage:
            "models.json is not loadable; Provider composition keeps compatible built-in Providers until the file is fixed.",
        });
      },
      onCredentialStoreDegraded: () => {
        ownedDiagnosticsAuthority.observeRuntime({
          level: "warning",
          classification: "provider_credential_lock_release_degraded",
          safeMessage:
            "Provider credential storage lock release was degraded after a completed operation.",
        });
      },
      credentialUsage: (credentialIds) =>
        credentialIds.flatMap((credentialId) => {
          const usage = credentialUsageById.get(credentialId);
          return usage === undefined ? [] : [usage];
        }),
    });
    const credentialManagement = providerRuntime.credentialManagement;
    reconcilePublicModelsNow = (
      snapshot: PublicModelCatalogSnapshot,
    ): Promise<void> =>
      publicModelAuthority
        .reconcile(
          publicModelRuntimeFacts(snapshot, credentialManagement.snapshot()),
        )
        .then(() => undefined);
    const operationalAttention = createOperationalAttentionAuthority({
      now: Date.now,
      credentials: () => credentialManagement.snapshot(),
      diagnosticsAvailable: () => ownedDiagnosticsAuthority.diagnosticsAvailable(),
      requestFailureCount: (from, to) =>
        recentRequestFailures.filter((time) => time >= from && time < to).length,
    });
    const profileControlPlane = createCredentialProfilesControlPlaneHandlers({
      models: providerRuntime.models,
      management: credentialManagement,
      binding: providerRuntime.providerAuthBindings,
      providerSource: (providerId) => providerRuntime.providerSource(providerId),
      recheckProvider: async (providerId, capture) => {
        const report = await catalogController.refreshProviderManual(
          providerId,
          undefined,
          providerRuntime.catalogOperationsFor(capture),
        );
        return report.providers.find(
          (provider) => provider.providerId === providerId,
        )?.outcome ?? "skipped";
      },
      postLoginProvider: (providerId, capture) => {
        catalogController.scheduleProviderBackground(
          "login",
          providerId,
          providerRuntime.catalogOperationsFor(capture),
        );
      },
    });
    const credentialProfilesCommandHandler: typeof profileControlPlane.credentials = async (
      command,
    ) => {
      const result = await profileControlPlane.credentials(command);
      if (result.outcome !== "unavailable") {
        await reconcilePublicModels(catalogController.snapshot());
      }
      return result;
    };
    const providerProfileAuthCommandHandler = profileControlPlane.auth;
    // The Catalog refresh controller binds to the Provider Runtime BEFORE
    // Data Plane startup and stays bound for the Backend lifetime (Spec
    // §11.2): stopping the Data Plane never aborts the Catalog. Profile state
    // is already bound so the first Catalog publication can derive Provider
    // ON from the real login authority rather than Catalog health.
    await catalogController.bind(providerRuntime.catalog);
    await reconcilePublicModels(catalogController.snapshot());
    const codexHome = resolveCodexHome();
    const publicModels = Object.freeze({
      requestSnapshot: async () => publicModelAuthority.snapshot(),
    });
    const isProtocolEnabled = (protocolId: string): boolean => {
      const setting = settingsRegistry.query([
        `protocols.${protocolId}.enabled`,
      ])[`protocols.${protocolId}.enabled`];
      return setting?.value !== false;
    };
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
    const agentSnapshot = async () =>
      createAgentInjectionSnapshot({
        publicModels: publicModelAuthority.snapshot(),
        models: providerRuntime.models,
      });
    const codexNativeCatalog = createCodexNativeCatalogSource({ codexHome });
    const codexIntegrationAuthority = createCodexIntegrationAuthority({
      codexHome,
      stateDirectory: join(dirname(options.configPath), "integrations", "codex"),
      endpoint: () => {
        const address = publicModelAuthority.snapshot().endpoint;
        return `http://${codexDialHost(address.host)}:${address.port}/v1`;
      },
      generation: () => publicModelAuthority.snapshot().version,
      nativeCatalog: codexNativeCatalog,
      validateCatalog:
        options.codexCatalogValidator?.validate ??
        createCodexCatalogValidator({ codexHome }).validate,
      buildCatalog: async (nativeCatalogEntries, scope) => {
        const snapshot = await agentSnapshot();
        return buildCodexCatalog({
          nativeCatalogEntries,
          models: providerRuntime.models,
          aliases: snapshot[scope].map((entry) => ({
              alias: entry.alias,
              target: entry.target,
            })),
        });
      },
      projectionFingerprint: async (snapshot, scope) => {
        const native = await codexNativeCatalog.load();
        if (native.source === "unavailable") {
          return createHash("sha256")
            .update(`codex-unavailable:${scope}`)
            .digest("hex");
        }
        const catalog = buildCodexCatalog({
          nativeCatalogEntries: native.entries,
          models: providerRuntime.models,
          aliases: snapshot[scope].map((entry) => ({
            alias: entry.alias,
            target: entry.target,
          })),
        });
        const actualOutput = catalog.injectedModelCount === 0
          ? { kind: "empty" }
          : {
              endpoint: snapshot.endpoint.openaiBaseUrl,
              catalog: catalog.content,
            };
        return createHash("sha256")
          .update(JSON.stringify(actualOutput))
          .digest("hex");
      },
      restoreTarget: () => {
        const configured = settingsRegistry.query([
          "integrations.codex.preimage.modelProvider",
          "integrations.codex.preimage.openaiBaseUrl",
          "integrations.codex.preimage.modelCatalogJson",
        ]);
        const value = (key: string): string | null => {
          const candidate = configured[key]?.value;
          return typeof candidate === "string" ? candidate : null;
        };
        return Object.freeze({
          modelProvider: value("integrations.codex.preimage.modelProvider"),
          openaiBaseUrl: value("integrations.codex.preimage.openaiBaseUrl"),
          modelCatalogJson: value("integrations.codex.preimage.modelCatalogJson"),
        });
      },
    });
    const piAgentDirectoryOverride = process.env.PI_CODING_AGENT_DIR?.trim();
    const piIntegrationAdapter = createPiIntegrationAdapter({
      agentDirectory:
        piAgentDirectoryOverride === undefined || piAgentDirectoryOverride.length === 0
          ? join(homedir(), ".pi", "agent")
          : resolve(piAgentDirectoryOverride),
      stateDirectory: join(dirname(options.configPath), "integrations", "pi"),
    });
    const previousCodexState = await codexIntegrationAuthority.query();
    const agentIntegrations = createAgentIntegrationCoordinator({
      stateDirectory: join(dirname(options.configPath), "integrations"),
      snapshot: agentSnapshot,
      adapters: [codexIntegrationAuthority, piIntegrationAdapter],
      defaults: {
        codex: {
          enabled: previousCodexState.desiredEnabled,
          scope: previousCodexState.scope,
        },
        pi: { enabled: false, scope: "favorite" },
      },
    });
    const restoreAgentsBeforeShutdown = async (): Promise<void> => {
      await agentIntegrations.shutdown();
    };
    restoreAgentsForCleanup = restoreAgentsBeforeShutdown;

    const diagnosticsManagement = ownedDiagnosticsAuthority;
    const historyAuthority = createHistoryAuthority({
      diagnostics: diagnosticsManagement,
      applicationVersion: LUCKYTOKEN_RELEASE_VERSION,
      ownedRoots: [
        resolve(dirname(options.configPath)),
        resolve(config.pi.directory),
        resolve(dirname(config.pi.modelsJson)),
        resolve(config.diagnostics.directory),
      ],
    });
    const backupAuthority = createConfiguredBackupAuthority({
      configPath: options.configPath,
      config,
      applicationVersion: LUCKYTOKEN_RELEASE_VERSION,
      snapshots: Object.freeze([
        {
          id: "request-diagnostics",
          contract: "luckytoken-diagnostics-sqlite",
          version: 1,
          category: "history" as const,
          sourcePath: join(config.diagnostics.directory, "diagnostics-v2.sqlite3"),
          snapshot: (signal: AbortSignal) =>
            diagnosticsManagement.createBackupSnapshot(signal),
        },
      ]),
    });

    // The provider readiness already reflects the bound Catalog snapshot
    // (updated by onSnapshot); the supervisor starts with the current
    // coarse status and a stopped Data Plane.
    lastPublishedStatus = Object.freeze({
      modelDataPlane: "stopped",
      provider: lastPublishedStatus.provider,
      activeRequests: activeRequestCount,
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
        let composition:
          | Awaited<ReturnType<typeof createConfiguredLuckyTokenDataPlane>>
          | undefined;
        try {
          composition = await createConfiguredLuckyTokenDataPlane({
            configuration: config,
            models: providerRuntime.models,
            providerAuthBindings: providerRuntime.providerAuthBindings,
            publicModels,
            diagnostics: ownedDiagnosticsAuthority,
            isProtocolEnabled,
            fetch: globalThis.fetch,
            shutdownSignal: shutdownController.signal,
            codexNativeModels: codexIntegrationAuthority.nativeModels,
          });
          const listener = await startRunningDataPlaneListener({
            dataPlane: composition,
            host: address.host,
            port: address.port,
            shutdownController,
            diagnostics: ownedDiagnosticsAuthority,
            onActiveRequestCountChanged: (count) => {
              if (count === activeRequestCount) return;
              activeRequestCount = count;
              const nextStatus = Object.freeze({
                ...lastPublishedStatus,
                activeRequests: count,
              });
              lastPublishedStatus = nextStatus;
              void controlPlane?.publishStatus(nextStatus).catch(() => undefined);
            },
          });
          dataPlaneStartedOnce = true;
          for (const route of composition.runtime.routes) {
            options.events?.onRoute?.({
              method: route.method,
              origin: listener.origin,
              pathname: route.pathname,
            });
          }
          return listener;
        } catch (error) {
          shutdownController.abort(
            new Error("LuckyToken model gateway startup failed"),
          );
          let startupError = error;
          if (composition !== undefined) {
            try {
              await composition.close();
            } catch (closeError) {
              startupError = new AggregateError(
                [startupError, closeError],
                "LuckyToken model gateway startup failed and its Data Plane could not be finalized",
              );
            }
          }
          if (!dataPlaneStartedOnce) {
            try {
              await restoreAgentsBeforeShutdown();
            } catch (restoreError) {
              throw new AggregateError(
                [startupError, restoreError],
                "LuckyToken model gateway startup failed and Agent integrations could not be restored",
              );
            }
          }
          throw startupError;
        }
      },
    });

    const autoStartRegistrar = createAutoStartRegistrar(options);
    const publish = (status: ApplicationStatus): Promise<void> => {
      const nextStatus = Object.freeze({
        ...status,
        activeRequests: activeRequestCount,
      });
      lastPublishedStatus = nextStatus;
      const plane = controlPlane;
      return plane === undefined
        ? Promise.reject(new Error("Control Plane is not ready"))
        : plane.publishStatus(nextStatus);
    };
    const basePublicModelsCommandHandler = createPublicModelsControlPlaneHandler(
      publicModelAuthority,
    );
    const publicModelsCommandHandler = async (
      command: Parameters<typeof basePublicModelsCommandHandler>[0],
    ): ReturnType<typeof basePublicModelsCommandHandler> => {
      await reconcilePublicModels(catalogController.snapshot());
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
          await restoreAgentsBeforeShutdown();
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
      initialStatus: Object.freeze({
        ...supervisor.initialStatus,
        activeRequests: activeRequestCount,
      }),
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
      diagnostics: ownedDiagnosticsAuthority,
      ...(diagnosticsManagement.getAnalytics === undefined
        ? {}
        : {
            analyticsHandler: (query) =>
              diagnosticsManagement.getAnalytics!(query),
          }),
      ...(historyAuthority === undefined
        ? {}
        : {
            historyCommandHandler: (command, signal) =>
              historyAuthority.handle(command, signal),
          }),
      backupCommandHandler: (command, signal) =>
        backupAuthority.handle(command, signal),
      attentionProjection: (status) => operationalAttention.project(status),
      modelsCommandHandler: createModelsControlPlaneHandler(modelsAuthority),
      modelsProjection: () => modelsAuthority.snapshot(),
      credentialProfilesCommandHandler,
      credentialProfilesProjection: () => credentialManagement.snapshot(),
      providerProfileAuthCommandHandler,
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
      agentIntegrationsCommandHandler: async (command) => {
        const injectsAgents =
          command.command === "sync" ||
          (command.command === "set_enabled" && command.enabled);
        if (injectsAgents && lastPublishedStatus.modelDataPlane !== "running") {
          const state = await agentIntegrations.query();
          const targetIds = command.command === "set_enabled"
            ? [command.agentId]
            : state.agents
                .filter((agent) => agent.enabled)
                .map((agent) => agent.agentId);
          return {
            outcome: "failed" as const,
            state,
            results: Object.freeze(
              targetIds.map((agentId) => Object.freeze({
                agentId,
                outcome: "failed" as const,
                effect: Object.freeze({
                  observedState: "unavailable" as const,
                  modelCount: 0,
                  warnings: Object.freeze([]),
                  changed: false,
                  message:
                    "Start the Data Plane before syncing Agent integrations. No Agent files were changed.",
                }),
              })),
            ),
          };
        }
        switch (command.command) {
          case "query":
            return {
              outcome: "ok" as const,
              state: await agentIntegrations.query(),
              results: Object.freeze([]),
            };
          case "sync":
            return agentIntegrations.sync();
          case "set_enabled":
            return agentIntegrations.setEnabled(command.agentId, command.enabled);
          case "set_scope":
            return agentIntegrations.setScope(command.agentId, command.scope);
        }
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
              await restoreAgentsBeforeShutdown();
            } catch {
              return {
                outcome: "failed",
                error: "Agent integrations could not be restored; LuckyToken remains running.",
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
    });
    publication = await options.discovery.publish(endpoint);

    attentionDiagnosticsSubscription =
      ownedDiagnosticsAuthority.subscribeRequestJourneys((record) => {
        if (
          record.closedAt !== undefined &&
          (record.outcome === "failed" || record.outcome === "interrupted")
        ) {
          recentRequestFailures.push(record.closedAt);
          if (recentRequestFailures.length > 1_000) {
            recentRequestFailures.splice(
              0,
              recentRequestFailures.length - 1_000,
            );
          }
          controlPlane?.publishStatus(lastPublishedStatus).catch(() => undefined);
        }
      });
    let attentionRefreshInFlight = false;
    attentionRefreshTimer = setInterval(() => {
      if (attentionRefreshInFlight) return;
      attentionRefreshInFlight = true;
      void (async () => {
        try {
          await credentialManagement.query();
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
    // Backend startup is the automatic apply point for enabled Agent integrations.
    // Data Plane listener restarts never resync external Agent files.
    if (lastPublishedStatus.modelDataPlane === "running") {
      await agentIntegrations.startup();
    }
    lifecycle = createLifecycle({
      ownership,
      cleanup,
      drain: async () => {
        await restoreAgentsBeforeShutdown();
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
      ...(options.codexCatalogValidator === undefined
        ? {}
        : { codexCatalogValidator: options.codexCatalogValidator }),
      ...(options.diagnosticsAuthorityFactory === undefined
        ? {}
        : { diagnosticsAuthorityFactory: options.diagnosticsAuthorityFactory }),
    });
  } catch (error) {
    await instanceLease.close().catch(() => undefined);
    throw error;
  }
}
