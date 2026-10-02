import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  CircleHelp,
  GripVertical,
  KeyRound,
  Layers,
  MoreHorizontal,
  Pencil,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Star,
  Trash2,
  UserRoundCheck,
  UserRoundPlus,
  X,
} from "lucide-react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import { ProviderIcon } from "./ProviderIcon.js";
import {
  projectProviderCardUsage,
  providerUsageRefreshFailureNotice,
  providerUsageRefreshNotice,
} from "./provider-usage-presentation.js";

type ProfilesResult = Awaited<
  ReturnType<TokenDesktopApi["control"]["executeCredentialProfiles"]>
>;
type ProviderOption = NonNullable<ProfilesResult["options"]>["providers"][number];
type ProviderProfiles = ProfilesResult["state"]["providers"][number];
type CredentialProfile = ProviderProfiles["profiles"][number];
type ProfileAuthResult = Awaited<
  ReturnType<TokenDesktopApi["control"]["executeProviderProfileAuth"]>
>;
type AuthListener = NonNullable<
  Parameters<TokenDesktopApi["control"]["executeProviderProfileAuth"]>[1]
>;
type AuthEvent = Parameters<AuthListener>[0];
type ExternalAuthEvent = Extract<
  AuthEvent,
  { readonly type: "auth_url" | "device_code" }
>;
type InlineAuthEvent = Exclude<AuthEvent, ExternalAuthEvent>;
type CatalogResult = Awaited<ReturnType<TokenDesktopApi["control"]["executeCatalog"]>>;
type ProviderUsageResult = Awaited<
  ReturnType<TokenDesktopApi["control"]["executeProviderUsage"]>
>;
type ProviderUsageRow = ProviderUsageResult["snapshot"]["providers"][number];
type AuthType = "oauth" | "api_key";

export interface ProviderModelRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly api?: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly modelName: string;
  readonly on: boolean;
  readonly favorite: boolean;
}

interface AuthModalState {
  readonly providerId: string;
  readonly authType: AuthType;
  readonly mode: "add" | "reconnect";
  readonly credentialId?: string;
}

interface AuthOutcome {
  readonly kind: "success" | "cancelled" | "failed";
  readonly message: string;
}

function providerUsageBindingKey(provider: ProviderProfiles): string {
  return JSON.stringify([provider.revision, provider.selectionGeneration, provider.activeCredentialId]);
}

/** Whether this Provider has a credential source: any managed Profile, or a
 * Backend-verified external login. Drives the Connected group and whether the
 * usage card has a source it can speak for. */
function providerHasCredentialSource(
  provider: ProviderProfiles | undefined,
): boolean {
  if (provider === undefined) return false;
  return provider.profiles.length > 0 ||
    provider.ambient?.status === "connected";
}

function modelNameFromInternalAlias(
  providerId: string,
  internalAlias: string | undefined,
): string | undefined {
  if (internalAlias === undefined) return undefined;
  const prefix = `${providerId}/`;
  return internalAlias.startsWith(prefix)
    ? internalAlias.slice(prefix.length)
    : undefined;
}

