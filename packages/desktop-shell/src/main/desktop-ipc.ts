import type {
  AnalyticsQuery,
  AuthInteractionResponse,
  BackupCreateCommand,
  CatalogCommand,
  AgentIntegrationsCommand,
  CredentialProfilesCommand,
  HistoryDeleteCommand,
  HistoryExportCommand,
  HistoryRange,
  ModelsCommand,
  PublicModelsCommand,
  ProviderProfileAuthCommand,
  RequestArtifactGetInput,
  RequestJourneyGetInput,
  RequestJourneyQuery,
  RequestJourneySummary,
  RuntimeEventQuery,
  RuntimeEventRecord,
  RuntimeCommand,
  SettingsCommand,
} from "@token/application-control-plane/control-plane";

import type { ControlPlaneSession } from "./control-plane-session.js";
import type { SaveFileOptions } from "../shared/desktop-api.js";
import { desktopIpcChannels } from "../shared/ipc-channels.js";

export interface DesktopIpcEvent {
  readonly senderId: number;
  send(channel: string, payload: unknown): void;
}

export type DesktopIpcHandler = (
  event: DesktopIpcEvent,
  ...args: readonly unknown[]
) => unknown | Promise<unknown>;

export interface DesktopIpcRegistrar {
  handle(channel: string, handler: DesktopIpcHandler): void;
  removeHandler(channel: string): void;
}

export interface DesktopPlatformOperations {
  getAutoStart(): Promise<boolean>;
  setAutoStart(enabled: boolean): Promise<boolean>;
  pickDirectory(): Promise<string | undefined>;
  pickSaveFile(options: SaveFileOptions): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  writeClipboardText(value: string): Promise<void>;
  getDesktopVersion(): Promise<string>;
}

export interface DesktopIpcBridge {
  releaseSender(senderId: number): Promise<void>;
  dispose(): Promise<void>;
}

function first<T>(args: readonly unknown[]): T {
  return args[0] as T;
}

