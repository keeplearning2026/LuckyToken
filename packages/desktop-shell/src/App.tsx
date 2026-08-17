import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AliasCommand,
  type AliasCommandResult,
  type AliasStatusProjection,
  type CatalogCommand,
  type CatalogCommandResult,
  type ClientTokenCommand,
  type ClientTokenDirectoryRejection,
  type ClientTokenScopeRef,
  type MaskedClientTokenScope,
  type ModelsCommand,
  type RuntimeCommand,
  type SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";

import type { CatalogStatusProjection } from "@luckytoken/application-control-plane/control-plane";

import type { ControlPlaneState } from "./control-plane-projection.js";

import type { DiagnosticsWarning } from "./tauri-shell-runtime.js";

import { ModelsFileWorkspace } from "./models-editors.js";
import { CredentialsPage } from "./credentials-page.js";
import { RequestsPage } from "./requests-page.js";
import { AnalyticsPage } from "./analytics-page.js";

import {
  productPages,
  type AutoStartProjection,
  type DesktopShellSnapshot,
  type ProductPageId,
  type WindowsShellHost,
} from "./shell-lifecycle.js";

export interface AppProps {
  readonly shell: WindowsShellHost;
  readonly retryConnection: () => Promise<ControlPlaneState>;
}

export function App({ shell, retryConnection }: AppProps) {
  const [snapshot, setSnapshot] = useState<DesktopShellSnapshot>(
    shell.snapshot(),
  );
  const [retrying, setRetrying] = useState(false);
  const [runtimeCommand, setRuntimeCommand] = useState<RuntimeCommand>();
  const [settingsCommand, setSettingsCommand] = useState<SettingsCommand>();
  const [autoStart, setAutoStart] = useState<AutoStartProjection>();
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  const [autoStartError, setAutoStartError] = useState<string>();
  const autoStartQueried = useRef(false);

  useEffect(() => {
    const connected = snapshot.connection.kind === "connected";
    if (!connected) {
      autoStartQueried.current = false;
      return;
    }
    // Query the effective Windows sign-in registration exactly once per
    // connected session; status revisions never repeat the registry query.
    if (autoStartQueried.current) return;
    autoStartQueried.current = true;
    setAutoStartBusy(true);
    void shell.getAutoStartStatus().then(
      (result) => {
        setAutoStart(result);
        setAutoStartError(undefined);
        setAutoStartBusy(false);
      },
      (error: unknown) => {
        setAutoStartError(
          error instanceof Error ? error.message : String(error),
        );
        setAutoStartBusy(false);
      },
    );
  }, [snapshot.connection, shell]);

  const [modelsCommand, setModelsCommand] = useState<ModelsCommand>();
  const [catalogCommand, setCatalogCommand] = useState<CatalogCommand>();
  const [catalogResult, setCatalogResult] = useState<CatalogCommandResult>();
  const [aliasCommand, setAliasCommand] = useState<AliasCommand>();
  const [aliasResult, setAliasResult] = useState<AliasCommandResult>();

  useEffect(() => {
    const unsubscribe = shell.subscribe(setSnapshot);
    void shell.launch().then(setSnapshot);
    return () => {
      unsubscribe();
      void shell.dispose();
    };
  }, [shell]);

  const navigate = (page: ProductPageId) => {
    setSnapshot(shell.navigate(page));
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await retryConnection();
    } finally {
      setRetrying(false);
    }
  };

  const executeRuntimeCommand = async (command: RuntimeCommand) => {
    setRuntimeCommand(command);
    try {
      await shell.executeRuntimeCommand(command);
    } finally {
      setRuntimeCommand(undefined);
    }
  };

  const executeSettingsCommand = async (command: SettingsCommand) => {
    setSettingsCommand(command);
    try {
      await shell.executeSettingsCommand(command);
    } finally {
      setSettingsCommand(undefined);
    }
  };

  const toggleAutoStart = async () => {
    setAutoStartBusy(true);
    try {
      const result = await shell.setAutoStartEnabled(
        !(autoStart?.enabled ?? false),
      );
      setAutoStart(result);
      setAutoStartError(undefined);
    } catch (error) {
      setAutoStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutoStartBusy(false);
    }
  };

  const executeModelsCommand = async (command: ModelsCommand) => {
    setModelsCommand(command);
    try {
      await shell.executeModelsCommand(command);
    } finally {
      setModelsCommand(undefined);
    }
  };

  const executeCatalogCommand = async (command: CatalogCommand) => {
    setCatalogCommand(command);
    try {
      const result = await shell.executeCatalogCommand(command);
      setCatalogResult(result);
    } finally {
      setCatalogCommand(undefined);
    }
  };

  const executeAliasCommand = async (command: AliasCommand) => {
    setAliasCommand(command);
    try {
      const result = await shell.executeAliasCommand(command);
      setAliasResult(result);
    } finally {
      setAliasCommand(undefined);
    }
  };

  const activePage = productPages.find(
    (page) => page.id === snapshot.activePage,
  )!;

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Product navigation">
        <div className="brand">
          <span className="brand-mark">L</span>
          <div>
            <strong>LuckyToken</strong>
            <small>Local protocol gateway</small>
          </div>
        </div>
        <nav>
          {productPages.map((page) => (
            <button
              className={page.id === snapshot.activePage ? "active" : ""}
              key={page.id}
              onClick={() => navigate(page.id)}
              type="button"
            >
              {page.label}
            </button>
          ))}
        </nav>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">LOCAL CONTROL PLANE</p>
            <h1>{activePage.label}</h1>
          </div>
          <ConnectionBadge state={snapshot.connection} />
        </header>
        {snapshot.connection.kind === "error" ? (
          <section className="connection-error" aria-live="polite">
            <div>
              <strong>{snapshot.connection.title}</strong>
              <p>{snapshot.connection.detail}</p>
              <small>{snapshot.connection.action}</small>
            </div>
            <button
              disabled={retrying}
              onClick={() => void retry()}
              type="button"
            >
              {retrying ? "Reconnecting…" : "Retry"}
            </button>
          </section>
        ) : null}
        {snapshot.activePage === "dashboard" &&
        snapshot.connection.kind === "connected" ? (
          <section
            className="runtime-controls"
            aria-label="Model gateway controls"
          >
            <div>
              <strong>Model gateway</strong>
              <p>
                {snapshot.connection.dataPlane?.configuredOrigin ??
                  "Configured locally"}
              </p>
              {snapshot.connection.dataPlane?.failure === undefined ? null : (
                <small>{snapshot.connection.dataPlane.failure.message}</small>
              )}
            </div>
            <div className="runtime-actions">
              <button
                disabled={
                  runtimeCommand !== undefined ||
                  snapshot.connection.modelDataPlane === "running" ||
                  snapshot.connection.modelDataPlane === "starting" ||
                  snapshot.connection.modelDataPlane === "stopping"
                }
                onClick={() => void executeRuntimeCommand("start")}
                type="button"
              >
                Start
              </button>
              <button
                disabled={
                  runtimeCommand !== undefined ||
                  snapshot.connection.modelDataPlane === "stopped" ||
                  snapshot.connection.modelDataPlane === "stopping"
                }
                onClick={() => void executeRuntimeCommand("stop")}
                type="button"
              >
                Stop
              </button>
              <button
                disabled={
                  runtimeCommand !== undefined ||
                  snapshot.connection.modelDataPlane !== "running"
                }
                onClick={() => void executeRuntimeCommand("restart")}
                type="button"
              >
                Restart
              </button>
            </div>
          </section>
        ) : null}
        {snapshot.activePage === "dashboard" &&
        snapshot.connection.kind === "connected" ? (
          <section
            className="ownership-controls"
            aria-label="Application ownership"
          >
            <div>
              <strong>Application ownership</strong>
              <p>
                {snapshot.connection.ownership === undefined
                  ? "Owned by this application instance"
                  : snapshot.connection.ownership.owner.kind === "cli"
                    ? `Owned by the headless LuckyToken CLI (PID ${snapshot.connection.ownership.owner.pid})`
                    : "Owned by a LuckyToken desktop instance"}
              </p>
              {autoStartError === undefined ? null : (
                <small className="auto-start-error">{autoStartError}</small>
              )}
            </div>
            <div className="runtime-actions">
              <span className="auto-start-status">
                {autoStart === undefined
                  ? "Windows sign-in auto-start: unknown"
                  : autoStart.enabled
                    ? "Starts LuckyToken at sign-in"
                    : "Does not start at sign-in"}
              </span>
              <button
                disabled={autoStartBusy || autoStart === undefined}
                onClick={() => void toggleAutoStart()}
                type="button"
              >
                {autoStart?.enabled === true
                  ? "Disable auto-start"
                  : "Enable auto-start"}
              </button>
            </div>
          </section>
        ) : null}
        {snapshot.activePage === "settings-developer-lab" &&
        snapshot.connection.kind === "connected" ? (
          <SettingsDeveloperLab
            busy={settingsCommand !== undefined}
            confirmation={snapshot.connection.confirmation}
            settings={snapshot.connection.settings}
            onConfirm={(actionId) =>
              void executeSettingsCommand({
                command: "confirm",
                actionId,
              })
            }
            onSet={(key, value) =>
              void executeSettingsCommand({ command: "set", key, value })
            }
          />
        ) : null}
        {snapshot.activePage === "dashboard" &&
        snapshot.connection.kind === "connected" ? (
          <DashboardWarnings
            refreshKey={snapshot.connection.sequence}
            shell={shell}
          />
        ) : null}
        {snapshot.activePage === "client-tokens" &&
        snapshot.connection.kind === "connected" ? (
          <ClientTokensPage
            settings={snapshot.connection.settings}
            shell={shell}
          />
        ) : null}
        {snapshot.activePage === "credentials" &&
        snapshot.connection.kind === "connected" ? (
          <CredentialsPage
            credentials={snapshot.connection.credentialsProjection}
            shell={shell}
          />
        ) : null}
        {snapshot.activePage === "requests" ? (
          <RequestsPage
            connection={snapshot.connection}
            shell={shell}
          />
        ) : null}
        {snapshot.activePage === "analytics" ? (
          <AnalyticsPage shell={shell} />
        ) : null}
        {(snapshot.activePage === "providers" ||
          snapshot.activePage === "models-aliases") &&
        snapshot.connection.kind === "connected" ? (
          <ModelsPage
            busy={modelsCommand !== undefined}
            catalogBusy={catalogCommand !== undefined}
            aliasBusy={aliasCommand !== undefined}
            connection={snapshot.connection}
            mode={
              snapshot.activePage === "providers" ? "providers" : "models"
            }
            onAliasCommand={executeAliasCommand}
            onCatalogCommand={executeCatalogCommand}
            onCommand={executeModelsCommand}
            {...(aliasResult === undefined ? {} : { aliasResult })}
            {...(catalogResult === undefined ? {} : { catalogResult })}
            {...(snapshot.connection.catalogStatus === undefined
              ? {}
              : { catalogStatus: snapshot.connection.catalogStatus })}
            {...(snapshot.connection.aliasesProjection === undefined
              ? {}
              : { aliasProjection: snapshot.connection.aliasesProjection })}
          />
        ) : null}
        <section className="empty-page">
          <div className="empty-mark" aria-hidden="true" />
          <h2>{activePage.label}</h2>
          <p>
            {snapshot.activePage === "dashboard"
              ? "No activity yet. LuckyToken is ready when your clients are."
              : "This workspace is ready. Configuration is optional until you need it."}
          </p>
        </section>
      </main>
    </div>
  );
}

