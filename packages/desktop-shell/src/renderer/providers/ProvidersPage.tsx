import { useEffect, useMemo, useRef, useState } from "react";
import { Star } from "lucide-react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type ProfilesResult = Awaited<
  ReturnType<LuckyTokenDesktopApi["control"]["executeCredentialProfiles"]>
>;
type ProviderOption = NonNullable<ProfilesResult["options"]>["providers"][number];
type ProviderProfiles = ProfilesResult["state"]["providers"][number];
type CredentialProfile = ProviderProfiles["profiles"][number];
type ProfileAuthResult = Awaited<
  ReturnType<LuckyTokenDesktopApi["control"]["executeProviderProfileAuth"]>
>;
type AuthListener = NonNullable<
  Parameters<LuckyTokenDesktopApi["control"]["executeProviderProfileAuth"]>[1]
>;
type AuthEvent = Parameters<AuthListener>[0];
type ExternalAuthEvent = Extract<
  AuthEvent,
  { readonly type: "auth_url" | "device_code" }
>;
type InlineAuthEvent = Exclude<AuthEvent, ExternalAuthEvent>;
type CatalogResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeCatalog"]>>;
type ProviderSource = ProviderOption["source"];
type AuthType = "oauth" | "api_key";

const SOURCE_LABELS: Readonly<Record<ProviderSource, string>> = Object.freeze({
  pi_builtin: "Built in",
  luckytoken_bundled: "LuckyToken",
  user: "Custom",
});

