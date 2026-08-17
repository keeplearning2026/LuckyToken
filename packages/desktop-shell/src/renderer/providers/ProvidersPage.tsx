import { useEffect, useMemo, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

type AuthResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeAuth"]>>;
type ProviderOption = NonNullable<AuthResult["options"]>["providers"][number];
type AuthListener = NonNullable<Parameters<LuckyTokenDesktopApi["control"]["executeAuth"]>[1]>;
type AuthEvent = Parameters<AuthListener>[0];
type CatalogResult = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["executeCatalog"]>>;

export function ProvidersPage({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [catalog, setCatalog] = useState<CatalogResult>();
  const [loading, setLoading] = useState(true);
  const [busyProvider, setBusyProvider] = useState<string>();
  const [interaction, setInteraction] = useState<AuthEvent>();
  const [promptValue, setPromptValue] = useState("");
  const [notice, setNotice] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.control.executeAuth({ command: "query" }),
      api.control.executeCatalog({ command: "query" }),
    ]).then(
      ([auth, nextCatalog]) => {
        if (!active) return;
        setProviders(auth.options?.providers ?? []);
        setCatalog(nextCatalog);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setNotice("Provider state is temporarily unavailable.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const catalogByProvider = useMemo(
    () => new Map(catalog?.snapshot.providers.map((provider) => [provider.providerId, provider]) ?? []),
    [catalog],
  );

  const applyAuthState = (result: AuthResult): void => {
    const statuses = new Map(result.state.providers.map((status) => [status.providerId, status]));
    setProviders((current) =>
      current.map((provider) => {
        const status = statuses.get(provider.providerId);
        return status === undefined ? provider : { ...provider, status };
      }),
    );
  };

  const login = async (provider: ProviderOption, authType: "oauth" | "api_key"): Promise<void> => {
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
      const result = await api.control.executeCatalog({ command: "refresh", mode: "manual" });
      setCatalog(result);
      const failed = result.refresh?.providers.filter((provider) => provider.outcome === "failed") ?? [];
      setNotice(
        failed.length === 0
          ? "Provider models refreshed."
          : failed.map((provider) => provider.error ?? `${provider.providerId} refresh failed`).join(" · "),
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

  if (loading) {
    return <section className="page-card"><p>Loading providers…</p></section>;
  }

  return (
    <section className="page-stack">
      <div className="page-card section-heading">
        <div>
          <p className="eyebrow">AI SERVICES</p>
          <h2>Providers</h2>
          <p>Connect the services LuckyToken can use. Credentials stay in the Backend.</p>
        </div>
        <button type="button" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh models"}
        </button>
      </div>

      {notice === undefined ? null : <p className="product-notice" role="status">{notice}</p>}

      {interaction === undefined ? null : (
        <div className="page-card auth-interaction" aria-live="polite">
          {interaction.type === "progress" ? <p>{interaction.message}</p> : null}
          {interaction.type === "info" ? <p>{interaction.message}</p> : null}
          {interaction.type === "auth_url" ? (
            <>
              <p>{interaction.instructions ?? "Continue sign-in in your browser."}</p>
              <code>{interaction.url}</code>
              <button type="button" onClick={() => void api.platform.openExternal(interaction.url)}>Open browser</button>
            </>
          ) : null}
          {interaction.type === "device_code" ? (
            <>
              <p>Enter this code to continue:</p>
              <strong className="device-code">{interaction.userCode}</strong>
              <button type="button" onClick={() => void api.platform.openExternal(interaction.verificationUri)}>Open verification page</button>
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
                  <select value={promptValue} onChange={(event) => setPromptValue(event.currentTarget.value)}>
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
                  />
                )}
              </label>
              <button type="submit" disabled={promptValue.length === 0}>Continue</button>
            </form>
          ) : null}
          {busyProvider === undefined ? null : (
            <button type="button" className="secondary" onClick={() => void api.control.respondAuth({ type: "cancel" })}>
              Cancel sign-in
            </button>
          )}
        </div>
      )}

      <div className="provider-grid">
        {providers.map((provider) => {
          const connected = !provider.status.unavailable && !provider.status.expired;
          const availability = catalogByProvider.get(provider.providerId);
          const availableModels = availability?.models.filter((model) => model.availability === "available").length ?? 0;
          return (
            <article className="page-card provider-card" key={provider.providerId}>
              <div className="provider-title">
                <div>
                  <h3>{provider.name}</h3>
                  <p>{provider.providerId}</p>
                </div>
                <span className={`badge ${connected ? "good" : "warning"}`}>
                  {provider.status.expired ? "Reconnect required" : connected ? "Connected" : "Not connected"}
                </span>
              </div>
              <p>{availableModels} model{availableModels === 1 ? "" : "s"} available</p>
              {availability?.state === "failed" ? <p className="error-text">{availability.error ?? "Provider refresh failed"}</p> : null}
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
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