interface SettingsDeveloperLabProps {
  readonly busy: boolean;
  readonly confirmation:
    | Readonly<{
        readonly actionId: string;
        readonly settingKey: "server.bindHost";
        readonly value: string;
        readonly message: string;
      }>
    | undefined;
  readonly settings:
    | Readonly<
        Record<
          string,
          Readonly<{
            readonly key: string;
            readonly type: "boolean" | "number" | "string";
            readonly default: boolean | number | string;
            readonly sensitivity: "public" | "secret";
            readonly applyMode: "hot-apply" | "restart-required";
            readonly value: boolean | number | string;
            readonly effective?: boolean | number | string;
          }>
        >
      >
    | undefined;
  readonly onConfirm: (actionId: string) => void;
  readonly onSet: (key: string, value: boolean | number | string) => void;
}

/** Settings / Developer Lab: exposes only actively registered settings. */
function SettingsDeveloperLab({
  busy,
  confirmation,
  settings,
  onConfirm,
  onSet,
}: SettingsDeveloperLabProps) {
  const anthropic = settings?.["protocols.anthropic-messages.enabled"];
  const responses = settings?.["protocols.openai-responses.enabled"];
  const deepCapture = settings?.["diagnostics.deepCapture.enabled"];
  const port = settings?.["server.port"];
  const bindHost = settings?.["server.bindHost"];
  return (
    <section
      className="settings-developer-lab"
      aria-label="Settings and Developer Lab"
    >
      <div className="settings-group">
        <strong>Client Protocols</strong>
        {anthropic === undefined && responses === undefined ? (
          <p>No registered protocol settings are available.</p>
        ) : (
          <div className="settings-rows">
            {anthropic === undefined ? null : (
              <label className="settings-row">
                <span>
                  Anthropic Messages
                  <small>Hot-applies immediately</small>
                </span>
                <input
                  checked={anthropic.value === true}
                  disabled={busy}
                  onChange={(event) =>
                    onSet(anthropic.key, event.target.checked)
                  }
                  type="checkbox"
                />
              </label>
            )}
            {responses === undefined ? null : (
              <label className="settings-row">
                <span>
                  OpenAI Responses
                  <small>Hot-applies immediately</small>
                </span>
                <input
                  checked={responses.value === true}
                  disabled={busy}
                  onChange={(event) =>
                    onSet(responses.key, event.target.checked)
                  }
                  type="checkbox"
                />
              </label>
            )}
          </div>
        )}
      </div>
      <div className="settings-group">
        <strong>Deep diagnostics</strong>
        {deepCapture === undefined ? (
          <p>No registered deep diagnostics settings are available.</p>
        ) : (
          <div className="settings-rows">
            <label className="settings-row">
              <span>
                Capture raw request/response artifacts
                <small>
                  Hot-applies to requests accepted while enabled; raw capture
                  is redacted and kept under bounded retention.
                </small>
              </span>
              <input
                checked={deepCapture.value === true}
                disabled={busy}
                onChange={(event) =>
                  onSet(deepCapture.key, event.target.checked)
                }
                type="checkbox"
              />
            </label>
          </div>
        )}
      </div>
      <div className="settings-group">
        <strong>Data Plane listener</strong>
        {port === undefined && bindHost === undefined ? (
          <p>No registered listener settings are available.</p>
        ) : (
          <div className="settings-rows">
            {bindHost === undefined ? null : (
              <label className="settings-row">
                <span>
                  Bind host
                  <small>
                    Effective: {String(bindHost.effective ?? bindHost.default)}
                    {" — restart required"}
                  </small>
                </span>
                <input
                  disabled={busy}
                  onChange={(event) => onSet(bindHost.key, event.target.value)}
                  value={String(bindHost.value)}
                />
              </label>
            )}
            {port === undefined ? null : (
              <label className="settings-row">
                <span>
                  Port
                  <small>
                    Effective: {String(port.effective ?? port.default)}
                    {" — restart required"}
                  </small>
                </span>
                <input
                  disabled={busy}
                  onChange={(event) =>
                    onSet(port.key, Number(event.target.value))
                  }
                  value={String(port.value)}
                />
              </label>
            )}
          </div>
        )}
      </div>
      {confirmation === undefined ? null : (
        <div className="settings-confirmation" aria-live="polite">
          <p>{confirmation.message}</p>
          <button
            disabled={busy}
            onClick={() => onConfirm(confirmation.actionId)}
            type="button"
          >
            Confirm LAN bind
          </button>
        </div>
      )}
    </section>
  );
}

