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
import {
  createClientTokenControlPlaneHandler,
  createProtocolEnablementSettingsHandler,
} from "./client-auth/control-plane.js";
import { createFileClientTokenStore } from "./client-auth/file-token-store.js";
import {
  createLiveClientTokenAuthority,
  type LiveClientTokenAuthority,
} from "./client-auth/live-authority.js";
import { loadLuckyTokenCliConfig } from "./cli-config.js";
import { createConfiguredLuckyTokenDataPlane } from "./composition.js";
import {
  ControlPlaneDescriptorOwnedError,
  publishControlPlaneDescriptor,
  readControlPlaneDescriptor,
  resolveControlPlaneDescriptorPath,
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
import { createAliasControlPlaneHandler } from "./aliases/control-plane.js";
import { createAliasRegistryAuthority } from "./aliases/authority.js";
import { createModelsJsonAuthority } from "./models-config/authority.js";
import { createModelsControlPlaneHandler } from "./models-config/control-plane.js";
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
import { anthropicMessagesProtocolId } from "./protocols/anthropic/handler.js";
import { openaiResponsesProtocolId } from "./protocols/openai-responses/handler.js";
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
import { resolveEffectiveSettings } from "./settings/data-plane.js";
import { createFileSettingsStore } from "./settings/file-store.js";
import { startLuckyTokenHttpServer } from "./server.js";
import { resolveCodexHome } from "./integrations/codex/home.js";
import { createCodexLocalCredentialAuthority } from "./integrations/codex/local-auth.js";
import { createCodexNativeModelSource } from "./integrations/codex/native-models.js";
import { readCodexNativeCatalogEntries } from "./integrations/codex/native-catalog-source.js";
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

async function attachToActiveInstance(
  descriptorPath: string,
  events: LuckyTokenApplicationEvents | undefined,
): Promise<ApplicationOwnership | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const endpoint = await readControlPlaneDescriptor(descriptorPath);
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
        return ownership;
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to attach to the active LuckyToken instance");
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
  readonly descriptorOverride?: string;
  readonly backupCommandHandler?: BackupCommandHandler;
  readonly ownerKind: ApplicationOwnerKind;
  readonly desktopExe?: string;
  readonly buildId?: string;
  readonly events?: LuckyTokenApplicationEvents;
}): Promise<StartLuckyTokenApplicationResult> {
  const descriptorPath = resolveControlPlaneDescriptorPath({
    homeDirectory: homedir(),
    ...(options.descriptorOverride === undefined
      ? {}
      : { overridePath: options.descriptorOverride }),
  });
  await mkdir(dirname(descriptorPath), { recursive: true });
  const endpoint = endpointForCurrentUser(dirname(descriptorPath));
  let descriptor: Awaited<ReturnType<typeof publishControlPlaneDescriptor>> | undefined;

  try {
    descriptor = await publishControlPlaneDescriptor({
      path: descriptorPath,
      endpoint,
      createTemporaryId: randomUUID,
    });
  } catch (error) {
    if (error instanceof ControlPlaneDescriptorOwnedError) {
      const ownership = await attachToActiveInstance(descriptorPath, options.events);
      return { kind: "attached", ...(ownership === undefined ? {} : { ownership }) };
    }
    throw error;
  }

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

  const cleanup = async (): Promise<void> => {
    if (desktopOwnerLeaseTimer !== undefined) {
      clearInterval(desktopOwnerLeaseTimer);
      desktopOwnerLeaseTimer = undefined;
    }
    const results = await Promise.allSettled([
      descriptor?.close() ?? Promise.resolve(),
      controlPlane.close(),
    ]);
    if (results.some((result) => result.status === "rejected")) {
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
  readonly descriptorOverride?: string;
  readonly ownerKind: ApplicationOwnerKind;
  readonly desktopExe?: string;
  readonly buildId?: string;
  readonly events?: LuckyTokenApplicationEvents;
}): Promise<StartLuckyTokenApplicationResult> {
  const { config } = options;
  const descriptorPath = resolveControlPlaneDescriptorPath({
    homeDirectory: homedir(),
    ...(options.descriptorOverride === undefined
      ? {}
      : { overridePath: options.descriptorOverride }),
  });
  await mkdir(dirname(descriptorPath), { recursive: true });
  const endpoint = endpointForCurrentUser(dirname(descriptorPath));

  let descriptor: Awaited<ReturnType<typeof publishControlPlaneDescriptor>> | undefined;
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
  let lastPublishedStatus: ApplicationStatus = Object.freeze({
    modelDataPlane: "stopped",
    provider: "unconfigured",
  });

  try {
    descriptor = await publishControlPlaneDescriptor({
      path: descriptorPath,
      endpoint,
      createTemporaryId: randomUUID,
    });
  } catch (error) {
    if (error instanceof ControlPlaneDescriptorOwnedError) {
      const ownership = await attachToActiveInstance(descriptorPath, options.events);
      return { kind: "attached", ...(ownership === undefined ? {} : { ownership }) };
    }
    throw error;
  }

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
          "server.port": config.server.port,
          "server.bindHost": config.server.host,
          "diagnostics.deepCapture.enabled": config.deepDiagnostics.enabled,
        },
      },
    );
    await settingsRegistry.load();

    // Client Token authorities live for the whole Backend lifetime, not the
    // HTTP Gateway lifetime. This keeps Settings reveal/rotate available
    // while the Router is stopped and lets disposable legacy v1 auth files
    // be replaced with fresh v2 state before requests can be accepted.
    const tokenAuthorities: Record<string, LiveClientTokenAuthority> = {};
    for (const [protocolId, protocol] of Object.entries(config.clientProtocols)) {
      const authority = await createLiveClientTokenAuthority({
        store: createFileClientTokenStore({ path: protocol.authFile }),
      });
      tokenAuthorities[protocolId] = authority;
      const enabledSetting = settingsRegistry.query([
        `protocols.${protocolId}.enabled`,
      ])[`protocols.${protocolId}.enabled`];
      const enabled =
        enabledSetting === undefined ? true : enabledSetting.value !== false;
      if (enabled) await authority.ensureGlobal({ freshOnly: true });
    }
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

    const protocolNames = Object.freeze({
      [anthropicMessagesProtocolId]: "Anthropic Messages",
      [openaiResponsesProtocolId]: "OpenAI Responses",
    });
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
    const clientTokenCommandHandler = createClientTokenControlPlaneHandler({
      authorities: () => tokenAuthorities,
      protocolNames,
      diagnostics: ownedDiagnosticsStore,
    });
    const credentialCommandHandler = createCredentialControlPlaneHandler({
      authority: () => credentialAuthority,
    });
    // Provider Activation (Spec v1.0 §10.2): the Auth handler is wired to
    // the Backend-lifetime Provider Runtime — never to optional slots
    // populated by Data Plane startup.
    const authCommandHandler = createAuthLoginControlPlaneHandler({
      models: () => providerRuntime?.models,
      authority: () => providerRuntime?.credentialAuthority,
      providerSource: (providerId) =>
        providerRuntime?.providerSource(providerId) ?? "user",
    });
    const settingsCommandHandler = createProtocolEnablementSettingsHandler({
      settingsHandler: createSettingsControlPlaneHandler(settingsRegistry),
      authorities: () => tokenAuthorities,
      protocolNames,
      diagnostics: ownedDiagnosticsStore,
    });
    const drainTimeoutMs = (): number => {
      const setting = settingsRegistry.query([
        "application.quitDrainTimeoutMs",
      ])["application.quitDrainTimeoutMs"];
      if (setting === undefined) return 5000;
      const value = Number(setting.value);
      return Number.isSafeInteger(value) && value >= 0 ? value : 5000;
    };

    const aliasAuthorityHolder: {
      current?: ReturnType<typeof createAliasRegistryAuthority>;
    } = {};
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
        aliasAuthorityHolder.current?.onCatalogSnapshot();
        controlPlane?.publishStatus(lastPublishedStatus).catch(() => undefined);
      },
    });
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
    // The Catalog refresh controller binds to the Provider Runtime BEFORE
    // Data Plane startup and stays bound for the Backend lifetime (Spec
    // §11.2): stopping the Data Plane never aborts the Catalog.
    await catalogController.bind(providerRuntime.catalog);
    credentialAuthority = providerRuntime.credentialAuthority;
    const aliasAuthority = createAliasRegistryAuthority({
      path: join(dirname(config.pi.modelsJson), "model-aliases.json"),
      catalogFacts: () => {
        const snapshot = catalogController.snapshot();
        const knownTargets = new Set<string>();
        const targets: { readonly provider: string; readonly model: string }[] =
          [];
        for (const catalogProvider of snapshot.providers) {
          for (const model of catalogProvider.models) {
            knownTargets.add(`${catalogProvider.providerId}\u0000${model.id}`);
            targets.push({
              provider: catalogProvider.providerId,
              model: model.id,
            });
          }
        }
        return {
          catalogVersion: snapshot.version,
          targets: Object.freeze(targets),
          knownTargets,
        };
      },
    });
    aliasAuthorityHolder.current = aliasAuthority;

    const codexLocalAuth = createCodexLocalCredentialAuthority({
      codexHome: resolveCodexHome(),
    });
    const codexNativeModels = createCodexNativeModelSource();
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
      codexHome: resolveCodexHome(),
      stateDirectory: join(dirname(options.configPath), "integrations", "codex"),
      endpoint: () => {
        if (lastPublishedStatus.modelDataPlane !== "running") return undefined;
        const address = resolveEffectiveSettings(settingsRegistry.query([]));
        return `http://${codexDialHost(address.host)}:${address.port}/v1`;
      },
      localAuthAvailable: () => codexLocalAuth.isAvailable(),
      buildCatalog: async () => {
        const models = providerRuntime?.models;
        if (models === undefined) {
          throw new Error(
            "LuckyToken model catalog is unavailable",
          );
        }
        await aliasAuthority.query();
        return buildCodexCatalog({
          nativeModels: codexNativeModels.models(),
          nativeCatalogEntries: await readCodexNativeCatalogEntries(resolveCodexHome()),
          models,
          aliases: aliasAuthority.resolver().entries(),
        });
      },
    });

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
    supervisor = createDataPlaneRuntimeSupervisor({
      host: config.server.host,
      port: config.server.port,
      readProvider: () => lastPublishedStatus.provider,
      resolveAddress: () => resolveEffectiveSettings(settingsRegistry.query([])),
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
            clientTokenAuthorities: tokenAuthorities,
            providerRuntime,
            aliasAuthority,
            codexLocalAuth,
            codexNativeModels,
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

    if (options.ownerKind === "desktop") {
      desktopOwnerLease = createDesktopOwnerLeaseAuthority({
        ttlMs: DESKTOP_OWNER_LEASE_TTL_MS,
        now: Date.now,
        requireInitialClaim: true,
        onExpired: async () => {
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
        if (attentionRefreshTimer !== undefined) {
          clearInterval(attentionRefreshTimer);
          attentionRefreshTimer = undefined;
        }
        if (desktopOwnerLeaseTimer !== undefined) {
          clearInterval(desktopOwnerLeaseTimer);
          desktopOwnerLeaseTimer = undefined;
        }
        attentionLedgerSubscription?.unsubscribe();
        attentionLedgerSubscription = undefined;
        if (supervisor !== undefined) {
          await supervisor
            .execute(
              "stop",
              (status) => controlPlane?.publishStatus(status) ?? Promise.resolve(),
            )
            .catch(() => undefined);
        }
        const results = await Promise.allSettled([
          descriptor?.close() ?? Promise.resolve(),
          controlPlane?.close() ?? Promise.resolve(),
          diagnosticsStore?.close() ?? Promise.resolve(),
          requestLedgerStore?.close() ?? Promise.resolve(),
          deepCaptureStore?.close() ?? Promise.resolve(),
        ]);
        catalogController.dispose();
        if (results.some((result) => result.status === "rejected")) {
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
      clientTokenCommandHandler,
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
      aliasCommandHandler: createAliasControlPlaneHandler(aliasAuthority),
      aliasesProjection: () => aliasAuthority.snapshot(),
      codexIntegrationCommandHandler: async (command) => {
        const state =
          command.command === "query"
            ? await codexIntegrationAuthority.query()
            : command.command === "sync_catalog"
              ? await codexIntegrationAuthority.syncCatalog()
              : await codexIntegrationAuthority.setEnabled(command.enabled);
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
      drain: async () =>
        (await supervisor?.quit({
          timeoutMs: drainTimeoutMs(),
          publishStatus: publish,
        })) ?? "timed_out",
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
    await Promise.allSettled([
      descriptor?.close() ?? Promise.resolve(),
      controlPlane?.close() ?? Promise.resolve(),
      diagnosticsStore?.close() ?? Promise.resolve(),
      requestLedgerStore?.close() ?? Promise.resolve(),
      deepCaptureStore?.close() ?? Promise.resolve(),
    ]);
    throw error;
  }
}

export async function startLuckyTokenApplication(
  options: StartLuckyTokenApplicationOptions,
): Promise<StartLuckyTokenApplicationResult> {
  const ownerKind = options.ownerKind ?? "cli";
  const configPath = resolve(options.configPath);
  if (options.createFirstRunConfig === true) {
    await createFirstRunConfig(configPath);
  }

  let config: Awaited<ReturnType<typeof loadLuckyTokenCliConfig>>;
  try {
    config = await loadLuckyTokenCliConfig(configPath);
  } catch (error) {
    return startRecoveryApplication({
      configPath,
      issues: [configCompatibilityIssue(configPath, error)],
      ...(options.descriptorOverride === undefined
        ? {}
        : { descriptorOverride: options.descriptorOverride }),
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
    return startRecoveryApplication({
      configPath,
      issues: compatibilityIssues,
      ...(options.descriptorOverride === undefined
        ? {}
        : { descriptorOverride: options.descriptorOverride }),
      backupCommandHandler: (command, signal) =>
        recoveryBackupAuthority.handle(command, signal),
      ownerKind,
      ...(options.desktopExe === undefined ? {} : { desktopExe: options.desktopExe }),
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      ...(options.events === undefined ? {} : { events: options.events }),
    });
  }

  return startNormalApplication({
    configPath,
    config,
    ...(options.descriptorOverride === undefined
      ? {}
      : { descriptorOverride: options.descriptorOverride }),
    ownerKind,
    ...(options.desktopExe === undefined ? {} : { desktopExe: options.desktopExe }),
    ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
    ...(options.events === undefined ? {} : { events: options.events }),
  });
}