export function ProvidersPage({ api, view = "providers", showFavoriteModels = false, onCloseFavoriteModels, onPublicModelsChange }: {
  readonly api: TokenDesktopApi;
  readonly view?: "providers" | "favorites";
  readonly showFavoriteModels?: boolean;
  readonly onCloseFavoriteModels?: () => void;
  readonly onPublicModelsChange?: (result: Awaited<ReturnType<TokenDesktopApi["control"]["executePublicModels"]>>) => void;
}) {
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [profileState, setProfileState] = useState<ProfilesResult["state"]>({
    providers: [],
  });
  const [catalog, setCatalog] = useState<CatalogResult>();
  const [providerUsageById, setProviderUsageById] = useState<
    Readonly<Record<string, ProviderUsageRow>>
  >({});
  const [usageRefreshingProviders, setUsageRefreshingProviders] = useState<
    ReadonlySet<string>
  >(new Set());
  const [publicModels, setPublicModels] = useState<Awaited<
    ReturnType<TokenDesktopApi["control"]["executePublicModels"]>
  >>();
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [search, setSearch] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [busyProvider, setBusyProvider] = useState<string>();
  const [authModal, setAuthModal] = useState<AuthModalState>();
  const [authOutcome, setAuthOutcome] = useState<AuthOutcome>();
  const [externalInteraction, setExternalInteraction] = useState<ExternalAuthEvent>();
  const [interaction, setInteraction] = useState<InlineAuthEvent>();
  const [promptValue, setPromptValue] = useState("");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileNote, setProfileNote] = useState("");
  const [useNow, setUseNow] = useState(true);
  const [authStarted, setAuthStarted] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string>();
  const [editingProfileName, setEditingProfileName] = useState("");
  const [editingProfileNote, setEditingProfileNote] = useState("");
  const [notice, setNotice] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [profilesProviderId, setProfilesProviderId] = useState<string>();
  const [profileActionsId, setProfileActionsId] = useState<string>();
  const [modelsProviderId, setModelsProviderId] = useState<string>();
  const favoriteOnly = view === "favorites";
  const favoriteModelsOpen = favoriteOnly || showFavoriteModels;
  const [modelSearch, setModelSearch] = useState("");
  const [editingRow, setEditingRow] = useState<ProviderModelRow>();
  const [modelNameValue, setModelNameValue] = useState("");
  const [modelNameBusy, setModelNameBusy] = useState(false);
  const [modelNameError, setModelNameError] = useState<string>();
  const seenCatalogVersion = useRef(-1);
  const usageBindingKeyByProvider = useRef(new Map<string, string>());
  const usageEpochByProvider = useRef(new Map<string, number>());
  const usageRefreshVersion = useRef(0);
  const usageRefreshInFlight = useRef(new Set<string>());
  const draggingModelId = useRef<string | undefined>(undefined);
  const draggingProfileId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (publicModels !== undefined) onPublicModelsChange?.(publicModels);
  }, [publicModels, onPublicModelsChange]);

  const queryPageFacts = (): void => {
    setLoading(true);
    setAuthError(false);
    setCatalogError(false);
    void api.control
      .executeCredentialProfiles({ command: "query" })
      .then((profiles) => {
        setProviders(profiles.options?.providers ?? []);
        setProfileState(profiles.state);
        setAuthError(profiles.outcome !== "ok");
      })
      .catch(() => setAuthError(true));
    void api.control
      .executeCatalog({ command: "query" })
      .then((nextCatalog) => {
        seenCatalogVersion.current = nextCatalog.snapshot.version;
        setCatalog(nextCatalog);
        setCatalogError(nextCatalog.outcome !== "ok");
      })
      .catch(() => setCatalogError(true));
    void api.control.executePublicModels({ command: "query" }).then(
      (nextPublicModels) => setPublicModels(nextPublicModels),
      () => undefined,
    );
    void Promise.resolve().then(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    void api.control
      .executeCredentialProfiles({ command: "query" })
      .then((profiles) => {
        if (!active) return;
        setProviders(profiles.options?.providers ?? []);
        setProfileState(profiles.state);
        setAuthError(profiles.outcome !== "ok");
      })
      .catch(() => {
        if (active) setAuthError(true);
      });
    void api.control
      .executeCatalog({ command: "query" })
      .then((nextCatalog) => {
        if (!active) return;
        seenCatalogVersion.current = nextCatalog.snapshot.version;
        setCatalog(nextCatalog);
        setCatalogError(nextCatalog.outcome !== "ok");
      })
      .catch(() => {
        if (active) setCatalogError(true);
      });
    void api.control.executePublicModels({ command: "query" }).then(
      (nextPublicModels) => {
        if (active) setPublicModels(nextPublicModels);
      },
      () => undefined,
    );
    void Promise.resolve().then(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    let active = true;
    const stop = api.control.onBackendState((state) => {
      if (state.kind !== "ready") return;
      const status = state.status;
      if (status.credentialProfiles !== undefined) {
        setProfileState(status.credentialProfiles);
      }
      const publishedVersion = status.catalog?.version;
      if (
        publishedVersion === undefined ||
        publishedVersion === seenCatalogVersion.current
      ) {
        return;
      }
      seenCatalogVersion.current = publishedVersion;
      void api.control.executeCatalog({ command: "query" }).then(
        (nextCatalog) => {
          if (!active) return;
          setCatalog(nextCatalog);
          setCatalogError(nextCatalog.outcome !== "ok");
        },
        () => {
          if (active) setCatalogError(true);
        },
      );
      void api.control.executePublicModels({ command: "query" }).then(
        (nextPublicModels) => {
          if (active) setPublicModels(nextPublicModels);
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      stop();
    };
  }, [api]);

  useEffect(() => {
    const changed = new Map<string, number>();
    const currentProviderIds = new Set<string>();

    for (const provider of profileState.providers) {
      currentProviderIds.add(provider.providerId);
      const nextKey = providerUsageBindingKey(provider);
      const previousKey = usageBindingKeyByProvider.current.get(provider.providerId);
      if (previousKey === nextKey) continue;
      usageBindingKeyByProvider.current.set(provider.providerId, nextKey);
      const nextEpoch = (usageEpochByProvider.current.get(provider.providerId) ?? 0) + 1;
      usageEpochByProvider.current.set(provider.providerId, nextEpoch);
      changed.set(provider.providerId, nextEpoch);
    }

    for (const providerId of [...usageBindingKeyByProvider.current.keys()]) {
      if (currentProviderIds.has(providerId)) continue;
      usageBindingKeyByProvider.current.delete(providerId);
      const nextEpoch = (usageEpochByProvider.current.get(providerId) ?? 0) + 1;
      usageEpochByProvider.current.set(providerId, nextEpoch);
      changed.set(providerId, nextEpoch);
    }

    if (changed.size === 0) return;

    setProviderUsageById((current) => {
      const next = { ...current };
      for (const providerId of changed.keys()) delete next[providerId];
      return next;
    });

    let active = true;
    void api.control.executeProviderUsage({ command: "query" }).then(
      (result) => {
        if (!active) return;
        setProviderUsageById((current) => {
          const next = { ...current };
          for (const row of result.snapshot.providers) {
            const expectedEpoch = changed.get(row.providerId);
            if (
              expectedEpoch === undefined ||
              (usageEpochByProvider.current.get(row.providerId) ?? 0) !== expectedEpoch
            ) {
              continue;
            }
            next[row.providerId] = row;
          }
          return next;
        });
      },
      () => undefined,
    );

    return () => {
      active = false;
    };
  }, [api, profileState]);

  useEffect(() => {
    let active = true;
    let queryInFlight = false;
    const timer = setInterval(() => {
      if (queryInFlight) return;
      queryInFlight = true;
      const expectedEpochs = new Map(usageEpochByProvider.current);
      const expectedRefreshVersion = usageRefreshVersion.current;
      void api.control.executeProviderUsage({ command: "query" }).then(
        (result) => {
          if (!active || usageRefreshVersion.current !== expectedRefreshVersion) return;
          setProviderUsageById((current) => {
            const next = { ...current };
            for (const row of result.snapshot.providers) {
              if (
                !expectedEpochs.has(row.providerId) ||
                expectedEpochs.get(row.providerId) !==
                usageEpochByProvider.current.get(row.providerId)
              ) {
                continue;
              }
              next[row.providerId] = row;
            }
            return next;
          });
        },
        () => undefined,
      ).finally(() => {
        queryInFlight = false;
      });
    }, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);

  useEffect(() => {
    let active = true;
    const stop = api.control.onRequestJourneys((record) => {
      if (record.outcome !== "success" || record.profileId === undefined) return;
      void api.control
        .executeCredentialProfiles({ command: "query" })
        .then((profiles) => {
          if (!active) return;
          setProviders(profiles.options?.providers ?? []);
          setProfileState(profiles.state);
          setAuthError(profiles.outcome !== "ok");
        })
        .catch(() => {
          if (active) setAuthError(true);
        });

      const providerId = record.providerId;
      if (providerId === undefined) return;
      const expectedEpoch = usageEpochByProvider.current.get(providerId) ?? 0;
      void api.control.executeProviderUsage({ command: "query" }).then(
        (result) => {
          if (
            !active ||
            (usageEpochByProvider.current.get(providerId) ?? 0) !== expectedEpoch
          ) {
            return;
          }
          const row = result.snapshot.providers.find(
            (candidate) => candidate.providerId === providerId,
          );
          if (row === undefined) return;
          setProviderUsageById((current) => ({
            ...current,
            [providerId]: row,
          }));
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      stop();
    };
  }, [api]);

  const catalogByProvider = useMemo(
    () =>
      new Map(
        catalog?.snapshot.providers.map((provider) => [
          provider.providerId,
          provider,
        ]) ?? [],
      ),
    [catalog],
  );

  const publicProviderById = useMemo(
    () =>
      new Map(
        publicModels?.state.providers.map((provider) => [
          provider.providerId,
          provider,
        ]) ?? [],
      ),
    [publicModels],
  );

  const modelRows = useMemo(() => {
    const rows: ProviderModelRow[] = [];
    for (const provider of publicModels?.state.providers ?? []) {
      const catalogProvider = catalogByProvider.get(provider.providerId);
      const catalogModelById = new Map(
        catalogProvider?.models.map((model) => [model.id, model]) ?? [],
      );
      for (const model of provider.models) {
        const modelName = modelNameFromInternalAlias(provider.providerId, model.alias);
        if (modelName === undefined) continue;
        const catalogModel = catalogModelById.get(model.target);
        rows.push({
          providerId: provider.providerId,
          modelId: model.target,
          ...(catalogModel?.api === undefined ? {} : { api: catalogModel.api }),
          availability: catalogModel?.availability ?? "unavailable",
          modelName,
          on: model.on,
          favorite: model.favorite,
        });
      }
    }
    return rows;
  }, [catalogByProvider, publicModels]);

  const applyProfileState = (
    result: ProfilesResult | ProfileAuthResult,
  ): void => {
    setProfileState(result.state);
    if (result.options !== undefined) setProviders(result.options.providers);
  };

  const clearAuthInteraction = (): void => {
    setExternalInteraction(undefined);
    setInteraction(undefined);
    setPromptValue("");
    setApiKeyValue("");
  };

  const openAdd = (
    provider: ProviderOption,
    authType: AuthType,
  ): void => {
    const profiles = profileState.providers.find(
      (candidate) => candidate.providerId === provider.providerId,
    )?.profiles ?? [];
    const usedNames = new Set(
      profiles.map((profile) => profile.displayName.trim().toLowerCase()),
    );
    let ordinal = 1;
    while (usedNames.has(`profile ${ordinal}`)) ordinal += 1;
    setProfileName(`Profile ${ordinal}`);
    setProfileNote("");
    setUseNow(profiles.length === 0);
    setAuthStarted(false);
    setAuthModal({ providerId: provider.providerId, authType, mode: "add" });
    setAuthOutcome(undefined);
    clearAuthInteraction();
  };

  const openReconnect = (
    provider: ProviderOption,
    profile: CredentialProfile,
  ): void => {
    setProfileName(profile.displayName);
    setProfileNote(profile.note ?? "");
    setUseNow(false);
    setAuthStarted(false);
    setAuthModal({
      providerId: provider.providerId,
      authType: profile.authType,
      mode: "reconnect",
      credentialId: profile.credentialId,
    });
    setAuthOutcome(undefined);
    clearAuthInteraction();
  };

  const startAuth = async (initialApiKey?: string): Promise<void> => {
    const modal = authModal;
    if (modal === undefined) return;
    const provider = providers.find(
      (candidate) => candidate.providerId === modal.providerId,
    );
    const providerState = profileState.providers.find(
      (candidate) => candidate.providerId === modal.providerId,
    );
    if (provider === undefined || providerState?.revision === undefined) {
      setAuthOutcome({
        kind: "failed",
        message: "Provider Profile state is unavailable. Refresh and try again.",
      });
      return;
    }
    if (modal.mode === "add" && profileName.trim().length === 0) {
      setAuthOutcome({ kind: "failed", message: "Enter a Profile name." });
      return;
    }
    setBusyProvider(provider.providerId);
    setAuthStarted(true);
    setAuthOutcome(undefined);
    clearAuthInteraction();
    setNotice(undefined);
    let pendingApiKey = initialApiKey;
    try {
      const result = await api.control.executeProviderProfileAuth(
        modal.mode === "add"
          ? {
              command: "login",
              providerId: provider.providerId,
              authType: modal.authType,
              displayName: profileName.trim(),
              ...(profileNote.length === 0 ? {} : { note: profileNote }),
              useNow,
              expectedRevision: providerState.revision,
            }
          : {
              command: "reconnect",
              providerId: provider.providerId,
              credentialId: modal.credentialId!,
              useNow,
              expectedRevision: providerState.revision,
            },
        (event) => {
          if (event.type === "auth_url") {
            setExternalInteraction(event);
            void api.platform.openExternal(event.url);
            return;
          }
          if (event.type === "device_code") {
            setExternalInteraction(event);
            void api.platform.openExternal(event.verificationUri);
            return;
          }
          if (
            event.type === "prompt" &&
            event.kind === "secret" &&
            pendingApiKey !== undefined
          ) {
            const value = pendingApiKey;
            pendingApiKey = undefined;
            void api.control.respondAuth({
              type: "prompt_response",
              promptId: event.promptId,
              value,
            });
            return;
          }
          setInteraction(event);
          if (event.type === "prompt") setPromptValue("");
        },
      );
      applyProfileState(result);
      if (result.outcome === "ok") {
        setAuthOutcome({
          kind: "success",
          message:
            modal.mode === "add"
              ? `${profileName.trim()} added to ${provider.name}.`
              : `${profileName} reconnected.`,
        });
      } else if (result.outcome === "cancelled") {
        setAuthOutcome({ kind: "cancelled", message: "Sign-in cancelled." });
      } else {
        setAuthOutcome({
          kind: "failed",
          message: result.error ?? "Provider sign-in failed. Try again.",
        });
      }
    } catch {
      setAuthOutcome({
        kind: "failed",
        message: "Provider sign-in failed. Try again.",
      });
    } finally {
      clearAuthInteraction();
      setBusyProvider(undefined);
    }
  };

  const cancelAuth = (): void => {
    if (busyProvider !== undefined) {
      void api.control.respondAuth({ type: "cancel" });
    }
    setAuthModal(undefined);
    setAuthStarted(false);
    setAuthOutcome(undefined);
    clearAuthInteraction();
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setNotice(undefined);
    try {
      const result = await api.control.executeCatalog({
        command: "refresh",
        mode: "manual",
      });
      setCatalog(result);
      setCatalogError(result.outcome !== "ok");
      const failed =
        result.refresh?.providers.filter(
          (provider) => provider.outcome === "failed",
        ) ?? [];
      setNotice(
        failed.length === 0
          ? "Provider models refreshed."
          : failed
              .map(
                (provider) =>
                  provider.error ?? `${provider.providerId} refresh failed`,
              )
              .join(" · "),
      );
    } finally {
      setRefreshing(false);
    }
  };

  const refreshProviderUsage = async (providerId: string): Promise<void> => {
    if (usageRefreshInFlight.current.has(providerId)) return;
    usageRefreshInFlight.current.add(providerId);
    usageRefreshVersion.current += 1;
    const expectedEpoch = usageEpochByProvider.current.get(providerId) ?? 0;
    setUsageRefreshingProviders((current) => {
      const next = new Set(current);
      next.add(providerId);
      return next;
    });
    try {
      const result = await api.control.executeProviderUsage({
        command: "refresh",
        providerId,
      });
      if ((usageEpochByProvider.current.get(providerId) ?? 0) !== expectedEpoch) {
        return;
      }
      const row = result.snapshot.providers.find(
        (candidate) => candidate.providerId === providerId,
      );
      if (row !== undefined) {
        setProviderUsageById((current) => ({
          ...current,
          [providerId]: row,
        }));
      }
      const refreshNotice = providerUsageRefreshNotice(
        result.refresh,
      );
      if (refreshNotice !== undefined) setNotice(refreshNotice);
    } catch {
      if ((usageEpochByProvider.current.get(providerId) ?? 0) === expectedEpoch) {
        setNotice(providerUsageRefreshFailureNotice());
      }
    } finally {
      usageRefreshInFlight.current.delete(providerId);
      setUsageRefreshingProviders((current) => {
        const next = new Set(current);
        next.delete(providerId);
        return next;
      });
    }
  };

  const submitPrompt = async (): Promise<void> => {
    if (interaction?.type !== "prompt") return;
    await api.control.respondAuth({
      type: "prompt_response",
      promptId: interaction.promptId,
      value: promptValue,
    });
  };

  const executeProfileCommand = async (
    command: Parameters<
      TokenDesktopApi["control"]["executeCredentialProfiles"]
    >[0],
  ): Promise<ProfilesResult> => {
    const result = await api.control.executeCredentialProfiles(command);
    applyProfileState(result);
    setNotice(
      result.outcome === "ok"
        ? "Provider Profile updated."
        : result.error ?? "Provider Profile could not be updated.",
    );
    return result;
  };

  const saveProfileMetadata = async (
    provider: ProviderProfiles,
    profile: CredentialProfile,
  ): Promise<void> => {
    if (provider.revision === undefined || editingProfileName.trim().length === 0) {
      return;
    }
    const result = await executeProfileCommand({
      command: "update_metadata",
      providerId: provider.providerId,
      credentialId: profile.credentialId,
      expectedRevision: provider.revision,
      displayName: editingProfileName.trim(),
      ...(editingProfileNote.length === 0 ? {} : { note: editingProfileNote }),
    });
    if (result.outcome === "ok") setEditingProfileId(undefined);
  };

  const removeProfile = async (
    provider: ProviderProfiles,
    profile: CredentialProfile,
  ): Promise<void> => {
    if (provider.revision === undefined) return;
    const action =
      profile.authType === "oauth"
        ? "Disconnect from Token"
        : "Remove from Token";
    if (
      !window.confirm(
        `${action}: ${profile.displayName} (${profile.authMethodLabel})? This removes only Token's local credential. The credential may remain valid at the Provider; revoke it in the Provider's account or security settings when needed. Historical Activity snapshots remain.`,
      )
    ) {
      return;
    }
    await executeProfileCommand({
      command: "remove",
      providerId: provider.providerId,
      credentialId: profile.credentialId,
      expectedRevision: provider.revision,
    });
  };

  const openModelEditor = (row: ProviderModelRow): void => {
    if (row.modelName === undefined) return;
    setModelNameError(undefined);
    setModelNameValue(row.modelName);
    setEditingRow(row);
  };

  const executePublicModelMutation = async (
    commandForRevision: (
      revision: number,
    ) => Parameters<TokenDesktopApi["control"]["executePublicModels"]>[0],
  ): Promise<Awaited<
    ReturnType<TokenDesktopApi["control"]["executePublicModels"]>
  > | undefined> => {
    const revision = publicModels?.state.revision;
    if (revision === undefined) return undefined;
    let result = await api.control.executePublicModels(
      commandForRevision(revision),
    );
    if (result.outcome === "conflict") {
      result = await api.control.executePublicModels(
        commandForRevision(result.state.revision),
      );
    }
    setPublicModels(result);
    return result;
  };

  const saveModelName = async (): Promise<void> => {
    const row = editingRow;
    if (row === undefined) return;
    const trimmed = modelNameValue.trim();
    if (trimmed.length === 0 || trimmed.includes("/")) {
      setModelNameError("Model name must not contain '/'.");
      return;
    }
    setModelNameBusy(true);
    setModelNameError(undefined);
    try {
      const result = await executePublicModelMutation((revision) => ({
        command: "rename_model",
        revision,
        providerId: row.providerId,
        modelId: row.modelId,
        modelName: trimmed,
      }));
      if (result === undefined || result.outcome !== "ok") {
        setModelNameError(
          result?.outcome === "conflict"
            ? "Model names changed. Refresh and try again."
            : "The model name could not be saved.",
        );
        const next = await api.control
          .executePublicModels({ command: "query" })
          .catch(() => undefined);
        if (next !== undefined) setPublicModels(next);
        return;
      }
      setEditingRow(undefined);
      setNotice(`Model name saved for ${row.modelId}.`);
    } catch {
      setModelNameError("The model name could not be saved. Try again.");
    } finally {
      setModelNameBusy(false);
    }
  };

  const restoreModelName = async (row: ProviderModelRow): Promise<void> => {
    setModelNameBusy(true);
    setModelNameError(undefined);
    try {
      const result = await executePublicModelMutation((revision) => ({
        command: "restore_model_name",
        revision,
        providerId: row.providerId,
        modelId: row.modelId,
      }));
      if (result === undefined || result.outcome !== "ok") {
        setModelNameError(
          result?.outcome === "conflict"
            ? "Model names changed. Refresh and try again."
            : "The default model name could not be restored.",
        );
        return;
      }
      setEditingRow(undefined);
      setNotice(`Default model name restored for ${row.modelId}.`);
    } catch {
      setModelNameError("The default model name could not be restored. Try again.");
    } finally {
      setModelNameBusy(false);
    }
  };

  const setProviderOn = async (
    providerId: string,
    on: boolean,
  ): Promise<void> => {
    const result = await executePublicModelMutation((revision) => ({
      command: "set_provider",
      revision,
      providerId,
      on,
    }));
    if (result === undefined) return;
    if (result.outcome === "unavailable") {
      setNotice("Sign in before turning this provider on.");
    } else if (result.outcome !== "ok") {
      setNotice("Provider publication could not be updated. Try again.");
    }
  };

  const setProviderFavorite = async (
    providerId: string,
    favorite: boolean,
  ): Promise<void> => {
    const result = await executePublicModelMutation((revision) => ({
      command: "set_provider_favorite",
      revision,
      providerId,
      favorite,
    }));
    if (result === undefined) return;
    if (result.outcome === "limit_exceeded") {
      setNotice("You can favorite up to 5 providers.");
    } else if (result.outcome !== "ok") {
      setNotice("Provider favorite could not be updated. Try again.");
    }
  };

  const setModelOn = async (row: ProviderModelRow, on: boolean): Promise<void> => {
    const result = await executePublicModelMutation((revision) => ({
      command: "set_model",
      revision,
      providerId: row.providerId,
      modelId: row.modelId,
      on,
    }));
    if (result !== undefined && result.outcome !== "ok") {
      setNotice("Model publication could not be updated. Try again.");
    }
  };

  const setModelFavorite = async (
    row: ProviderModelRow,
    favorite: boolean,
  ): Promise<void> => {
    const result = await executePublicModelMutation((revision) => ({
      command: "set_model_favorite",
      revision,
      providerId: row.providerId,
      modelId: row.modelId,
      favorite,
    }));
    if (result === undefined) return;
    if (result.outcome === "limit_exceeded") {
      setNotice("You can favorite up to 10 models.");
    } else if (result.outcome !== "ok") {
      setNotice("Model favorite could not be updated. Try again.");
    }
  };

  const reorderProviderModels = async (
    providerId: string,
    sourceModelId: string,
    targetModelId: string,
  ): Promise<void> => {
    const state = publicModels?.state;
    if (state === undefined || sourceModelId === targetModelId) return;
    const provider = state.providers.find(
      (candidate) => candidate.providerId === providerId,
    );
    if (provider === undefined) return;
    const modelIds = provider.models.map((model) => model.target);
    const sourceIndex = modelIds.indexOf(sourceModelId);
    const targetIndex = modelIds.indexOf(targetModelId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = modelIds.splice(sourceIndex, 1);
    if (moved === undefined) return;
    modelIds.splice(targetIndex, 0, moved);

    const result = await api.control.executePublicModels({
      command: "reorder_models",
      revision: state.revision,
      providerId,
      modelIds,
    });
    setPublicModels(result);
    setNotice(
      result.outcome === "ok"
        ? "Model order saved."
        : result.outcome === "conflict"
          ? "Model order changed. Reopen Models and try again."
          : "Model order could not be saved.",
    );
  };

  const reorderProviderProfiles = async (
    provider: ProviderProfiles,
    sourceCredentialId: string,
    targetCredentialId: string,
  ): Promise<void> => {
    if (
      provider.revision === undefined ||
      sourceCredentialId === targetCredentialId
    ) {
      return;
    }
    const credentialIds = [...provider.profiles]
      .sort(
        (left, right) =>
          left.priority - right.priority || left.createdAt - right.createdAt,
      )
      .map((profile) => profile.credentialId);
    const sourceIndex = credentialIds.indexOf(sourceCredentialId);
    const targetIndex = credentialIds.indexOf(targetCredentialId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = credentialIds.splice(sourceIndex, 1);
    if (moved === undefined) return;
    credentialIds.splice(targetIndex, 0, moved);
    await executeProfileCommand({
      command: "reorder_profiles",
      providerId: provider.providerId,
      credentialIds,
      expectedRevision: provider.revision,
    });
  };

  if (loading) {
    return (
      <section className="page-card">
        <p>Loading providers…</p>
      </section>
    );
  }

  const normalizedSearch = search.trim().toLowerCase();
  const profileByProvider = new Map(
    profileState.providers.map((provider) => [provider.providerId, provider]),
  );
  const optionByProvider = new Map(
    providers.map((provider) => [provider.providerId, provider]),
  );
  const providerIds = new Set([
    ...providers.map((provider) => provider.providerId),
    ...profileState.providers.map((provider) => provider.providerId),
  ]);
  const allProviders: readonly ProviderOption[] = [...providerIds]
    .sort()
    .map(
      (providerId) =>
        optionByProvider.get(providerId) ?? {
          providerId,
          name: providerId,
          source: "user" as const,
          authMethods: [],
        },
    );
  const visible = allProviders.filter((provider) => {
    if (normalizedSearch.length === 0) return true;
    const managed = profileByProvider.get(provider.providerId);
    return (
      provider.name.toLowerCase().includes(normalizedSearch) ||
      provider.providerId.toLowerCase().includes(normalizedSearch) ||
      managed?.profiles.some(
        (profile) =>
          profile.displayName.toLowerCase().includes(normalizedSearch) ||
          profile.authMethodLabel.toLowerCase().includes(normalizedSearch) ||
          profile.identityHint?.toLowerCase().includes(normalizedSearch) === true ||
          profile.note?.toLowerCase().includes(normalizedSearch) === true,
      ) === true
    );
  });
  const favoriteFirst = (left: ProviderOption, right: ProviderOption): number =>
    Number(publicProviderById.get(right.providerId)?.favorite ?? false) -
    Number(publicProviderById.get(left.providerId)?.favorite ?? false);
  const hasCredentialSource = (provider: ProviderOption): boolean =>
    providerHasCredentialSource(profileByProvider.get(provider.providerId));
  const connected = visible
    .filter(hasCredentialSource)
    .sort(favoriteFirst);
  const available = visible
    .filter((provider) => !hasCredentialSource(provider))
    .sort(favoriteFirst);

  const selectedModelsProvider =
    modelsProviderId === undefined
      ? undefined
      : allProviders.find((provider) => provider.providerId === modelsProviderId);
  const selectedProfilesProvider =
    profilesProviderId === undefined
      ? undefined
      : allProviders.find((provider) => provider.providerId === profilesProviderId);
  const selectedProfilesState =
    profilesProviderId === undefined
      ? undefined
      : profileByProvider.get(profilesProviderId);
  const selectedProfilesCount = selectedProfilesState?.profiles.length ?? 0;
  const profileActions =
    profileActionsId === undefined
      ? undefined
      : selectedProfilesState?.profiles.find(
          (profile) => profile.credentialId === profileActionsId,
        );
  const profileActionsMethod = selectedProfilesProvider?.authMethods.find(
    (method) => method.authType === profileActions?.authType,
  );
  const ProfileActionsAuthIcon =
    profileActions?.authType === "oauth" ? UserRoundCheck : KeyRound;
  const selectedProviderModelRows =
    modelsProviderId === undefined
      ? []
      : modelRows.filter((row) => row.providerId === modelsProviderId);
  const favoriteModelRows = modelRows.filter((row) => row.favorite);
  const normalizedModelSearch = modelSearch.trim().toLowerCase();
  const selectedModelRows = (
    favoriteModelsOpen ? favoriteModelRows : selectedProviderModelRows
  ).filter(
    (row) =>
      normalizedModelSearch.length === 0 ||
      row.modelName.toLowerCase().includes(normalizedModelSearch) ||
      row.modelId.toLowerCase().includes(normalizedModelSearch) ||
      row.providerId.toLowerCase().includes(normalizedModelSearch),
  );
  const modelsDialogOpen =
    favoriteModelsOpen || selectedModelsProvider !== undefined;
  const modelsDialogLabel = favoriteModelsOpen
    ? "Favorite models"
    : `${selectedModelsProvider?.name ?? "Provider"} models`;
  const authProvider =
    authModal === undefined
      ? undefined
      : allProviders.find((provider) => provider.providerId === authModal.providerId);
  const authMethod = authProvider?.authMethods.find(
    (method) => method.authType === authModal?.authType,
  );
  const authProviderState = authModal === undefined
    ? undefined
    : profileByProvider.get(authModal.providerId);
  const authSwitchPolicy = authProviderState?.switchPolicy;
  const authFallbackOn = authModal?.authType === "api_key"
    ? authSwitchPolicy?.apiKeyOn429
    : authSwitchPolicy?.oauthOn429;

  const toggleAuthFallback = (): void => {
    if (
      authModal === undefined ||
      authProviderState?.revision === undefined ||
      authSwitchPolicy === undefined ||
      busyProvider !== undefined
    ) return;
    void executeProfileCommand({
      command: "set_switch_policy",
      providerId: authModal.providerId,
      expectedRevision: authProviderState.revision,
      apiKeyOn429: authModal.authType === "api_key"
        ? !authSwitchPolicy.apiKeyOn429
        : authSwitchPolicy.apiKeyOn429,
      oauthOn429: authModal.authType === "oauth"
        ? !authSwitchPolicy.oauthOn429
        : authSwitchPolicy.oauthOn429,
    });
  };

  const renderCompactProviderCard = (
    provider: ProviderOption,
  ): React.ReactElement => {
    const managed = profileByProvider.get(provider.providerId);
    const availability = catalogByProvider.get(provider.providerId);
    const publicProvider = publicProviderById.get(provider.providerId);
    const availableModels =
      availability?.models.filter((model) => model.availability === "available")
        .length ?? 0;
    const publishedModels =
      publicProvider?.models.filter((model) => model.on).length ?? 0;
    const active = managed?.profiles.find(
      (profile) => profile.credentialId === managed.activeCredentialId,
    );
    const providerOn = publicProvider?.on ?? false;
    const providerFavorite = publicProvider?.favorite ?? false;
    const catalogFailed = availability?.state === "failed";
    const hasError =
      catalogFailed ||
      managed?.recordError !== undefined ||
      managed?.implementationAvailable === false;
    const hasManagedProfiles = (managed?.profiles.length ?? 0) > 0;
    const statusTone = hasError || active?.health === "reconnect_required" ? "error" :
      active?.health === "ready" ? "good" : hasManagedProfiles ? "warning" : "neutral";
    const statusLabel = hasError ? "Provider error" : active?.health === "reconnect_required" ? "Reconnect required" :
      active?.health === "ready" ? "Provider available" : hasManagedProfiles ? "Select or verify a Profile" : "Not connected";
    const credentialSummary = active !== undefined
      ? { label: active.displayName, actionLabel: `Manage ${provider.name} profiles`,
          description: `Active Profile: ${active.displayName}. ${statusLabel}`, title: `Active Profile: ${active.displayName}` }
      : hasManagedProfiles ? { label: "Select a Profile", actionLabel: `Manage ${provider.name} profiles`,
          description: `Select an active Profile. ${statusLabel}`, title: "Select an active Profile" } : undefined;
    const usagePresentation = projectProviderCardUsage(
      providerUsageById[provider.providerId],
      Date.now(),
    );
    const usageText = [
      ...usagePresentation.primary,
      usagePresentation.status,
      ...usagePresentation.secondary,
    ].filter((part): part is string => part !== undefined).join(" · ");
    const usageRefreshing = usageRefreshingProviders.has(provider.providerId);
    // The card is shown whenever the Provider has a usage source (a managed
    // Profile or a verified external Codex login) and something to say: the
    // WHAM windows, the "not refreshed" cue, or the bounded external prompt.
    const showUsage = providerHasCredentialSource(managed) &&
      (usagePresentation.primary.length > 0 ||
        usagePresentation.secondary.length > 0 ||
        usagePresentation.status !== undefined);

    return (
      <article className="page-card provider-card compact" key={provider.providerId}>
        <div className="provider-title">
          <div className="provider-title-identity">
            <ProviderIcon providerId={provider.providerId} name={provider.name} />
            <h3>{provider.name}</h3>
          </div>
          <div className="provider-title-actions">
            <button
              type="button"
              className={`favorite-button${providerFavorite ? " active" : ""}`}
              aria-label={`${providerFavorite ? "Unfavorite" : "Favorite"} ${provider.name}`}
              aria-pressed={providerFavorite}
              disabled={publicProvider === undefined}
              onClick={() =>
                void setProviderFavorite(provider.providerId, !providerFavorite)}
              title="Favorite providers are pinned within their current group."
            >
              <Star
                size={19}
                fill={providerFavorite ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              className={`switch-control${providerOn ? " on" : ""}`}
              aria-label={`${providerOn ? "Hide" : "Publish"} ${provider.name}`}
              aria-pressed={providerOn}
              disabled={
                publicProvider === undefined ||
                (!providerOn &&
                  active === undefined)
              }
              onClick={() => void setProviderOn(provider.providerId, !providerOn)}
              title="Publish this Provider in model discovery."
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </div>

        {credentialSummary === undefined ? (
          <div className="provider-metrics">
            <span
              className={`status-dot ${statusTone}`}
              role="img"
              aria-label={statusLabel}
              title={statusLabel}
            />
            <span
              className="provider-model-ratio"
              aria-label={`${publishedModels} published, ${availableModels} currently available`}
              title={`${publishedModels} published · ${availableModels} currently available`}
            >
              {publishedModels}/{availableModels}
            </span>
          </div>
        ) : (
          <button
            type="button"
            className="provider-profile-summary"
            aria-label={credentialSummary.actionLabel}
            aria-description={credentialSummary.description}
            title={credentialSummary.title}
            onClick={() => {
              setProfileActionsId(undefined);
              setProfilesProviderId(provider.providerId);
            }}
          >
            <span
              className={`status-dot ${statusTone}`}
              role="img"
              aria-label={statusLabel}
              title={statusLabel}
            />
            <span className="provider-profile-name">{credentialSummary.label}</span>
            <span aria-hidden="true" className="metric-separator">·</span>
            <span
              className="provider-model-ratio"
              aria-label={`${publishedModels} published, ${availableModels} currently available`}
              title={`${publishedModels} published · ${availableModels} currently available`}
            >
              {publishedModels}/{availableModels}
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        )}

        {showUsage ? <div
          className={`provider-usage${usagePresentation.refreshable ? " refreshable" : ""}`}
          role={usagePresentation.refreshable ? "button" : undefined}
          tabIndex={usagePresentation.refreshable ? 0 : undefined}
          aria-label={usagePresentation.refreshable
            ? `${provider.name} usage: ${usageText}. Double-click or press Enter to refresh`
            : `${provider.name} usage: ${usageText}`}
          aria-disabled={usagePresentation.refreshable && usageRefreshing ? true : undefined}
          title={usagePresentation.refreshable ? "Double-click to refresh usage; press Enter to refresh with the keyboard" : undefined}
          onDoubleClick={usagePresentation.refreshable && !usageRefreshing
            ? () => void refreshProviderUsage(provider.providerId)
            : undefined}
          onKeyDown={usagePresentation.refreshable && !usageRefreshing
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                void refreshProviderUsage(provider.providerId);
              }
            : undefined}
        >
          {usagePresentation.primary.length > 0 ? (
            <span className="provider-usage-primary">
              {usagePresentation.primary.join(" · ")}
            </span>
          ) : usagePresentation.status !== undefined ? (
            <span className="provider-usage-status">
              {usagePresentation.status}
            </span>
          ) : null}
          {usagePresentation.secondary.length > 0 ? (
            <span className="provider-usage-secondary">
              {usagePresentation.secondary.join(" · ")}
            </span>
          ) : null}
        </div> : null}

        {hasError ? (
          <p className="provider-card-error" role="alert">
            {managed?.recordError?.message ??
              availability?.error ??
              "Provider refresh failed"}
          </p>
        ) : null}

        <div className="provider-card-actions">
          {provider.authMethods
            .filter((method) => method.interactive)
            .map((method) => {
              const Icon =
                method.authType === "api_key" ? KeyRound : UserRoundPlus;
              return (
                <button
                  key={method.authType}
                  type="button"
                  className="card-icon-button"
                  aria-label={`Add ${method.authMethodLabel}`}
                  title={method.authType === "api_key" ? "Add API key" : "Add OAuth account"}
                  disabled={busyProvider !== undefined}
                  onClick={() => openAdd(provider, method.authType)}
                >
                  <Icon size={21} aria-hidden="true" />
                </button>
              );
            })}
          <button
            type="button"
            className="card-icon-button"
            aria-label={`Manage ${provider.name} models`}
            title="Manage models"
            onClick={() => {
              setEditingRow(undefined);
              setModelSearch("");
              setModelsProviderId(provider.providerId);
            }}
          >
            <Layers size={21} aria-hidden="true" />
          </button>
          {catalogFailed ? (
            <button
              type="button"
              className="card-icon-button"
              aria-label={`Retry ${provider.name} models`}
              title="Retry models"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw size={20} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <section className="page-stack">
      {favoriteOnly ? null : (<>
      <div className="provider-page-heading">
        <h2>Providers</h2>
        <button
          type="button"
          className="card-icon-button provider-help-button"
          aria-label="How to use Providers"
          title="How to use this page"
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp size={16} aria-hidden="true" />
        </button>
      </div>

      {notice === undefined ? null : (
        <div className="product-notice dismissible-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="notice-dismiss" aria-label="Dismiss Provider notification" title="Dismiss" onClick={() => setNotice(undefined)}><X size={16} aria-hidden="true" /></button>
        </div>
      )}

      {authError ? (
        <section className="page-card" role="alert">
          <h3>Provider state is temporarily unavailable</h3>
          <p>Token could not reach Provider management.</p>
          <button type="button" onClick={queryPageFacts}>Retry</button>
        </section>
      ) : (
        <>
          <div className="provider-toolbar">
            <label className="provider-search">
              <span className="sr-only">Search providers</span>
              <input
                type="search"
                placeholder="Search providers…"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
            <div className="provider-toolbar-actions">
              <button
                type="button"
                className="card-icon-button provider-refresh-button"
                aria-label="Refresh models"
                title="Refresh models"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCw
                  className={refreshing ? "spinning" : undefined}
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>

          {catalogError ? (
            <section className="page-card" role="alert">
              <h3>Model catalog unavailable</h3>
              <p>Authentication is available, but model facts could not be loaded.</p>
              <button type="button" disabled={refreshing} onClick={() => void refresh()}>
                Retry models
              </button>
            </section>
          ) : null}

          {connected.length === 0 ? null : (
            <section className="provider-group">
              <h3 className="provider-group-title">Connected</h3>
              <div className="provider-grid">
                {connected.map((provider) => renderCompactProviderCard(provider))}
              </div>
            </section>
          )}

          {available.length === 0 ? null : (
            <section className="provider-group">
              <h3 className="provider-group-title">Available</h3>
              <div className="provider-grid">
                {available.map((provider) => renderCompactProviderCard(provider))}
              </div>
            </section>
          )}
        </>
      )}

      {!helpOpen ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="page-card task-modal provider-help-modal"
            role="dialog"
            aria-modal="true"
            aria-label="How to use Providers"
          >
            <div className="task-modal-header">
              <div>
                <h3>Providers</h3>
                <p>Connect credentials, choose Profiles, and control model names.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close Provider help"
                onClick={() => setHelpOpen(false)}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>
            <ol className="provider-help-list">
              <li>
                <Power size={19} aria-hidden="true" />
                <div>
                  <strong>Connect</strong>
                  <p>Add an API key or sign in with an account.</p>
                </div>
              </li>
              <li>
                <UserRoundCheck size={19} aria-hidden="true" />
                <div>
                  <strong>Profiles</strong>
                  <p>Choose the active credential, reorder Profiles, and configure fallback.</p>
                </div>
              </li>
              <li>
                <Layers size={19} aria-hidden="true" />
                <div>
                  <strong>Models</strong>
                  <p>Search, publish, rename, and drag models into the order clients see.</p>
                </div>
              </li>
            </ol>
          </section>
        </div>
      )}

      {profilesProviderId === undefined ||
      selectedProfilesProvider === undefined ||
      selectedProfilesState === undefined ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="page-card task-modal secondary-card-modal profiles-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedProfilesProvider.name} profiles`}
          >
            <div className="task-modal-header">
              <div>
                <h3>Profiles</h3>
                <p>
                  {selectedProfilesProvider.name} · {selectedProfilesCount}{" "}
                  {selectedProfilesCount === 1 ? "profile" : "profiles"}
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close profiles"
                onClick={() => {
                  setEditingProfileId(undefined);
                  setProfileActionsId(undefined);
                  setProfilesProviderId(undefined);
                }}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>

            <div className="secondary-card-modal-body">
              {selectedProfilesState.profiles.length === 0 ? (
                <p>No Profiles have been added to this Provider.</p>
              ) : (
                <ul className="secondary-card-list profile-card-list">
                  {[...selectedProfilesState.profiles]
                    .sort(
                      (left, right) =>
                        left.priority - right.priority ||
                        left.createdAt - right.createdAt,
                    )
                    .map((profile) => {
                      const editing = editingProfileId === profile.credentialId;
                      const actionsOpen =
                        profileActionsId === profile.credentialId;
                      const active =
                        selectedProfilesState.activeCredentialId === profile.credentialId;
                      const AuthIcon =
                        profile.authType === "api_key" ? KeyRound : UserRoundCheck;
                      const authLabel =
                        profile.authType === "api_key" ? "API key" : "OAuth account";
                      const healthTone =
                        profile.health === "ready"
                          ? "good"
                          : profile.health === "reconnect_required"
                            ? "error"
                            : profile.health === "disabled"
                              ? "neutral"
                              : "warning";
                      return (
                        <li
                          className={`secondary-card profile-card${active ? " active" : ""}`}
                          data-profile-id={profile.credentialId}
                          draggable={!editing}
                          onDragStart={(event) => {
                            if (editing) {
                              event.preventDefault();
                              return;
                            }
                            draggingProfileId.current = profile.credentialId;
                            if (event.dataTransfer !== undefined) {
                              event.dataTransfer.effectAllowed = "move";
                            }
                          }}
                          onDragOver={(event) => {
                            event.preventDefault();
                            if (event.dataTransfer !== undefined) {
                              event.dataTransfer.dropEffect = "move";
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const sourceCredentialId = draggingProfileId.current;
                            draggingProfileId.current = undefined;
                            if (sourceCredentialId !== undefined) {
                              void reorderProviderProfiles(
                                selectedProfilesState,
                                sourceCredentialId,
                                profile.credentialId,
                              );
                            }
                          }}
                          onDragEnd={() => {
                            draggingProfileId.current = undefined;
                          }}
                          key={profile.credentialId}
                        >
                          <span
                            className="drag-handle"
                            aria-label={`Drag ${profile.displayName} to reorder`}
                            title="Drag to reorder"
                          >
                            <GripVertical size={20} aria-hidden="true" />
                          </span>

                          {editing ? (
                            <form
                              className="profile-metadata-editor"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveProfileMetadata(selectedProfilesState, profile);
                              }}
                            >
                              <label>
                                <span>Profile name</span>
                                <input
                                  value={editingProfileName}
                                  maxLength={64}
                                  onChange={(event) =>
                                    setEditingProfileName(event.currentTarget.value)}
                                />
                              </label>
                              <label>
                                <span>Note</span>
                                <textarea
                                  value={editingProfileNote}
                                  maxLength={200}
                                  onChange={(event) =>
                                    setEditingProfileNote(event.currentTarget.value)}
                                />
                              </label>
                              <div className="button-row compact">
                                <button type="submit">Save</button>
                                <button
                                  type="button"
                                  className="secondary"
                                  onClick={() => setEditingProfileId(undefined)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          ) : (
                            <>
                              <div className="secondary-card-copy">
                                <strong>{profile.displayName}</strong>
                                <span className="secondary-card-meta">
                                  <AuthIcon size={16} aria-hidden="true" />
                                  {authLabel}
                                  {profile.identityHint === undefined
                                    ? ""
                                    : ` · ${profile.identityHint}`}
                                </span>
                                <span className="secondary-card-meta">
                                  <span
                                    className={`status-dot ${healthTone}`}
                                    role="img"
                                    aria-label={profile.health.replaceAll("_", " ")}
                                    title={profile.health.replaceAll("_", " ")}
                                  />
                                  {profile.lastSucceededAt === undefined
                                    ? profile.health.replaceAll("_", " ")
                                    : `Last success ${new Date(profile.lastSucceededAt).toLocaleString()}`}
                                </span>
                              </div>

                              <label className="profile-active-choice">
                                <span className="sr-only">
                                  Use {profile.displayName} for new requests
                                </span>
                                <input
                                  type="radio"
                                  name={`active-profile-${selectedProfilesProvider.providerId}`}
                                  checked={active}
                                  disabled={!profile.enabled}
                                  onChange={() => {
                                    if (
                                      active ||
                                      selectedProfilesState.revision === undefined
                                    ) {
                                      return;
                                    }
                                    void executeProfileCommand({
                                      command: "activate",
                                      providerId: selectedProfilesProvider.providerId,
                                      credentialId: profile.credentialId,
                                      expectedRevision: selectedProfilesState.revision,
                                    });
                                  }}
                                />
                              </label>

                              <div className="profile-menu-wrap">
                                <button
                                  type="button"
                                  className="card-icon-button"
                                  aria-label={`More actions for ${profile.displayName}`}
                                  aria-expanded={actionsOpen}
                                  aria-controls="profile-actions-dialog"
                                  title="Profile actions"
                                  onClick={() =>
                                    setProfileActionsId(
                                      actionsOpen
                                        ? undefined
                                        : profile.credentialId,
                                    )}
                                >
                                  <MoreHorizontal size={20} aria-hidden="true" />
                                </button>
                              </div>
                            </>
                          )}
                        </li>
                      );
                    })}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}

      {profileActions === undefined ||
      selectedProfilesProvider === undefined ||
      selectedProfilesState === undefined ? null : (
        <div className="modal-backdrop profile-actions-backdrop" role="presentation">
          <section
            id="profile-actions-dialog"
            className="page-card task-modal profile-actions-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Actions for ${profileActions.displayName}`}
          >
            <div className="profile-actions-header">
              <div>
                <p className="eyebrow">PROFILE ACTIONS</p>
                <h3>{profileActions.displayName}</h3>
                <p className="profile-actions-auth">
                  <ProfileActionsAuthIcon size={16} aria-hidden="true" />
                  {profileActions.authType === "api_key"
                    ? "API key"
                    : "OAuth account"}
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close Profile actions"
                onClick={() => setProfileActionsId(undefined)}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>

            <div className="profile-actions-list">
              <button
                type="button"
                aria-label="Rename / note"
                onClick={() => {
                  setProfileActionsId(undefined);
                  setEditingProfileId(profileActions.credentialId);
                  setEditingProfileName(profileActions.displayName);
                  setEditingProfileNote(profileActions.note ?? "");
                }}
              >
                <Pencil size={18} aria-hidden="true" />
                <span>
                  <strong>Rename / note</strong>
                  <small>Edit Profile-owned labels</small>
                </span>
              </button>
              {profileActionsMethod?.interactive === true ? (
                <button
                  type="button"
                  aria-label="Reconnect"
                  onClick={() => {
                    setProfileActionsId(undefined);
                    openReconnect(selectedProfilesProvider, profileActions);
                  }}
                >
                  <RefreshCw size={18} aria-hidden="true" />
                  <span>
                    <strong>Reconnect</strong>
                    <small>Replace this Profile's sign-in</small>
                  </span>
                </button>
              ) : null}
              {selectedProfilesState.activeCredentialId ===
              profileActions.credentialId ? (
                <button
                  type="button"
                  aria-label="Recheck"
                  onClick={() => {
                    setProfileActionsId(undefined);
                    if (selectedProfilesState.revision === undefined) return;
                    void executeProfileCommand({
                      command: "recheck",
                      providerId: selectedProfilesProvider.providerId,
                      credentialId: profileActions.credentialId,
                      expectedRevision: selectedProfilesState.revision,
                    });
                  }}
                >
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span>
                    <strong>Recheck</strong>
                    <small>Verify this Profile now</small>
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                aria-label={profileActions.enabled ? "Disable" : "Enable"}
                onClick={() => {
                  setProfileActionsId(undefined);
                  if (selectedProfilesState.revision === undefined) return;
                  void executeProfileCommand({
                    command: "set_enabled",
                    providerId: selectedProfilesProvider.providerId,
                    credentialId: profileActions.credentialId,
                    expectedRevision: selectedProfilesState.revision,
                    enabled: !profileActions.enabled,
                  });
                }}
              >
                <Power size={18} aria-hidden="true" />
                <span>
                  <strong>{profileActions.enabled ? "Disable" : "Enable"}</strong>
                  <small>
                    {profileActions.enabled
                      ? "Stop using this Profile"
                      : "Allow this Profile to be used"}
                  </small>
                </span>
              </button>
              <button
                type="button"
                className="danger-menu-item"
                aria-label="Remove"
                onClick={() => {
                  setProfileActionsId(undefined);
                  void removeProfile(selectedProfilesState, profileActions);
                }}
              >
                <Trash2 size={18} aria-hidden="true" />
                <span>
                  <strong>Remove</strong>
                  <small>Disconnect from Token</small>
                </span>
              </button>
            </div>
          </section>
        </div>
      )}

      {authModal === undefined || authProvider === undefined ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="page-card task-modal auth-interaction"
            role="dialog"
            aria-modal="true"
            aria-label={`${authProvider.name} sign in`}
          >
            <div className="task-modal-header">
              <div>
                <p className="eyebrow">
                  {authMethod?.authMethodLabel ?? "Provider credential"}
                </p>
                <h3>{authProvider.name}</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close sign in"
                onClick={cancelAuth}
              >
                ×
              </button>
            </div>

            <div className="settings-action-row">
              <div className="settings-action-copy">
                <strong>Switch Profiles after HTTP 429</strong>
                <p>{authSwitchPolicy === undefined
                  ? "Add a Profile to configure switching."
                  : "Only within this Provider and sign-in method."}</p>
              </div>
              <button
                type="button"
                className={`switch-control${authFallbackOn ? " on" : ""}`}
                aria-label={`${authFallbackOn ? "Disable" : "Enable"} HTTP 429 Profile switching for ${authProvider.name} ${authMethod?.authMethodLabel ?? authModal.authType}`}
                aria-pressed={authFallbackOn ?? false}
                disabled={busyProvider !== undefined || authSwitchPolicy === undefined}
                onClick={toggleAuthFallback}
                title={authFallbackOn ? "Disable HTTP 429 Profile switching" : "Enable HTTP 429 Profile switching"}
              >
                <span aria-hidden="true" />
              </button>
            </div>

            {authOutcome !== undefined ? (
              <div className={`auth-outcome ${authOutcome.kind}`}>
                <strong>{authOutcome.kind === "success" ? "Connected" : authOutcome.kind === "cancelled" ? "Cancelled" : "Could not connect"}</strong>
                <p>{authOutcome.message}</p>
                <button
                  type="button"
                  onClick={() => {
                    setAuthModal(undefined);
                    setAuthOutcome(undefined);
                  }}
                >
                  Close
                </button>
              </div>
            ) : (
              !authStarted ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void startAuth(
                      authModal.authType === "api_key" ? apiKeyValue : undefined,
                    );
                  }}
                >
                  {authModal.mode === "add" ? (
                    <>
                      <label>
                        <span>Profile name</span>
                        <input
                          value={profileName}
                          maxLength={64}
                          autoFocus={authModal.authType !== "api_key"}
                          onChange={(event) => setProfileName(event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        <span>Note (optional)</span>
                        <textarea
                          value={profileNote}
                          maxLength={200}
                          onChange={(event) => setProfileNote(event.currentTarget.value)}
                        />
                      </label>
                    </>
                  ) : (
                    <p>Reconnect {profileName} using {authMethod?.authMethodLabel}.</p>
                  )}
                  {authModal.authType === "api_key" ? (
                    <label>
                      <span>API key</span>
                      <input
                        type="password"
                        value={apiKeyValue}
                        autoFocus
                        autoComplete="off"
                        onChange={(event) => setApiKeyValue(event.currentTarget.value)}
                      />
                    </label>
                  ) : null}
                  {authModal.mode === "add" ? <label>
                    <input
                      type="checkbox"
                      checked={useNow}
                      onChange={(event) => setUseNow(event.currentTarget.checked)}
                    />
                    Use this Profile for new requests
                  </label> : null}
                  <div className="button-row">
                    <button
                      type="submit"
                      disabled={
                        (authModal.mode === "add" && profileName.trim().length === 0) ||
                        (authModal.authType === "api_key" && apiKeyValue.length === 0)
                      }
                    >
                      {authModal.mode === "add" ? "Continue" : "Reconnect"}
                    </button>
                    <button type="button" className="secondary" onClick={cancelAuth}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
              <>
                {authModal.authType === "oauth" && externalInteraction === undefined && interaction === undefined ? (
                  <p>Connecting…</p>
                ) : null}
                {authModal.authType === "api_key" && externalInteraction === undefined && interaction === undefined ? (
                  <p>Connecting…</p>
                ) : null}

                {externalInteraction?.type === "auth_url" ? (
                  <div className="auth-browser-status">
                    <strong>Continue in your browser</strong>
                    <p>{externalInteraction.instructions ?? "Complete sign-in in your browser."}</p>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void api.platform.openExternal(externalInteraction.url)}
                    >
                      Open browser
                    </button>
                  </div>
                ) : null}

                {externalInteraction?.type === "device_code" ? (
                  <div className="auth-browser-status">
                    <strong>Enter this code in your browser</strong>
                    <div className="device-code">{externalInteraction.userCode}</div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void api.platform.openExternal(externalInteraction.verificationUri)}
                    >
                      Open browser
                    </button>
                  </div>
                ) : null}

                {interaction?.type === "progress" || interaction?.type === "info" ? (
                  <p>{interaction.message}</p>
                ) : null}

                {interaction?.type === "prompt" ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitPrompt();
                    }}
                  >
                    <label>
                      <span>{interaction.message}</span>
                      {interaction.kind === "select" ? (
                        <select
                          value={promptValue}
                          onChange={(event) => setPromptValue(event.currentTarget.value)}
                        >
                          <option value="">Choose…</option>
                          {interaction.options?.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={interaction.kind === "secret" ? "password" : "text"}
                          placeholder={interaction.placeholder}
                          value={promptValue}
                          onChange={(event) => setPromptValue(event.currentTarget.value)}
                          autoFocus
                        />
                      )}
                    </label>
                    <button type="submit" disabled={promptValue.length === 0}>Continue</button>
                  </form>
                ) : null}

                {busyProvider === undefined ? null : (
                  <button type="button" className="secondary" onClick={cancelAuth}>
                    Cancel
                  </button>
                )}
              </>
              )
            )}
          </section>
        </div>
      )}

      </>)}

      {!modelsDialogOpen ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className={`page-card task-modal models-modal${favoriteModelsOpen ? " favorite-models-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={modelsDialogLabel}
          >
            <div className="task-modal-header">
              <div>
                <h3>{favoriteModelsOpen ? "Favorite models" : "Models"}</h3>
                <p>
                  {favoriteModelsOpen
                    ? `${favoriteModelRows.length} favorite model${favoriteModelRows.length === 1 ? "" : "s"} across all Providers`
                    : selectedModelsProvider?.name}
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={favoriteModelsOpen ? "Close favorite models" : "Close models"}
                onClick={() => {
                  setEditingRow(undefined);
                  setModelSearch("");
                  setModelsProviderId(undefined);
                  if (favoriteModelsOpen) onCloseFavoriteModels?.();
                }}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>

            <div className="models-modal-body">
              <label className="model-search">
                <span className="sr-only">Search models</span>
                <input
                  type="search"
                  aria-label="Search models"
                  placeholder="Search models…"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.currentTarget.value)}
                />
              </label>
              {selectedModelRows.length === 0 ? (
                <p className="models-empty-state">
                  {favoriteModelsOpen
                    ? normalizedModelSearch.length === 0
                      ? "No favorite models yet. Open a Provider's Models list and select the star beside a model."
                      : "No favorite models match this search."
                    : "No models are currently available for this provider."}
                </p>
              ) : (
                <ul className="secondary-card-list model-card-list">
                  {selectedModelRows.map((row) => {
                  const editing =
                    editingRow?.providerId === row.providerId &&
                    editingRow.modelId === row.modelId;
                  return (
                    <li
                      className="secondary-card model-card"
                      data-model-id={row.modelId}
                      draggable={!favoriteModelsOpen && normalizedModelSearch.length === 0}
                      onDragStart={(event) => {
                        if (favoriteModelsOpen || normalizedModelSearch.length !== 0) {
                          event.preventDefault();
                          return;
                        }
                        draggingModelId.current = row.modelId;
                        if (event.dataTransfer !== undefined) {
                          event.dataTransfer.effectAllowed = "move";
                        }
                      }}
                      onDragOver={(event) => {
                        if (!favoriteModelsOpen && normalizedModelSearch.length === 0) {
                          event.preventDefault();
                          if (event.dataTransfer !== undefined) {
                            event.dataTransfer.dropEffect = "move";
                          }
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const sourceModelId = draggingModelId.current;
                        draggingModelId.current = undefined;
                        if (sourceModelId !== undefined) {
                          void reorderProviderModels(
                            row.providerId,
                            sourceModelId,
                            row.modelId,
                          );
                        }
                      }}
                      onDragEnd={() => {
                        draggingModelId.current = undefined;
                      }}
                      key={`${row.providerId}\u0000${row.modelId}`}
                    >
                      <span
                        className="drag-handle"
                        aria-label={`Drag ${row.modelName} to reorder`}
                        title={
                          !favoriteModelsOpen && normalizedModelSearch.length === 0
                            ? "Drag to reorder"
                            : favoriteModelsOpen
                              ? "Open this Provider's Models list to reorder"
                              : "Clear search to reorder"
                        }
                      >
                        <GripVertical size={20} aria-hidden="true" />
                      </span>
                      <div className="secondary-card-copy">
                        <strong className="model-card-title">
                          <span
                            className={`status-dot ${row.availability === "available" ? "good" : "neutral"}`}
                            role="img"
                            aria-label={`${row.modelName} is ${row.availability}`}
                            title={row.availability}
                          />
                          <span>{row.modelName}</span>
                        </strong>
                        {favoriteModelsOpen ? (
                          <span className="canonical-model-id">
                            Provider: {allProviders.find((provider) => provider.providerId === row.providerId)?.name ?? row.providerId}
                            {row.modelName === row.modelId ? "" : ` · Original model: ${row.modelId}`}
                            {row.api === undefined ? "" : ` · Pi API: ${row.api}`}
                          </span>
                        ) : row.modelName === row.modelId ? (
                          row.api === undefined ? null : (
                            <span className="canonical-model-id">Pi API: {row.api}</span>
                          )
                        ) : (
                          <span className="canonical-model-id">
                            Original model: {row.modelId}
                            {row.api === undefined ? "" : ` · Pi API: ${row.api}`}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className={`favorite-button${row.favorite ? " active" : ""}`}
                        aria-label={`${row.favorite ? "Unfavorite" : "Favorite"} ${row.modelName}`}
                        aria-pressed={row.favorite}
                        onClick={() => void setModelFavorite(row, !row.favorite)}
                        title="Favorite models are included when an Agent uses Favorite scope."
                      >
                        <Star
                          size={17}
                          fill={row.favorite ? "currentColor" : "none"}
                          aria-hidden="true"
                        />
                      </button>
                      <button
                        type="button"
                        className={`switch-control${row.on ? " on" : ""}`}
                        aria-label={`${row.on ? "Hide" : "Publish"} ${row.modelName}`}
                        title="Hidden models are removed from discovery, but a known alias remains directly callable."
                        aria-pressed={row.on}
                        onClick={() => void setModelOn(row, !row.on)}
                      >
                        <span aria-hidden="true" />
                      </button>
                      {editing ? (
                        <form
                          className="model-name-editor"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveModelName();
                          }}
                        >
                          <label>
                            <span>Model name</span>
                            <div className="model-name-input">
                              <span className="model-name-prefix">{row.providerId}/</span>
                              <input
                                type="text"
                                value={modelNameValue}
                                onChange={(event) => setModelNameValue(event.currentTarget.value)}
                                autoFocus
                              />
                            </div>
                          </label>
                          {modelNameError === undefined ? null : (
                            <p className="error-text" role="alert">{modelNameError}</p>
                          )}
                          <div className="model-name-editor-actions">
                            <button
                              type="submit"
                              className="card-icon-button model-editor-save"
                              aria-label="Save model name"
                              aria-busy={modelNameBusy}
                              title="Save model name"
                              disabled={modelNameBusy || modelNameValue.trim().length === 0}
                            >
                              <Save size={18} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="card-icon-button"
                              aria-label="Cancel editing"
                              title="Cancel editing"
                              disabled={modelNameBusy}
                              onClick={() => setEditingRow(undefined)}
                            >
                              <X size={19} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="card-icon-button"
                              aria-label="Restore default name"
                              title="Restore default name"
                              disabled={modelNameBusy}
                              onClick={() => void restoreModelName(row)}
                            >
                              <RotateCcw size={18} aria-hidden="true" />
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="card-icon-button"
                          aria-label={`Rename ${row.modelName ?? row.modelId}`}
                          title="Rename model"
                          disabled={row.modelName === undefined}
                          onClick={() => openModelEditor(row)}
                        >
                          <Pencil size={18} aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