function ModelsPage({
  busy,
  aliasBusy = false,
  aliasResult,
  aliasProjection,
  catalogBusy = false,
  catalogResult,
  catalogStatus,
  connection,
  mode,
  onAliasCommand,
  onCatalogCommand,
  onCommand,
}: {
  readonly busy: boolean;
  readonly aliasBusy?: boolean;
  readonly aliasResult?: AliasCommandResult;
  readonly aliasProjection?: AliasStatusProjection;
  readonly catalogBusy?: boolean;
  readonly catalogResult?: CatalogCommandResult;
  readonly catalogStatus?: CatalogStatusProjection;
  readonly connection: Extract<
    ControlPlaneState,
    { readonly kind: "connected" }
  >;
  readonly mode: "providers" | "models";
  readonly onAliasCommand: (command: AliasCommand) => void;
  readonly onCatalogCommand: (command: CatalogCommand) => void;
  readonly onCommand: (command: ModelsCommand) => void;
}) {
  // The first visit to a models page loads the authoritative revision; the
  // sanitized snapshot projection keeps the workspace fresh afterwards.
  useEffect(() => {
    if (connection.modelsResult === undefined) {
      onCommand({ command: "query" });
    }
  }, [connection.modelsResult, onCommand]);
  return (
    <ModelsFileWorkspace
      aliasBusy={aliasBusy}
      busy={busy}
      catalogBusy={catalogBusy}
      mode={mode}
      onAliasCommand={onAliasCommand}
      onCatalogCommand={onCatalogCommand}
      onCommand={onCommand}
      onReload={() => onCommand({ command: "query" })}
      projection={connection.modelsProjection}
      result={connection.modelsResult}
      {...(aliasResult === undefined ? {} : { aliasResult })}
      {...(aliasProjection === undefined ? {} : { aliasProjection })}
      {...(catalogResult === undefined ? {} : { catalogResult })}
      {...(catalogStatus === undefined ? {} : { catalogStatus })}
    />
  );
}