export interface ProviderModelRow {
  readonly providerId: string;
  readonly modelId: string;
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

export function ProvidersPage({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [profileState, setProfileState] = useState<ProfilesResult["state"]>({
    providers: [],
  });
  const [catalog, setCatalog] = useState<CatalogResult>();
  const [publicModels, setPublicModels] = useState<Awaited<
    ReturnType<LuckyTokenDesktopApi["control"]["executePublicModels"]>
  >>();
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [search, setSearch] = useState("");
  const [busyProvider, setBusyProvider] = useState<string>();
  const [authModal, setAuthModal] = useState<AuthModalState>();
  const [authOutcome, setAuthOutcome] = useState<AuthOutcome>();
  const [externalInteraction, setExternalInteraction] = useState<ExternalAuthEvent>();
  const [interaction, setInteraction] = useState<InlineAuthEvent>();
  const [promptValue, setPromptValue] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileNote, setProfileNote] = useState("");
  const [useNow, setUseNow] = useState(true);
  const [authStarted, setAuthStarted] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string>();
  const [editingProfileName, setEditingProfileName] = useState("");
  const [editingProfileNote, setEditingProfileNote] = useState("");
  const [notice, setNotice] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [modelsProviderId, setModelsProviderId] = useState<string>();
  const [editingRow, setEditingRow] = useState<ProviderModelRow>();
  const [modelNameValue, setModelNameValue] = useState("");
  const [modelNameBusy, setModelNameBusy] = useState(false);
  const [modelNameError, setModelNameError] = useState<string>();
  const seenCatalogVersion = useRef(-1);

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
      const availabilityByModel = new Map(
        catalogProvider?.models.map((model) => [model.id, model.availability]) ?? [],
      );
      for (const model of provider.models) {
        const modelName = modelNameFromInternalAlias(provider.providerId, model.alias);
        if (modelName === undefined) continue;
        rows.push({
          providerId: provider.providerId,
          modelId: model.target,
          availability: availabilityByModel.get(model.target) ?? "unavailable",
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
    setUseNow(true);
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

  const startAuth = async (): Promise<void> => {
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
      LuckyTokenDesktopApi["control"]["executeCredentialProfiles"]
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
        ? "Disconnect from LuckyToken"
        : "Remove from LuckyToken";
    if (
      !window.confirm(
        `${action}: ${profile.displayName} (${profile.authMethodLabel})? This removes only LuckyToken's local credential. The credential may remain valid at the Provider; revoke it in the Provider's account or security settings when needed. Historical Activity snapshots remain.`,
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
      const revision = publicModels?.state.revision ?? 0;
      const result = await api.control.executePublicModels({
        command: "rename_model",
        revision,
        providerId: row.providerId,
        modelId: row.modelId,
        modelName: trimmed,
      });
      if (result.outcome !== "ok") {
        setModelNameError(
          result.outcome === "conflict"
            ? "Model names changed. Refresh and try again."
            : "The model name could not be saved.",
        );
        const next = await api.control
          .executePublicModels({ command: "query" })
          .catch(() => undefined);
        if (next !== undefined) setPublicModels(next);
        return;
      }
      setPublicModels(result);
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
      const revision = publicModels?.state.revision ?? 0;
      const result = await api.control.executePublicModels({
        command: "restore_model_name",
        revision,
        providerId: row.providerId,
        modelId: row.modelId,
      });
      if (result.outcome !== "ok") {
        setModelNameError(
          result.outcome === "conflict"
            ? "Model names changed. Refresh and try again."
            : "The default model name could not be restored.",
        );
        return;
      }
      setPublicModels(result);
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
    const state = publicModels?.state;
    if (state === undefined) return;
    const result = await api.control.executePublicModels({
      command: "set_provider",
      revision: state.revision,
      providerId,
      on,
    });
    setPublicModels(result);
    if (result.outcome === "unavailable") {
      setNotice("Sign in before turning this provider on.");
    }
  };

  const setProviderFavorite = async (
    providerId: string,
    favorite: boolean,
  ): Promise<void> => {
    const state = publicModels?.state;
    if (state === undefined) return;
    const result = await api.control.executePublicModels({
      command: "set_provider_favorite",
      revision: state.revision,
      providerId,
      favorite,
    });
    setPublicModels(result);
    if (result.outcome === "limit_exceeded") {
      setNotice("You can favorite up to 5 providers.");
    }
  };

  const setModelOn = async (row: ProviderModelRow, on: boolean): Promise<void> => {
    const state = publicModels?.state;
    if (state === undefined) return;
    const result = await api.control.executePublicModels({
      command: "set_model",
      revision: state.revision,
      providerId: row.providerId,
      modelId: row.modelId,
      on,
    });
    setPublicModels(result);
  };

  const setModelFavorite = async (
    row: ProviderModelRow,
    favorite: boolean,
  ): Promise<void> => {
    const state = publicModels?.state;
    if (state === undefined) return;
    const result = await api.control.executePublicModels({
      command: "set_model_favorite",
      revision: state.revision,
      providerId: row.providerId,
      modelId: row.modelId,
      favorite,
    });
    setPublicModels(result);
    if (result.outcome === "limit_exceeded") {
      setNotice("You can favorite up to 10 models.");
    }
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
  const connected = visible
    .filter(
      (provider) =>
        (profileByProvider.get(provider.providerId)?.profiles.length ?? 0) > 0,
    )
    .sort(favoriteFirst);
  const available = visible
    .filter(
      (provider) =>
        (profileByProvider.get(provider.providerId)?.profiles.length ?? 0) === 0,
    )
    .sort(favoriteFirst);

  const selectedModelsProvider =
    modelsProviderId === undefined
      ? undefined
      : allProviders.find((provider) => provider.providerId === modelsProviderId);
  const selectedModelRows =
    modelsProviderId === undefined
      ? []
      : modelRows.filter((row) => row.providerId === modelsProviderId);
  const authProvider =
    authModal === undefined
      ? undefined
      : allProviders.find((provider) => provider.providerId === authModal.providerId);
  const authMethod = authProvider?.authMethods.find(
    (method) => method.authType === authModal?.authType,
  );

  const renderProviderCard = (provider: ProviderOption): React.ReactElement => {
    const managed = profileByProvider.get(provider.providerId);
    const availability = catalogByProvider.get(provider.providerId);
    const publicProvider = publicProviderById.get(provider.providerId);
    const availableModels =
      availability?.models.filter(
        (model) => model.availability === "available",
      ).length ?? 0;
    const knownModels = publicProvider?.models.length ?? 0;
    const publishedModels = publicProvider?.models.filter((model) => model.on).length ?? 0;
    const active = managed?.profiles.find(
      (profile) => profile.credentialId === managed.activeCredentialId,
    );
    const isConnected =
      active !== undefined && active.health !== "reconnect_required";
    const providerOn = publicProvider?.on ?? false;
    const providerFavorite = publicProvider?.favorite ?? false;
    const catalogFailed = availability?.state === "failed";
    return (
      <article className="page-card provider-card" key={provider.providerId}>
        <div className="provider-title">
          <div>
            <h3>{provider.name}</h3>
            <p className="provider-source">{SOURCE_LABELS[provider.source]}</p>
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
                size={17}
                fill={providerFavorite ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
            <span className={`badge ${isConnected ? "good" : "warning"}`}>
              {managed?.recordError !== undefined
                ? "Stored record error"
                : managed?.implementationAvailable === false
                  ? "Provider unavailable"
                  : active?.health === "reconnect_required"
                    ? "Reconnect required"
                    : active !== undefined
                      ? `Active: ${active.displayName}`
                      : (managed?.profiles.length ?? 0) > 0
                        ? "Select a Profile"
                        : managed?.ambient !== undefined
                          ? "External auth available"
                          : "Not connected"}
            </span>
            <button
              type="button"
              className="provider-publish-toggle"
              aria-label={`${providerOn ? "Hide" : "Publish"} ${provider.name}`}
              title="Hidden providers are removed from discovery, but a known model alias remains directly callable."
              aria-pressed={providerOn}
              disabled={publicProvider === undefined || (!providerOn && !isConnected)}
              onClick={() => void setProviderOn(provider.providerId, !providerOn)}
            >
              {providerOn ? "Published" : "Hidden"}
            </button>
          </div>
        </div>
        <p>
          {knownModels === 0
            ? "Models unavailable"
            : `${publishedModels} published · ${availableModels} currently available`}
        </p>
        {catalogFailed ? (
          <p className="error-text">
            {availability?.error ?? "Provider refresh failed"}
          </p>
        ) : null}
        {managed?.recordError === undefined ? null : (
          <p className="error-text" role="alert">{managed.recordError.message}</p>
        )}
        {(managed?.profiles.length ?? 0) === 0 ? (
          <p>
            {managed?.ambient?.message ??
              "Add a named Provider credential Profile to manage it in LuckyToken."}
          </p>
        ) : (
          <ul className="credential-profile-list">
            {managed!.profiles.map((profile) => {
              const editing = editingProfileId === profile.credentialId;
              const method = provider.authMethods.find(
                (candidate) => candidate.authType === profile.authType,
              );
              return (
                <li className="credential-profile-row" key={profile.credentialId}>
                  {editing ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveProfileMetadata(managed!, profile);
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
                      <div>
                        <strong>{profile.displayName}</strong>
                        <span className="provider-source">
                          {profile.authMethodLabel}
                          {profile.identityHint === undefined
                            ? ""
                            : ` · ${profile.identityHint}`}
                          {profile.credentialId === managed!.activeCredentialId
                            ? " · Active"
                            : ""}
                          {` · ${profile.health.replaceAll("_", " ")}`}
                        </span>
                        {profile.note === undefined ? null : <p>{profile.note}</p>}
                        {profile.lastUsedAt === undefined ? null : (
                          <span className="provider-source">
                            Last used {new Date(profile.lastUsedAt).toLocaleString()}
                            {profile.lastSucceededAt === undefined
                              ? ""
                              : ` · Last success ${new Date(profile.lastSucceededAt).toLocaleString()}`}
                          </span>
                        )}
                      </div>
                      <div className="button-row compact">
                        {profile.credentialId === managed!.activeCredentialId ||
                        !profile.enabled ? null : (
                          <button
                            type="button"
                            onClick={() =>
                              void executeProfileCommand({
                                command: "activate",
                                providerId: provider.providerId,
                                credentialId: profile.credentialId,
                                expectedRevision: managed!.revision!,
                              })}
                          >
                            Use now
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            void executeProfileCommand({
                              command: "set_enabled",
                              providerId: provider.providerId,
                              credentialId: profile.credentialId,
                              expectedRevision: managed!.revision!,
                              enabled: !profile.enabled,
                            })}
                        >
                          {profile.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setEditingProfileId(profile.credentialId);
                            setEditingProfileName(profile.displayName);
                            setEditingProfileNote(profile.note ?? "");
                          }}
                        >
                          Rename / note
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Move ${profile.displayName} earlier`}
                          onClick={() =>
                            void executeProfileCommand({
                              command: "set_priority",
                              providerId: provider.providerId,
                              credentialId: profile.credentialId,
                              expectedRevision: managed!.revision!,
                              priority: profile.priority - 1,
                            })}
                        >
                          Earlier
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Move ${profile.displayName} later`}
                          onClick={() =>
                            void executeProfileCommand({
                              command: "set_priority",
                              providerId: provider.providerId,
                              credentialId: profile.credentialId,
                              expectedRevision: managed!.revision!,
                              priority: profile.priority + 1,
                            })}
                        >
                          Later
                        </button>
                        {method?.interactive === true ? (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => openReconnect(provider, profile)}
                          >
                            Reconnect
                          </button>
                        ) : null}
                        {profile.credentialId === managed!.activeCredentialId ? (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              void executeProfileCommand({
                                command: "recheck",
                                providerId: provider.providerId,
                                credentialId: profile.credentialId,
                                expectedRevision: managed!.revision!,
                              })}
                          >
                            Recheck
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void removeProfile(managed!, profile)}
                        >
                          {profile.authType === "oauth"
                            ? "Disconnect from LuckyToken"
                            : "Remove from LuckyToken"}
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {managed?.switchPolicy === undefined || managed.revision === undefined ? null : (
          <fieldset className="credential-switch-settings">
            <legend>HTTP 429 switching</legend>
            {provider.authMethods.map((method) => (
              <label key={method.authType}>
                <input
                  type="checkbox"
                  checked={
                    method.authType === "api_key"
                      ? managed.switchPolicy!.apiKeyOn429
                      : managed.switchPolicy!.oauthOn429
                  }
                  onChange={(event) =>
                    void executeProfileCommand({
                      command: "set_switch_policy",
                      providerId: provider.providerId,
                      expectedRevision: managed.revision!,
                      apiKeyOn429:
                        method.authType === "api_key"
                          ? event.currentTarget.checked
                          : managed.switchPolicy!.apiKeyOn429,
                      oauthOn429:
                        method.authType === "oauth"
                          ? event.currentTarget.checked
                          : managed.switchPolicy!.oauthOn429,
                    })}
                />
                Try the next {method.authMethodLabel} after HTTP 429
              </label>
            ))}
          </fieldset>
        )}
        <div className="button-row">
          {provider.authMethods.filter((method) => method.interactive).map((method) => (
            <button
              key={method.authType}
              type="button"
              disabled={busyProvider !== undefined}
              onClick={() => openAdd(provider, method.authType)}
            >
              Add {method.authMethodLabel}
            </button>
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setEditingRow(undefined);
              setModelsProviderId(provider.providerId);
            }}
          >
            Models{knownModels === 0 ? "" : ` ${knownModels}`}
          </button>
          {catalogFailed ? (
            <button
              type="button"
              className="secondary"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              Retry models
            </button>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <section className="page-stack">
      <div className="page-card section-heading">
        <div>
          <p className="eyebrow">AI SERVICES</p>
          <h2>Providers</h2>
          <p>Find a provider, connect it, and manage the model names you use.</p>
        </div>
        <button type="button" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh models"}
        </button>
      </div>

      {notice === undefined ? null : (
        <p className="product-notice" role="status">{notice}</p>
      )}

      {authError ? (
        <section className="page-card" role="alert">
          <h3>Provider state is temporarily unavailable</h3>
          <p>LuckyToken could not reach Provider management.</p>
          <button type="button" onClick={queryPageFacts}>Retry</button>
        </section>
      ) : (
        <>
          <label className="provider-search">
            <span className="sr-only">Search providers</span>
            <input
              type="search"
              placeholder="Search providers…"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </label>

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
                {connected.map((provider) => renderProviderCard(provider))}
              </div>
            </section>
          )}

          {available.length === 0 ? null : (
            <section className="provider-group">
              <h3 className="provider-group-title">Available</h3>
              <div className="provider-grid">
                {available.map((provider) => renderProviderCard(provider))}
              </div>
            </section>
          )}
        </>
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
                    void startAuth();
                  }}
                >
                  {authModal.mode === "add" ? (
                    <>
                      <label>
                        <span>Profile name</span>
                        <input
                          value={profileName}
                          maxLength={64}
                          autoFocus
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
                  <label>
                    <input
                      type="checkbox"
                      checked={useNow}
                      onChange={(event) => setUseNow(event.currentTarget.checked)}
                    />
                    Use this Profile for new requests
                  </label>
                  <div className="button-row">
                    <button
                      type="submit"
                      disabled={authModal.mode === "add" && profileName.trim().length === 0}
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
                  <p>Opening your browser…</p>
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
                      Open browser again
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
                      Open browser again
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

      {modelsProviderId === undefined || selectedModelsProvider === undefined ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="page-card task-modal models-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedModelsProvider.name} models`}
          >
            <div className="task-modal-header">
              <div>
                <p className="eyebrow">MODELS</p>
                <h3>{selectedModelsProvider.name}</h3>
                <p>{selectedModelRows.length} model{selectedModelRows.length === 1 ? "" : "s"}</p>
                <p>Hidden models leave discovery but remain callable by a known alias.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close models"
                onClick={() => {
                  setEditingRow(undefined);
                  setModelsProviderId(undefined);
                }}
              >
                ×
              </button>
            </div>

            <div className="models-modal-body">
              {selectedModelRows.length === 0 ? (
                <p>No models are currently available for this provider.</p>
              ) : (
                <ul className="provider-model-list">
                  {selectedModelRows.map((row) => {
                  const editing =
                    editingRow?.providerId === row.providerId &&
                    editingRow.modelId === row.modelId;
                  return (
                    <li className="provider-model-row" key={`${row.providerId}\u0000${row.modelId}`}>
                      <div className="provider-model-copy">
                        <strong>{row.modelName ?? "Model name unavailable"}</strong>
                        {row.modelName === row.modelId ? null : (
                          <span className="canonical-model-id">Original model: {row.modelId}</span>
                        )}
                      </div>
                      <span className={`badge ${row.availability === "available" ? "good" : "neutral"}`}>
                        {row.availability}
                      </span>
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
                        className="provider-publish-toggle"
                        aria-label={`${row.on ? "Hide" : "Publish"} ${row.modelName}`}
                        title="Hidden models are removed from discovery, but a known alias remains directly callable."
                        aria-pressed={row.on}
                        onClick={() => void setModelOn(row, !row.on)}
                      >
                        {row.on ? "Published" : "Hidden"}
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
                          <div className="button-row compact">
                            <button type="submit" disabled={modelNameBusy || modelNameValue.trim().length === 0}>
                              {modelNameBusy ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={modelNameBusy}
                              onClick={() => setEditingRow(undefined)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={modelNameBusy}
                              onClick={() => void restoreModelName(row)}
                            >
                              Restore default
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Rename ${row.modelName ?? row.modelId}`}
                          disabled={row.modelName === undefined}
                          onClick={() => openModelEditor(row)}
                        >
                          Rename
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