export function registerDesktopIpcHandlers(options: {
  readonly registrar: DesktopIpcRegistrar;
  readonly session: ControlPlaneSession;
  readonly platform: DesktopPlatformOperations;
  readonly isTrustedSender: (senderId: number) => boolean;
}): DesktopIpcBridge {
  const { registrar, session, platform, isTrustedSender } = options;
  interface RendererSubscription {
    readonly event: DesktopIpcEvent;
    generation: number;
    stop: (() => Promise<void>) | undefined;
  }
  const channels = new Set<string>();

  const createSubscriptionRegistry = <T>(
    eventChannel: string,
    subscribe: (listener: (record: T) => void) => Promise<() => Promise<void>>,
  ) => {
    const subscriptions = new Map<number, RendererSubscription>();
    const unbind = async (subscription: RendererSubscription): Promise<void> => {
      subscription.generation += 1;
      const stop = subscription.stop;
      subscription.stop = undefined;
      await stop?.().catch(() => undefined);
    };
    const bind = async (subscription: RendererSubscription): Promise<void> => {
      await unbind(subscription);
      if (session.state().kind !== "ready") return;
      const bindingGeneration = subscription.generation;
      let stop: (() => Promise<void>) | undefined;
      try {
        stop = await subscribe((record) => {
          if (
            subscription.generation === bindingGeneration &&
            session.state().kind === "ready"
          ) {
            subscription.event.send(eventChannel, record);
          }
        });
      } catch {
        return;
      }
      if (subscription.generation !== bindingGeneration) {
        await stop().catch(() => undefined);
        return;
      }
      subscription.stop = stop;
    };
    return Object.freeze({
      async add(event: DesktopIpcEvent): Promise<void> {
        const previous = subscriptions.get(event.senderId);
        if (previous !== undefined) await unbind(previous);
        const subscription: RendererSubscription = {
          event,
          generation: 0,
          stop: undefined,
        };
        subscriptions.set(event.senderId, subscription);
        await bind(subscription);
      },
      async remove(senderId: number): Promise<void> {
        const subscription = subscriptions.get(senderId);
        subscriptions.delete(senderId);
        if (subscription !== undefined) await unbind(subscription);
      },
      backendAvailabilityChanged(available: boolean): void {
        for (const subscription of subscriptions.values()) {
          if (available) void bind(subscription);
          else void unbind(subscription);
        }
      },
      senderIds(): readonly number[] {
        return [...subscriptions.keys()];
      },
    });
  };

  const requestJourneys = createSubscriptionRegistry<RequestJourneySummary>(
    desktopIpcChannels.requestJourneysEvent,
    (listener) => session.client().subscribeRequestJourneys(listener),
  );
  const runtimeEvents = createSubscriptionRegistry<RuntimeEventRecord>(
    desktopIpcChannels.runtimeEventsEvent,
    (listener) => session.client().subscribeRuntimeEvents(listener),
  );

  let backendAvailable = session.state().kind === "ready";
  const unsubscribeSessionState = session.subscribeState((state) => {
    const nextAvailable = state.kind === "ready";
    if (nextAvailable === backendAvailable) return;
    backendAvailable = nextAvailable;
    requestJourneys.backendAvailabilityChanged(backendAvailable);
    runtimeEvents.backendAvailabilityChanged(backendAvailable);
  });

  const register = (channel: string, handler: DesktopIpcHandler): void => {
    channels.add(channel);
    registrar.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event.senderId)) {
        throw new Error("Untrusted Token desktop IPC sender");
      }
      return handler(event, ...args);
    });
  };

  register(desktopIpcChannels.backendStateGet, () => session.state());
  register(desktopIpcChannels.runtime, (_event, ...args) =>
    session.client().executeRuntimeCommand(first<RuntimeCommand>(args)),
  );
  register(desktopIpcChannels.settings, (_event, ...args) =>
    session.client().executeSettingsCommand(first<SettingsCommand>(args)),
  );
  register(desktopIpcChannels.credentialProfiles, (_event, ...args) =>
    session.client().executeCredentialProfilesCommand(
      first<CredentialProfilesCommand>(args),
    ),
  );
  register(desktopIpcChannels.providerProfileAuth, (event, ...args) =>
    session.client().executeProviderProfileAuthCommand(
      first<ProviderProfileAuthCommand>(args),
      (interaction) => {
        event.send(desktopIpcChannels.providerProfileAuthEvent, interaction);
      },
    ),
  );
  register(desktopIpcChannels.authRespond, async (_event, ...args) => {
    await session.client().respondAuthInteraction(first<AuthInteractionResponse>(args));
  });
  register(desktopIpcChannels.models, (_event, ...args) =>
    session.client().executeModelsCommand(first<ModelsCommand>(args)),
  );
  register(desktopIpcChannels.catalog, (_event, ...args) =>
    session.client().executeCatalogCommand(first<CatalogCommand>(args)),
  );
  register(desktopIpcChannels.publicModels, (_event, ...args) =>
    session.client().executePublicModelsCommand(first<PublicModelsCommand>(args)),
  );
  register(desktopIpcChannels.agentIntegrations, (_event, ...args) =>
    session.client().executeAgentIntegrationsCommand(first<AgentIntegrationsCommand>(args)),
  );
  register(desktopIpcChannels.requestJourneysQuery, (_event, ...args) =>
    session.client().queryRequestJourneys(
      first<RequestJourneyQuery | undefined>(args),
    ),
  );
  register(desktopIpcChannels.requestJourneyGet, (_event, ...args) =>
    session.client().getRequestJourney(first<RequestJourneyGetInput>(args)),
  );
  register(desktopIpcChannels.requestArtifactGet, (_event, ...args) =>
    session.client().getRequestArtifact(first<RequestArtifactGetInput>(args)),
  );
  register(desktopIpcChannels.requestJourneysSubscribe, (event) =>
    requestJourneys.add(event),
  );
  register(desktopIpcChannels.requestJourneysUnsubscribe, (event) =>
    requestJourneys.remove(event.senderId),
  );
  register(desktopIpcChannels.runtimeEventsQuery, (_event, ...args) =>
    session.client().queryRuntimeEvents(first<RuntimeEventQuery | undefined>(args)),
  );
  register(desktopIpcChannels.runtimeEventsSubscribe, (event) =>
    runtimeEvents.add(event),
  );
  register(desktopIpcChannels.runtimeEventsUnsubscribe, (event) =>
    runtimeEvents.remove(event.senderId),
  );
  register(desktopIpcChannels.analytics, (_event, ...args) =>
    session.client().getAnalytics(first<AnalyticsQuery>(args)),
  );
  register(desktopIpcChannels.historyQuery, (_event, ...args) =>
    session.client().queryHistory(first<HistoryRange | undefined>(args)),
  );
  register(desktopIpcChannels.historyExport, (_event, ...args) =>
    session.client().executeHistoryExport(first<HistoryExportCommand>(args)),
  );
  register(desktopIpcChannels.historyExportConfirm, (_event, ...args) =>
    session.client().confirmHistoryExport(first<string>(args)),
  );
  register(desktopIpcChannels.historyDelete, (_event, ...args) =>
    session.client().executeHistoryDelete(first<HistoryDeleteCommand>(args)),
  );
  register(desktopIpcChannels.historyDeleteConfirm, (_event, ...args) =>
    session.client().confirmHistoryDelete(first<string>(args)),
  );
  register(desktopIpcChannels.backup, (_event, ...args) =>
    session.client().executeBackup(first<BackupCreateCommand>(args)),
  );
  register(desktopIpcChannels.backupConfirm, (_event, ...args) =>
    session.client().confirmBackup(first<string>(args)),
  );

  register(desktopIpcChannels.autoStartGet, () => platform.getAutoStart());
  register(desktopIpcChannels.autoStartSet, (_event, ...args) => {
    const enabled = first<unknown>(args);
    if (typeof enabled !== "boolean") throw new Error("Invalid auto-start value");
    return platform.setAutoStart(enabled);
  });
  register(desktopIpcChannels.pickDirectory, () => platform.pickDirectory());
  register(desktopIpcChannels.pickSaveFile, (_event, ...args) => {
    const value = first<unknown>(args);
    if (
      typeof value !== "object" ||
      value === null ||
      !("title" in value) ||
      typeof (value as { title?: unknown }).title !== "string"
    ) {
      throw new Error("Invalid save-file options");
    }
    return platform.pickSaveFile(value as SaveFileOptions);
  });
  register(desktopIpcChannels.openExternal, async (_event, ...args) => {
    const url = first<unknown>(args);
    if (typeof url !== "string") throw new Error("Invalid external URL");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Refusing to open a non-http(s) URL");
    }
    await platform.openExternal(url);
  });
  register(desktopIpcChannels.clipboardWrite, async (_event, ...args) => {
    const value = first<unknown>(args);
    if (typeof value !== "string") throw new Error("Invalid clipboard value");
    await platform.writeClipboardText(value);
  });
  register(desktopIpcChannels.desktopVersion, () => platform.getDesktopVersion());

  const releaseSender = async (senderId: number): Promise<void> => {
    await Promise.all([
      requestJourneys.remove(senderId),
      runtimeEvents.remove(senderId),
    ]);
  };

  return Object.freeze({
    releaseSender,
    async dispose(): Promise<void> {
      unsubscribeSessionState();
      const senderIds = new Set([
        ...requestJourneys.senderIds(),
        ...runtimeEvents.senderIds(),
      ]);
      await Promise.allSettled(
        [...senderIds].map((senderId) => releaseSender(senderId)),
      );
      for (const channel of channels) registrar.removeHandler(channel);
      channels.clear();
    },
  });
}