function ConnectionBadge({ state }: { readonly state: ControlPlaneState }) {
  if (state.kind === "error") {
    return <span className="badge error">Attention needed</span>;
  }
  return (
    <span className="badge connected">
      {state.modelDataPlane === "running"
        ? "Gateway running"
        : `Gateway ${state.modelDataPlane}`}
    </span>
  );
}

/** Sanitized warning strip (Ticket 16): the backend redaction boundary has
 *  already scrubbed credentials before records reach the native bridge. */
function DashboardWarnings({
  refreshKey,
  shell,
}: {
  readonly refreshKey: number;
  readonly shell: WindowsShellHost;
}) {
  const [warnings, setWarnings] = useState<readonly DiagnosticsWarning[]>([]);
  useEffect(() => {
    let cancelled = false;
    void shell
      .queryDiagnosticsWarnings()
      .then((next) => {
        if (!cancelled) setWarnings(next);
      })
      .catch(() => {
        if (!cancelled) setWarnings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, shell]);
  if (warnings.length === 0) return null;
  return (
    <section className="dashboard-warnings" aria-live="polite">
      <strong>Attention needed</strong>
      {warnings.slice(-3).map((warning) => (
        <p key={warning.id}>{warning.text}</p>
      ))}
    </section>
  );
}

const TOKEN_PROTOCOLS = Object.freeze([
  {
    id: "anthropic-messages",
    name: "Anthropic Messages",
    enableKey: "protocols.anthropic-messages.enabled",
  },
  {
    id: "openai-responses",
    name: "OpenAI Responses",
    enableKey: "protocols.openai-responses.enabled",
  },
] as const);

interface ProtocolTokenView {
  readonly revision: number;
  readonly scopes: readonly MaskedClientTokenScope[];
  readonly unknownProtocol: boolean;
}

type ScopeKey = "global" | `project:${string}`;

function scopeKey(scope: MaskedClientTokenScope): ScopeKey {
  return scope.type === "global" ? "global" : `project:${scope.projectDir}`;
}

function scopeRef(scope: MaskedClientTokenScope): ClientTokenScopeRef {
  return scope.type === "global"
    ? { type: "global" }
    : { type: "project", projectDir: scope.projectDir as string };
}

/** Value-free backend canonicalization reasons rendered as friendly text;
 *  the raw picked path never reaches the renderer's error surface. */
const DIRECTORY_REJECTION_TEXT: Readonly<
  Record<ClientTokenDirectoryRejection, string>
> = {
  not_found: "The selected directory no longer exists.",
  not_a_directory: "The selected path is not a directory.",
  inaccessible: "The selected directory is not accessible.",
  race: "The directory changed while opening; try again.",
  invalid: "The selected path is not a valid directory path.",
};

/**
 * Client Tokens page (Ticket 16 + Ticket 17): manages the one live global
 * token and one token per canonical directory scope per enabled Client
 * Protocol. Lists show masked metadata only; Reveal and Copy are explicit
 * local operations; Rotate and Delete are revision-locked two-step actions
 * that hot-apply immediately. Adding a directory token runs the native
 * picker; the backend canonicalizes the picked path at the authority
 * boundary — the renderer never becomes a filesystem authority.
 */
function ClientTokensPage({
  settings,
  shell,
}: {
  readonly settings:
    | Readonly<
        Record<
          string,
          Readonly<{
            readonly key: string;
            readonly value: boolean | number | string;
          }>
        >
      >
    | undefined;
  readonly shell: WindowsShellHost;
}) {
  const [views, setViews] = useState<
    Readonly<Record<string, ProtocolTokenView | undefined>>
  >({});
  const [revealed, setRevealed] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [copied, setCopied] = useState<Readonly<Record<string, boolean>>>({});
  const [busy, setBusy] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<
    Readonly<Record<string, "rotate" | "remove" | undefined>>
  >({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const refresh = useCallback(
    async (protocolId: string) => {
      try {
        const result = await shell.executeClientTokenCommand({
          command: "list",
          protocolId,
        });
        if (result.outcome === "unknown_protocol") {
          setViews((previous) => ({
            ...previous,
            [protocolId]: {
              revision: result.revision,
              scopes: [],
              unknownProtocol: true,
            },
          }));
          return;
        }
        if (result.outcome !== "ok") {
          setErrors((previous) => ({
            ...previous,
            [protocolId]: result.error ?? "Client Token list failed",
          }));
          return;
        }
        setViews((previous) => ({
          ...previous,
          [protocolId]: {
            revision: result.revision,
            scopes: result.scopes ?? [],
            unknownProtocol: false,
          },
        }));
      } catch {
        setErrors((previous) => ({
          ...previous,
          [protocolId]: "Control Plane is unavailable",
        }));
      }
    },
    [shell],
  );

  useEffect(() => {
    for (const protocol of TOKEN_PROTOCOLS) void refresh(protocol.id);
  }, [refresh]);

  const run = async (protocolId: string, operation: () => Promise<void>) => {
    setBusy(protocolId);
    setErrors((previous) => ({ ...previous, [protocolId]: "" }));
    setConfirming((previous) => ({ ...previous, [protocolId]: undefined }));
    try {
      await operation();
    } catch (error) {
      setErrors((previous) => ({
        ...previous,
        [protocolId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setBusy(undefined);
    }
  };

  const reveal = (protocolId: string, scope: MaskedClientTokenScope) =>
    run(protocolId, async () => {
      const result = await shell.executeClientTokenCommand({
        command: "reveal",
        protocolId,
        scope: scopeRef(scope),
      });
      if (result.outcome !== "ok" || result.token === undefined) {
        throw new Error(result.error ?? "Client token scope does not exist");
      }
      setRevealed((previous) => ({
        ...previous,
        [`${protocolId}\u0000${scopeKey(scope)}`]: result.token as string,
      }));
    });

  const copy = (protocolId: string, scope: MaskedClientTokenScope) =>
    run(protocolId, async () => {
      const result = await shell.executeClientTokenCommand({
        command: "reveal",
        protocolId,
        scope: scopeRef(scope),
      });
      if (result.outcome !== "ok" || result.token === undefined) {
        throw new Error(result.error ?? "Client token scope does not exist");
      }
      await navigator.clipboard.writeText(result.token as string);
      setCopied((previous) => ({
        ...previous,
        [`${protocolId}\u0000${scopeKey(scope)}`]: true,
      }));
      setRevealed((previous) => ({
        ...previous,
        [`${protocolId}\u0000${scopeKey(scope)}`]: result.token as string,
      }));
    });

  const mutate = (protocolId: string, command: ClientTokenCommand) =>
    run(protocolId, async () => {
      const result = await shell.executeClientTokenCommand(command);
      if (result.outcome === "conflict") {
        // A concurrent UI/CLI mutation won: refresh instead of overwriting.
        await refresh(protocolId);
        throw new Error("The token changed elsewhere; the list was refreshed.");
      }
      if (result.outcome !== "ok") {
        throw new Error(result.error ?? "Client Token operation failed");
      }
      setRevealed((previous) => {
        const next = { ...previous };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${protocolId}\u0000`)) delete next[key];
        }
        return next;
      });
      await refresh(protocolId);
    });

  const addDirectory = (protocolId: string) =>
    run(protocolId, async () => {
      // The native picker returns the raw path (or undefined on cancel);
      // only the backend canonicalizes it.
      const picked = await shell.pickDirectory();
      if (picked === undefined) return;
      const result = await shell.executeClientTokenCommand({
        command: "create",
        protocolId,
        scope: { type: "project", projectDir: picked },
      });
      if (result.outcome === "already_exists") {
        await refresh(protocolId);
        throw new Error("This directory already has a token.");
      }
      if (
        result.outcome === "invalid_directory" &&
        result.reason !== undefined
      ) {
        throw new Error(DIRECTORY_REJECTION_TEXT[result.reason]);
      }
      if (result.outcome === "conflict") {
        await refresh(protocolId);
        throw new Error(
          "The tokens changed elsewhere; the list was refreshed.",
        );
      }
      if (result.outcome !== "ok") {
        throw new Error(result.error ?? "Client Token create failed");
      }
      await refresh(protocolId);
    });

  return (
    <section className="client-tokens-page" aria-label="Client Tokens">
      {TOKEN_PROTOCOLS.map((protocol) => {
        const view = views[protocol.id];
        const enabled = settings?.[protocol.enableKey]?.value === true;
        const busyHere = busy === protocol.id;
        const scopeRows = view?.scopes ?? [];
        const confirmAction = confirming[protocol.id];
        return (
          <section className="client-token-card" key={protocol.id}>
            <header>
              <strong>{protocol.name}</strong>
              <small>{enabled ? "Enabled" : "Disabled"}</small>
            </header>
            {view === undefined ? (
              <p>Loading client token state…</p>
            ) : view.unknownProtocol ? (
              <p>Not configured in this backend.</p>
            ) : scopeRows.length === 0 ? (
              <p className="client-token-warning">
                No active client token — all model requests return 401 until a
                token is created.
              </p>
            ) : (
              <div className="client-token-scopes">
                {scopeRows.map((scope) => {
                  const key = `${protocol.id}\u0000${scopeKey(scope)}`;
                  const secret = revealed[key];
                  const label =
                    scope.type === "global"
                      ? "Global"
                      : (scope.projectDir as string);
                  return (
                    <div className="client-token-scope" key={key}>
                      <code title={label}>{secret ?? scope.maskedToken}</code>
                      {scope.type === "project" ? (
                        <small className="client-token-dir">{label}</small>
                      ) : null}
                      <div className="client-token-actions">
                        <button
                          disabled={busyHere}
                          onClick={() => void reveal(protocol.id, scope)}
                          type="button"
                        >
                          {secret === undefined ? "Reveal" : "Hide"}
                        </button>
                        <button
                          disabled={busyHere}
                          onClick={() => void copy(protocol.id, scope)}
                          type="button"
                        >
                          {copied[key] === true ? "Copied" : "Copy"}
                        </button>
                        <button
                          className={
                            confirmAction === "rotate" ? "confirming" : ""
                          }
                          disabled={busyHere}
                          onClick={() =>
                            confirmAction === "rotate"
                              ? void mutate(protocol.id, {
                                  command: "rotate",
                                  protocolId: protocol.id,
                                  expectedRevision: (view as ProtocolTokenView)
                                    .revision,
                                  scope: scopeRef(scope),
                                })
                              : setConfirming((previous) => ({
                                  ...previous,
                                  [protocol.id]: "rotate",
                                }))
                          }
                          type="button"
                        >
                          {confirmAction === "rotate"
                            ? "Confirm rotate"
                            : "Rotate"}
                        </button>
                        <button
                          className={`danger${confirmAction === "remove" ? " confirming" : ""}`}
                          disabled={busyHere}
                          onClick={() =>
                            confirmAction === "remove"
                              ? void mutate(protocol.id, {
                                  command: "remove",
                                  protocolId: protocol.id,
                                  expectedRevision: (view as ProtocolTokenView)
                                    .revision,
                                  scope: scopeRef(scope),
                                })
                              : setConfirming((previous) => ({
                                  ...previous,
                                  [protocol.id]: "remove",
                                }))
                          }
                          type="button"
                        >
                          {confirmAction === "remove"
                            ? "Confirm remove"
                            : "Remove"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="client-token-add">
              <button
                disabled={busyHere || view?.unknownProtocol === true}
                onClick={() => void addDirectory(protocol.id)}
                type="button"
              >
                Add directory token…
              </button>
            </div>
            {errors[protocol.id] === undefined ||
            errors[protocol.id] === "" ? null : (
              <p className="client-token-error">{errors[protocol.id]}</p>
            )}
          </section>
        );
      })}
    </section>
  );
}
