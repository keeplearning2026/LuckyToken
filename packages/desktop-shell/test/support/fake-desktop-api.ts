import type {
  DesktopControlPlaneApi,
  DesktopPlatformApi,
  TokenDesktopApi,
} from "../../src/shared/desktop-api.js";

const unavailable = async (): Promise<never> => {
  throw new Error("Fake Token Desktop API operation is not configured");
};

type LegacyAliasCommand =
  | { readonly command: "query" }
  | {
      readonly command: "rename_model" | "restore_model_name";
      readonly revision: number;
      readonly providerId: string;
      readonly modelId: string;
      readonly modelName?: string;
    };

interface LegacyAliasResult {
  readonly outcome: "ok" | "conflict" | "invalid" | "storage_failure";
  readonly state: {
    readonly revision: number;
    readonly catalogVersion: number;
    readonly effective?: {
      readonly aliases: readonly {
        readonly alias: string;
        readonly target: { readonly provider: string; readonly model: string };
      }[];
    };
  };
}

type FakeControlOverrides = Partial<DesktopControlPlaneApi> & {
  readonly executeAliases?: (command: LegacyAliasCommand) => Promise<LegacyAliasResult>;
};

export function createFakeDesktopApi(options: {
  readonly control?: FakeControlOverrides;
  readonly platform?: Partial<DesktopPlatformApi>;
} = {}): TokenDesktopApi {
  const { executeAliases, ...controlOverrides } = options.control ?? {};
  const legacyPublicModels: DesktopControlPlaneApi["executePublicModels"] = async (command) => {
    if (executeAliases === undefined) return unavailable();
    const aliasCommand =
      command.command === "rename_model" || command.command === "restore_model_name"
        ? command
        : { command: "query" as const };
    const aliases = await executeAliases(aliasCommand);
    const byProvider = new Map<
      string,
      Array<{ alias: string; target: string; on: boolean; favorite: boolean }>
    >();
    for (const entry of aliases.state.effective?.aliases ?? []) {
      const rows = byProvider.get(entry.target.provider) ?? [];
      rows.push({
        alias: entry.alias,
        target: entry.target.model,
        on: true,
        favorite: false,
      });
      byProvider.set(entry.target.provider, rows);
    }
    return {
      outcome: aliases.outcome === "ok" ? "ok" : "conflict",
      state: {
        revision: aliases.state.revision,
        version: aliases.state.catalogVersion,
        endpoint: { host: "127.0.0.1", port: 3000 },
        providers: [...byProvider].map(([providerId, models]) => ({
          providerId,
          on: true,
          favorite: false,
          models,
        })),
      },
    };
  };
  const control: DesktopControlPlaneApi = {
    getBackendState: unavailable,
    onBackendState: () => () => undefined,
    executeRuntime: unavailable,
    executeSettings: unavailable,
    executeCredentialProfiles: unavailable,
    executeProviderProfileAuth: unavailable,
    respondAuth: unavailable,
    executeModels: unavailable,
    executeCatalog: unavailable,
    executePublicModels: legacyPublicModels,
    executeAgentIntegrations: unavailable,
    queryRequestJourneys: unavailable,
    getRequestJourney: unavailable,
    getRequestArtifact: unavailable,
    queryRuntimeEvents: unavailable,
    onRequestJourneys: () => () => undefined,
    onRuntimeEvents: () => () => undefined,
    getAnalytics: unavailable,
    queryHistory: unavailable,
    executeHistoryExport: unavailable,
    confirmHistoryExport: unavailable,
    executeHistoryDelete: unavailable,
    confirmHistoryDelete: unavailable,
    executeBackup: unavailable,
    confirmBackup: unavailable,
    ...controlOverrides,
  };
  const platform: DesktopPlatformApi = {
    getAutoStart: unavailable,
    setAutoStart: unavailable,
    pickDirectory: unavailable,
    pickSaveFile: unavailable,
    openExternal: unavailable,
    writeClipboardText: unavailable,
    getDesktopVersion: unavailable,
    ...options.platform,
  };
  return Object.freeze({
    contractVersion: 1,
    control: Object.freeze(control),
    platform: Object.freeze(platform),
  });
}
