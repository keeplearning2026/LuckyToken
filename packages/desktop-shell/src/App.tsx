import { useEffect, useState } from "react";
import type {
  RuntimeCommand,
  SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";

import type { ControlPlaneState } from "./control-plane-projection.js";
import {
  productPages,
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
            <button disabled={retrying} onClick={() => void retry()} type="button">
              {retrying ? "Reconnecting…" : "Retry"}
            </button>
          </section>
        ) : null}
        {snapshot.activePage === "dashboard" &&
        snapshot.connection.kind === "connected" ? (
          <section className="runtime-controls" aria-label="Model gateway controls">
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
  const port = settings?.["server.port"];
  const bindHost = settings?.["server.bindHost"];
  return (
    <section className="settings-developer-lab" aria-label="Settings and Developer Lab">
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
