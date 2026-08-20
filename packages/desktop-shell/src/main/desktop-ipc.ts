import type {
  AnalyticsQuery,
  AuthCommand,
  AuthInteractionResponse,
  BackupCreateCommand,
  CatalogCommand,
  CodexIntegrationCommand,
  CredentialCommand,
  HistoryDeleteCommand,
  HistoryExportCommand,
  HistoryRange,
  ModelsCommand,
  PublicModelsCommand,
  RequestLedgerQuery,
  RuntimeCommand,
  RuntimeDiagnosticQuery,
  SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";

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
  const ledgerSubscriptions = new Map<number, () => Promise<void>>();
  const channels = new Set<string>();

  const register = (channel: string, handler: DesktopIpcHandler): void => {
    channels.add(channel);
    registrar.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event.senderId)) {
        throw new Error("Untrusted LuckyToken desktop IPC sender");
      }
      return handler(event, ...args);
    });
  };

  register(desktopIpcChannels.statusGet, () => session.client().getStatus());
  register(desktopIpcChannels.runtime, (_event, ...args) =>
    session.client().executeRuntimeCommand(first<RuntimeCommand>(args)),
  );
  register(desktopIpcChannels.settings, (_event, ...args) =>
    session.client().executeSettingsCommand(first<SettingsCommand>(args)),
  );
  register(desktopIpcChannels.credential, (_event, ...args) =>
    session.client().executeCredentialCommand(first<CredentialCommand>(args)),
  );
  register(desktopIpcChannels.auth, (event, ...args) =>
    session.client().executeAuthCommand(first<AuthCommand>(args), (interaction) => {
      event.send(desktopIpcChannels.authEvent, interaction);
    }),
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
  register(desktopIpcChannels.codex, (_event, ...args) =>
    session.client().executeCodexIntegrationCommand(first<CodexIntegrationCommand>(args)),
  );
  register(desktopIpcChannels.ledgerGet, (_event, ...args) =>
    session.client().getRequestLedger(first<RequestLedgerQuery | undefined>(args)),
  );
  register(desktopIpcChannels.ledgerSubscribe, async (event) => {
    await ledgerSubscriptions.get(event.senderId)?.().catch(() => undefined);
    const stop = await session.client().subscribeRequestLedger((ledgerEvent) => {
      event.send(desktopIpcChannels.ledgerEvent, ledgerEvent);
    });
    ledgerSubscriptions.set(event.senderId, stop);
  });
  register(desktopIpcChannels.ledgerUnsubscribe, async (event) => {
    const stop = ledgerSubscriptions.get(event.senderId);
    ledgerSubscriptions.delete(event.senderId);
    await stop?.();
  });
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
  register(desktopIpcChannels.persistenceAcknowledge, () =>
    session.client().acknowledgePersistence(),
  );
  register(desktopIpcChannels.backup, (_event, ...args) =>
    session.client().executeBackup(first<BackupCreateCommand>(args)),
  );
  register(desktopIpcChannels.backupConfirm, (_event, ...args) =>
    session.client().confirmBackup(first<string>(args)),
  );
  register(desktopIpcChannels.diagnostics, (_event, ...args) =>
    session.client().getDiagnostics(first<RuntimeDiagnosticQuery | undefined>(args)),
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
    const stop = ledgerSubscriptions.get(senderId);
    ledgerSubscriptions.delete(senderId);
    await stop?.().catch(() => undefined);
  };

  return Object.freeze({
    releaseSender,
    async dispose(): Promise<void> {
      await Promise.allSettled(
        [...ledgerSubscriptions.keys()].map((senderId) => releaseSender(senderId)),
      );
      for (const channel of channels) registrar.removeHandler(channel);
      channels.clear();
    },
  });
}
