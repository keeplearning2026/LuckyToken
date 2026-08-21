import { useEffect, useMemo, useRef, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type AuthResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeAuth"]>>;
type ProviderOption = NonNullable<AuthResult["options"]>["providers"][number];
type AuthListener = NonNullable<Parameters<LuckyTokenDesktopApi["control"]["executeAuth"]>[1]>;
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
}

interface AuthModalState {
  readonly providerId: string;
  readonly authType: AuthType;
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
      .executeAuth({ command: "query" })
      .then((auth) => {
        setProviders(auth.options?.providers ?? []);
        setAuthError(auth.outcome !== "ok");
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
      .executeAuth({ command: "query" })
      .then((auth) => {
        if (!active) return;
        setProviders(auth.options?.providers ?? []);
        setAuthError(auth.outcome !== "ok");
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
        });
      }
    }
    return rows;
  }, [catalogByProvider, publicModels]);

  const applyAuthState = (result: AuthResult): void => {
    const statuses = new Map(
      result.state.providers.map((status) => [status.providerId, status]),
    );
    setProviders((current) =>
      current.map((provider) => {
        const status = statuses.get(provider.providerId);
        return status === undefined ? provider : { ...provider, status };
      }),
    );
  };

  const clearAuthInteraction = (): void => {
    setExternalInteraction(undefined);
    setInteraction(undefined);
    setPromptValue("");
  };

  const login = async (
    provider: ProviderOption,
    authType: AuthType,
  ): Promise<void> => {
    setBusyProvider(provider.providerId);
    setAuthModal({ providerId: provider.providerId, authType });
    setAuthOutcome(undefined);
    clearAuthInteraction();
    setNotice(undefined);
    try {
      const result = await api.control.executeAuth(
        { command: "login", providerId: provider.providerId, authType },
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
      applyAuthState(result);
      if (result.outcome === "ok") {
        setAuthOutcome({
          kind: "success",
          message: `${provider.name} connected.`,
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

  if (loading) {
    return (
      <section className="page-card">
        <p>Loading providers…</p>
      </section>
    );
  }

  const normalizedSearch = search.trim().toLowerCase();
  const visible = providers.filter(
    (provider) =>
      normalizedSearch.length === 0 ||
      provider.name.toLowerCase().includes(normalizedSearch) ||
      provider.providerId.toLowerCase().includes(normalizedSearch),
  );
  const connected = visible.filter(
    (provider) => !provider.status.unavailable && !provider.status.expired,
  );
  const available = visible.filter(
    (provider) => provider.status.unavailable || provider.status.expired,
  );

  const selectedModelsProvider =
    modelsProviderId === undefined
      ? undefined
      : providers.find((provider) => provider.providerId === modelsProviderId);
  const selectedModelRows =
    modelsProviderId === undefined
      ? []
      : modelRows.filter((row) => row.providerId === modelsProviderId);
  const authProvider =
    authModal === undefined
      ? undefined
      : providers.find((provider) => provider.providerId === authModal.providerId);

  const renderProviderCard = (provider: ProviderOption): React.ReactElement => {
    const availability = catalogByProvider.get(provider.providerId);
    const publicProvider = publicProviderById.get(provider.providerId);
    const availableModels =
      availability?.models.filter(
        (model) => model.availability === "available",
      ).length ?? 0;
    const knownModels = publicProvider?.models.length ?? 0;
    const publishedModels = publicProvider?.models.filter((model) => model.on).length ?? 0;
    const isConnected = !provider.status.unavailable && !provider.status.expired;
    const providerOn = publicProvider?.on ?? false;
    const catalogFailed = availability?.state === "failed";
    return (
      <article className="page-card provider-card" key={provider.providerId}>
        <div className="provider-title">
          <div>
            <h3>{provider.name}</h3>
            <p className="provider-source">{SOURCE_LABELS[provider.source]}</p>
          </div>
          <div className="provider-title-actions">
            <span className={`badge ${isConnected ? "good" : "warning"}`}>
              {provider.status.expired
                ? "Reconnect required"
                : isConnected
                  ? "Connected"
                  : "Not connected"}
            </span>
            <button
              type="button"
              className="runtime-toggle"
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
        <div className="button-row">
          {provider.apiKey ? (
            <button
              type="button"
              disabled={busyProvider !== undefined}
              onClick={() => void login(provider, "api_key")}
            >
              API key
            </button>
          ) : null}
          {provider.account ? (
            <button
              type="button"
              className="secondary"
              disabled={busyProvider !== undefined}
              onClick={() => void login(provider, "oauth")}
            >
              Auth
            </button>
          ) : null}
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
                <p className="eyebrow">{authModal.authType === "api_key" ? "API KEY" : "AUTH"}</p>
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
                        className="runtime-toggle"
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
