import { useEffect, useMemo, useRef, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type AuthResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeAuth"]>>;
type ProviderOption = NonNullable<AuthResult["options"]>["providers"][number];
type AuthListener = NonNullable<Parameters<LuckyTokenDesktopApi["control"]["executeAuth"]>[1]>;
type AuthEvent = Parameters<AuthListener>[0];
type CatalogResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeCatalog"]>>;
type ProviderSource = ProviderOption["source"];

/** Presentation-only source labels (Provider Activation Spec v1.0 §16.4):
 *  package names and internal composition details are never exposed. */
const SOURCE_LABELS: Readonly<Record<ProviderSource, string>> = Object.freeze({
  pi_builtin: "Built in",
  luckytoken_bundled: "LuckyToken",
  user: "Custom",
});

/** A model row merged from the authoritative Catalog facts and the current
 *  effective Alias registry (Ticket 11). The canonical target is carried
 *  explicitly from Catalog projection; it is never reparsed from the alias
 *  string. */
export interface ProviderModelRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly alias: string;
  readonly aliasLayer: "default" | "user";
}

export function ProvidersPage({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [catalog, setCatalog] = useState<CatalogResult>();
  const [aliases, setAliases] = useState<Awaited<
    ReturnType<LuckyTokenDesktopApi["control"]["executeAliases"]>
  >>();
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [search, setSearch] = useState("");
  const [busyProvider, setBusyProvider] = useState<string>();
  const [interaction, setInteraction] = useState<AuthEvent>();
  const [promptValue, setPromptValue] = useState("");
  const [notice, setNotice] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [editingRow, setEditingRow] = useState<ProviderModelRow>();
  const [aliasValue, setAliasValue] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState<string>();

  // Initial query: Auth and Catalog are queried independently (Spec
  // §16.2). An Auth query failure renders an explicit management error
  // state, never an empty Provider list.
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
        if (!active) return;
        setAuthError(true);
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
        if (!active) return;
        setCatalogError(true);
      });
    void Promise.resolve().then(() => {
      if (active) setLoading(false);
    });
    // Alias facts are presentation-only for model rows; a failure here
    // never blocks the Provider activation surface (Spec §16.2).
    void api.control.executeAliases({ command: "query" }).then(
      (nextAliases) => {
        if (active) setAliases(nextAliases);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [api]);

  // The page reacts to authoritative status/catalog generation changes by
  // re-querying; it never invents a polling authority (Spec §16.8). The
  // Backend drives convergence through catalog version publication.
  const seenCatalogVersion = useRef(-1);
  useEffect(() => {
    let active = true;
    const stop = api.control.onStatus((status) => {
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
          if (!active) return;
          setCatalogError(true);
        },
      );
      void api.control.executeAliases({ command: "query" }).then(
        (nextAliases) => {
          if (active) setAliases(nextAliases);
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

  const aliasByTarget = useMemo(() => {
    const map = new Map<
      string,
      { readonly alias: string; readonly layer: "default" | "user" }
    >();
    for (const entry of aliases?.state.effective?.aliases ?? []) {
      map.set(`${entry.target.provider}\u0000${entry.target.model}`, {
        alias: entry.alias,
        layer: entry.layer,
      });
    }
    return map;
  }, [aliases]);

  /** Model rows merged from Catalog facts + effective Alias registry. */
  const modelRows: ProviderModelRow[] = useMemo(() => {
    const rows: ProviderModelRow[] = [];
    for (const provider of catalog?.snapshot.providers ?? []) {
      for (const model of provider.models) {
        const alias = aliasByTarget.get(
          `${provider.providerId}\u0000${model.id}`,
        );
        rows.push({
          providerId: provider.providerId,
          modelId: model.id,
          availability: model.availability,
          alias: alias?.alias ?? `${provider.providerId}/${model.id}`,
          aliasLayer: alias?.layer ?? "default",
        });
      }
    }
    return rows;
  }, [catalog, aliasByTarget]);

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

  const login = async (
    provider: ProviderOption,
    authType: "oauth" | "api_key",
  ): Promise<void> => {
    setBusyProvider(provider.providerId);
    setInteraction(undefined);
    setPromptValue("");
    setNotice(undefined);
    try {
      const result = await api.control.executeAuth(
        { command: "login", providerId: provider.providerId, authType },
        (event) => {
          setInteraction(event);
          if (event.type === "prompt") setPromptValue("");
        },
      );
      applyAuthState(result);
      if (result.outcome === "ok") {
        setNotice(`${provider.name} connected.`);
        setInteraction(undefined);
      } else if (result.outcome === "cancelled") {
        setNotice("Sign-in cancelled.");
      } else {
        setNotice(result.error ?? "Provider sign-in failed. Try again.");
      }
    } finally {
      setBusyProvider(undefined);
    }
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
                  provider.error ??
                  `${provider.providerId} refresh failed`,
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

  const openAliasEditor = (row: ProviderModelRow): void => {
    setAliasError(undefined);
    // The editor asks only for the friendly alias value; the canonical
    // target is already determined by the model row (Spec §16.10).
    setAliasValue(row.aliasLayer === "default" ? "" : row.alias);
    setEditingRow(row);
  };

  const saveAlias = async (): Promise<void> => {
    const row = editingRow;
    if (row === undefined) return;
    const trimmed = aliasValue.trim();
    if (trimmed.length === 0) {
      setAliasError("Enter a friendly alias for this model.");
      return;
    }
    setAliasBusy(true);
    setAliasError(undefined);
    try {
      const revision = aliases?.state.revision ?? 0;
      const result = await api.control.executeAliases({
        command: "set_for_model",
        revision,
        providerId: row.providerId,
        modelId: row.modelId,
        alias: trimmed,
      });
      if (result.outcome !== "ok") {
        const message =
          result.outcome === "conflict"
            ? "The alias registry changed. Refresh and try again."
            : (result.error?.message ?? "The alias could not be saved.");
        setAliasError(message);
        // Refresh the authoritative state so the UI never shows a locally
        // invented alias.
        const next = await api.control
          .executeAliases({ command: "query" })
          .catch(() => undefined);
        if (next !== undefined) setAliases(next);
        return;
      }
      setAliases(result);
      setEditingRow(undefined);
      setNotice(`Alias saved for ${row.modelId}.`);
    } catch {
      setAliasError("The alias could not be saved. Try again.");
    } finally {
      setAliasBusy(false);
    }
  };

  const resetAlias = async (row: ProviderModelRow): Promise<void> => {
    setAliasBusy(true);
    setAliasError(undefined);
    try {
      const revision = aliases?.state.revision ?? 0;
      const result = await api.control.executeAliases({
        command: "reset_for_model",
        revision,
        providerId: row.providerId,
        modelId: row.modelId,
      });
      if (result.outcome !== "ok") {
        setAliasError(
          result.outcome === "conflict"
            ? "The alias registry changed. Refresh and try again."
            : (result.error?.message ?? "The alias could not be reset."),
        );
        const next = await api.control
          .executeAliases({ command: "query" })
          .catch(() => undefined);
        if (next !== undefined) setAliases(next);
        return;
      }
      setAliases(result);
      setEditingRow(undefined);
      setNotice(`Default alias restored for ${row.modelId}.`);
    } catch {
      setAliasError("The alias could not be reset. Try again.");
    } finally {
      setAliasBusy(false);
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
  const visibleProviderIds = new Set(visible.map((provider) => provider.providerId));
  const visibleModelRows = modelRows.filter((row) =>
    visibleProviderIds.has(row.providerId),
  );

  const renderCard = (provider: ProviderOption): React.ReactElement => {
    const availability = catalogByProvider.get(provider.providerId);
    const availableModels =
      availability?.models.filter(
        (model) => model.availability === "available",
      ).length ?? 0;
    const knownModels = availability?.models.length ?? 0;
    const connected = !provider.status.unavailable && !provider.status.expired;
    const catalogFailed = availability?.state === "failed";
    return (
      <article className="page-card provider-card" key={provider.providerId}>
        <div className="provider-title">
          <div>
            <h3>{provider.name}</h3>
            <p className="provider-source">
              {SOURCE_LABELS[provider.source]}
            </p>
          </div>
          <span
            className={`badge ${connected ? "good" : "warning"}`}
          >
            {provider.status.expired
              ? "Reconnect required"
              : connected
                ? "Connected"
                : "Available"}
          </span>
        </div>
        <p>
          {knownModels === 0
            ? "Model facts unavailable"
            : `${availableModels} of ${knownModels} model${
                knownModels === 1 ? "" : "s"
              } available`}
        </p>
        {catalogFailed ? (
          <p className="error-text">
            {availability?.error ?? "Provider refresh failed"}
          </p>
        ) : null}
        <div className="button-row">
          {provider.account ? (
            <button
              type="button"
              disabled={busyProvider !== undefined}
              onClick={() => void login(provider, "oauth")}
            >
              {provider.accountLabel ?? "Use account"}
            </button>
          ) : null}
          {provider.apiKey ? (
            <button
              type="button"
              className="secondary"
              disabled={busyProvider !== undefined}
              onClick={() => void login(provider, "api_key")}
            >
              {provider.apiKeyLabel ?? "Use API key"}
            </button>
          ) : null}
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

  const renderModelRow = (row: ProviderModelRow): React.ReactElement => (
    <li className="provider-model-row" key={`${row.providerId}\u0000${row.modelId}`}>
      <span className="model-alias">{row.alias}</span>
      <span
        className={`badge ${
          row.availability === "available" ? "good" : "neutral"
        }`}
      >
        {row.availability}
      </span>
      <button
        type="button"
        className="secondary"
        onClick={() => openAliasEditor(row)}
        aria-label={
          row.aliasLayer === "default"
            ? `Add alias for ${row.alias}`
            : `Edit alias for ${row.alias}`
        }
      >
        {row.aliasLayer === "default" ? "+ alias" : "edit alias"}
      </button>
      {row.aliasLayer === "user" ? (
        <button
          type="button"
          className="secondary"
          onClick={() => void resetAlias(row)}
          aria-label={`Use default for ${row.alias}`}
        >
          Use default
        </button>
      ) : null}
    </li>
  );

  return (
    <section className="page-stack">
      <div className="page-card section-heading">
        <div>
          <p className="eyebrow">AI SERVICES</p>
          <h2>Providers</h2>
          <p>Connect the services LuckyToken can use. Credentials stay in the Backend.</p>
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? "Refreshing…" : "Refresh models"}
        </button>
      </div>

      {notice === undefined ? null : (
        <p className="product-notice" role="status">
          {notice}
        </p>
      )}

      {authError ? (
        <section className="page-card" role="alert">
          <h3>Provider state is temporarily unavailable</h3>
          <p>
            LuckyToken could not reach the Backend Provider management
            surface. Check the Backend and try again.
          </p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setAuthError(false);
              setCatalogError(false);
              setNotice(undefined);
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
              void api.control.executeAliases({ command: "query" }).then(
                (nextAliases) => setAliases(nextAliases),
                () => undefined,
              );
              void Promise.resolve().then(() => setLoading(false));
            }}
          >
            Retry
          </button>
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
              <p>
                Provider authentication facts are shown, but model facts
                could not be loaded from the Backend.
              </p>
              <button
                type="button"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                Retry models
              </button>
            </section>
          ) : null}

          {interaction === undefined ? null : (
            <div className="page-card auth-interaction" aria-live="polite">
              {interaction.type === "progress" ? (
                <p>{interaction.message}</p>
              ) : null}
              {interaction.type === "info" ? (
                <p>{interaction.message}</p>
              ) : null}
              {interaction.type === "auth_url" ? (
                <>
                  <p>
                    {interaction.instructions ??
                      "Continue sign-in in your browser."}
                  </p>
                  <code>{interaction.url}</code>
                  <button
                    type="button"
                    onClick={() =>
                      void api.platform.openExternal(interaction.url)
                    }
                  >
                    Open browser
                  </button>
                </>
              ) : null}
              {interaction.type === "device_code" ? (
                <>
                  <p>Enter this code to continue:</p>
                  <strong className="device-code">
                    {interaction.userCode}
                  </strong>
                  <button
                    type="button"
                    onClick={() =>
                      void api.platform.openExternal(
                        interaction.verificationUri,
                      )
                    }
                  >
                    Open verification page
                  </button>
                </>
              ) : null}
              {interaction.type === "prompt" ? (
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
                        onChange={(event) =>
                          setPromptValue(event.currentTarget.value)
                        }
                      >
                        <option value="">Choose…</option>
                        {interaction.options?.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={
                          interaction.kind === "secret" ? "password" : "text"
                        }
                        placeholder={interaction.placeholder}
                        value={promptValue}
                        onChange={(event) =>
                          setPromptValue(event.currentTarget.value)
                        }
                      />
                    )}
                  </label>
                  <button
                    type="submit"
                    disabled={promptValue.length === 0}
                  >
                    Continue
                  </button>
                </form>
              ) : null}
              {busyProvider === undefined ? null : (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void api.control.respondAuth({ type: "cancel" })
                  }
                >
                  Cancel sign-in
                </button>
              )}
            </div>
          )}

          {editingRow === undefined ? null : (
            <div
              className="page-card alias-editor"
              role="dialog"
              aria-label="Edit model alias"
            >
              <h3>
                {editingRow.aliasLayer === "default" ? "Add alias" : "Edit alias"}
              </h3>
              <p className="alias-editor-model">{editingRow.modelId}</p>
              <p className="alias-editor-current">
                Current alias: <code>{editingRow.alias}</code>
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAlias();
                }}
              >
                <label>
                  <span>Custom alias</span>
                  <input
                    type="text"
                    value={aliasValue}
                    placeholder={editingRow.alias}
                    onChange={(event) => setAliasValue(event.currentTarget.value)}
                    autoFocus
                  />
                </label>
                {aliasError === undefined ? null : (
                  <p className="error-text" role="alert">
                    {aliasError}
                  </p>
                )}
                <div className="button-row">
                  <button
                    type="submit"
                    disabled={aliasBusy || aliasValue.trim().length === 0}
                  >
                    {aliasBusy ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={aliasBusy}
                    onClick={() => setEditingRow(undefined)}
                  >
                    Cancel
                  </button>
                  {editingRow.aliasLayer === "user" ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={aliasBusy}
                      onClick={() => void resetAlias(editingRow)}
                    >
                      Use default
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          )}

          {connected.length === 0 ? null : (
            <section className="provider-group">
              <h3 className="provider-group-title">Connected</h3>
              <div className="provider-grid">
                {connected.map((provider) => renderCard(provider))}
              </div>
            </section>
          )}

          {available.length === 0 ? null : (
            <section className="provider-group">
              <h3 className="provider-group-title">Available</h3>
              <div className="provider-grid">
                {available.map((provider) => renderCard(provider))}
              </div>
            </section>
          )}

          {visibleModelRows.length === 0 ? null : (
            <section className="page-card">
              <h3>Known models</h3>
              <ul className="provider-model-list">
                {visibleModelRows.map((row) => renderModelRow(row))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
