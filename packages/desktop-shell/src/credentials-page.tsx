/** Effective-source label shown in the Credentials page (Ticket 12). */
import { useEffect, useRef, useState } from "react";

import type {
  AuthCommandResult,
  AuthInteractionEvent,
  AuthProviderOption,
} from "@luckytoken/application-control-plane/control-plane";

import type { WindowsShellHost } from "./shell-lifecycle.js";

const EFFECTIVE_SOURCE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  stored: "Stored credential",
  environment: "Environment variable",
  "models.json": "models.json API key",
  command: "Command-derived key",
  none: "No effective source",
});

/** One in-flight Provider-owned login flow (Ticket 13). The panel is
 *  driven only by typed interaction events: nothing here branches on
 *  Provider ids or implements Provider-specific OAuth/API-key protocols. */
interface AuthFlowState {
  readonly providerId: string;
  /** Ephemeral typed events already projected (transcript). */
  readonly events: readonly AuthInteractionEvent[];
  /** The one prompt awaiting an answer; the Provider asks the next prompt
   *  only after the previous response is routed. Undefined while no
   *  prompt is outstanding (declared required so the field can be cleared
   *  under exactOptionalPropertyTypes). */
  readonly pendingPrompt: Extract<AuthInteractionEvent, { readonly type: "prompt" }> | undefined;
  /** Current value of the pending text/secret input. */
  readonly promptValue: string;
  /** Terminal login outcome (success, cancelled, failed, …). */
  readonly terminal?: AuthCommandResult;
  /** Transport/exception failure that never produced a terminal outcome. */
  readonly failure?: string;
}

/**
 * Credentials page (Ticket 12 + Ticket 13): per-Provider effective
 * authentication status, the two exact top-level login choices — "Use an
 * account or subscription" (Provider-owned interactive flow) and "Use an
 * API key" (the stored-value path) — plus the typed flow panel, logout,
 * and a Provider-by-Provider auth.json import. Only Provider metadata
 * labels a flow as a true subscription; the renderer contains no Provider
 * ID branches and no OAuth/API-key protocol logic.
 */
export function CredentialsPage({
  credentials,
  shell,
}: {
  readonly credentials:
    | Readonly<{
        readonly revision: number;
        readonly path: string;
        readonly present: boolean;
        readonly valid: boolean;
        readonly error?: Readonly<{
          readonly kind: "parse" | "invalid" | "load";
          readonly message: string;
        }>;
        readonly providers: readonly Readonly<{
          readonly providerId: string;
          readonly stored: boolean;
          readonly storedType?: "api_key" | "oauth";
          readonly environment: boolean;
          readonly modelsJson: boolean;
          readonly commandDerived: boolean;
          readonly expired: boolean;
          readonly unavailable: boolean;
          readonly effectiveSource:
            | "stored"
            | "environment"
            | "models.json"
            | "command"
            | "none";
        }>[];
      }>
    | undefined;
  readonly shell: WindowsShellHost;
}) {
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [loginProvider, setLoginProvider] = useState<string>("");
  const [loginValue, setLoginValue] = useState<string>("");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [importPreview, setImportPreview] = useState<
    | Readonly<{
        readonly importId: string;
        readonly expectedRevision: number;
        readonly entries: readonly Readonly<{
          readonly providerId: string;
          readonly type: "api_key" | "oauth";
          readonly wouldOverwrite: boolean;
        }>[];
        readonly confirmations: Readonly<Record<string, boolean>>;
      }>
    | undefined
  >();
  const [authOptions, setAuthOptions] = useState<
    readonly AuthProviderOption[] | undefined
  >();
  const [flow, setFlow] = useState<AuthFlowState | undefined>();
  /** Guards the flow panel's own actions (answer/cancel); the page-level
   *  busy state never blocks the flow, and vice versa. */
  const [flowBusy, setFlowBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const providers = credentials?.providers ?? [];
  const revision = credentials?.revision ?? 0;
  const flowActive =
    flow !== undefined &&
    flow.terminal === undefined &&
    flow.failure === undefined;

  // Page-open refresh (Ticket 12 repair): query the authority so an
  // external Pi-compatible auth.json edit updates the status projection
  // through the single query path. No polling, no file watcher; the host
  // publishes the sanitized projection when the revision changes. Ticket
  // 13: the same open refreshes the per-Provider login options (metadata
  // only, plus the refreshed status rows).
  useEffect(() => {
    void shell
      .executeCredentialCommand({ command: "query" })
      .catch(() => undefined);
    void refreshAuthOptions();
  }, [shell]);

  const refreshAuthOptions = () => {
    void shell
      .executeAuthCommand({ command: "query" })
      .then(
        (result) => {
          if (result.outcome === "ok" && result.options !== undefined) {
            setAuthOptions(result.options.providers);
          }
        },
        () => undefined,
      );
  };

  const run = async (operation: () => Promise<void>, label: string) => {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const login = () =>
    run(async () => {
      const providerId = loginProvider || (providers[0]?.providerId ?? "");
      if (providerId.length === 0) {
        throw new Error("No Provider is available for API key login");
      }
      const row = providers.find((entry) => entry.providerId === providerId);
      const result = await shell.executeCredentialCommand({
        command: "login",
        providerId,
        expectedRevision: revision,
        value: loginValue,
        overwrite: confirmOverwrite || row?.stored !== true,
      });
      if (result.outcome === "overwrite_required") {
        throw new Error(
          `Provider ${providerId} already has a stored credential. Confirm the replacement to continue.`,
        );
      }
      if (result.outcome !== "ok") {
        throw new Error(result.error ?? "Credential login failed");
      }
      setLoginValue("");
      setConfirmOverwrite(false);
      setNotice(`Stored API key credential for ${providerId}.`);
      void refreshAuthOptions();
    }, "login");

  const logout = (providerId: string) =>
    run(async () => {
      const result = await shell.executeCredentialCommand({
        command: "logout",
        providerId,
        expectedRevision: revision,
      });
      if (result.outcome !== "ok") {
        throw new Error(result.error ?? "Credential logout failed");
      }
      setNotice(
        result.changed === true
          ? `Stored credential removed for ${providerId}.`
          : `No stored credential to remove for ${providerId}.`,
      );
      void refreshAuthOptions();
    }, `logout:${providerId}`);

  /** Starts the Provider-owned account/subscription login flow (Ticket
   *  13). The flow panel is driven exclusively by typed interaction
   *  events; the login promise resolves with the terminal outcome. */
  const startAccountLogin = (providerId: string) => {
    setError(undefined);
    setNotice(undefined);
    setFlow({ providerId, events: [], pendingPrompt: undefined, promptValue: "" });
    void shell
      .executeAuthCommand(
        { command: "login", providerId, authType: "oauth" },
        (event) => {
          setFlow((previous) => {
            if (previous === undefined || previous.providerId !== providerId) {
              return previous;
            }
            return {
              ...previous,
              events: [...previous.events, event],
              pendingPrompt:
                event.type === "prompt" ? event : previous.pendingPrompt,
            };
          });
          // Auto-open the browser/verification page exactly once for a
          // newly received URL event; the manual Open/Copy controls and
          // the visible URL remain as the fallback either way.
          if (event.type === "auth_url") {
            autoOpenUrl(event.url);
          } else if (event.type === "device_code") {
            autoOpenUrl(event.verificationUri);
          }
        },
      )
      .then(
        (result) => {
          setFlow((previous) =>
            previous === undefined || previous.providerId !== providerId
              ? previous
              : { ...previous, terminal: result, pendingPrompt: undefined },
          );
          if (result.outcome === "ok") {
            setNotice(`Signed in to ${providerId}.`);
          }
          void refreshAuthOptions();
        },
        (caught) => {
          setFlow((previous) =>
            previous === undefined || previous.providerId !== providerId
              ? previous
              : {
                  ...previous,
                  failure:
                    caught instanceof Error ? caught.message : String(caught),
                },
          );
          void refreshAuthOptions();
        },
      );
  };

  /** Routes one typed prompt answer into the active flow. */
  const answerPrompt = (value: string) => {
    const pending = flow?.pendingPrompt;
    if (pending === undefined) return;
    setFlowBusy(true);
    void shell
      .respondAuthInteraction({
        type: "prompt_response",
        promptId: pending.promptId,
        value,
      })
      .then(
        () => {
          // Clear only the answered prompt: if the Provider already
          // asked the next prompt before the ack landed, keep it.
          setFlow((previous) =>
            previous === undefined ||
            previous.pendingPrompt?.promptId !== pending.promptId
              ? previous
              : { ...previous, pendingPrompt: undefined, promptValue: "" },
          );
        },
        (caught) => {
          setFlow((previous) =>
            previous === undefined
              ? previous
              : {
                  ...previous,
                  failure:
                    caught instanceof Error ? caught.message : String(caught),
                },
          );
        },
      )
      .finally(() => setFlowBusy(false));
  };

  const changePromptValue = (value: string) => {
    setFlow((previous) =>
      previous === undefined
        ? previous
        : { ...previous, promptValue: value },
    );
  };

  /** Cancels the active flow; the host aborts the Provider-owned login
   *  and the login promise resolves with the `cancelled` outcome. */
  const cancelFlow = () => {
    setFlowBusy(true);
    void shell
      .respondAuthInteraction({ type: "cancel" })
      .then(() => undefined, () => undefined)
      .finally(() => setFlowBusy(false));
  };

  /** OS browser/verification-page opening (thin shell capability); the
   *  URL always stays visible and copyable as the manual fallback. */
  const openUrl = (url: string) => {
    void shell.openUrl(url).catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };

  /** Auto-open for a newly received browser/verification URL (Ticket 13):
   *  attempted exactly once per event — this runs from the per-event
   *  interaction callback, never from render or effect — and a failure
   *  never fails or cancels the Provider flow: the URL row stays visible
   *  and copyable and a concise note guides the user to the manual
   *  fallback. The strict http/https guard lives in the runtime/OS seam. */
  const autoOpenUrl = (url: string) => {
    void shell.openUrl(url).catch(() => {
      setNotice(
        "Could not open the URL automatically. Copy it and open it manually.",
      );
    });
  };

  const copyText = (text: string) => {
    if (navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(text).then(
      () => setNotice("Copied to clipboard."),
      () => undefined,
    );
  };

  const pickImportFile = () => fileRef.current?.click();

  const previewImport = (content: string) =>
    run(async () => {
      const result = await shell.executeCredentialCommand({
        command: "import_preview",
        expectedRevision: revision,
        content,
      });
      if (result.outcome !== "ok") {
        throw new Error(result.error ?? "Credential import is invalid");
      }
      const confirmations: Record<string, boolean> = Object.create(null);
      for (const entry of result.previewEntries ?? []) {
        confirmations[entry.providerId] = false;
      }
      setImportPreview({
        importId: result.importId as string,
        expectedRevision: result.revision,
        entries: result.previewEntries ?? [],
        confirmations,
      });
    }, "import-preview");

  const applyImport = () =>
    run(async () => {
      if (importPreview === undefined) return;
      const selections = importPreview.entries
        .filter(
          (entry) =>
            !entry.wouldOverwrite ||
            importPreview.confirmations[entry.providerId] === true,
        )
        .map((entry) => ({
          providerId: entry.providerId,
          overwrite: importPreview.confirmations[entry.providerId] === true,
        }));
      if (selections.length === 0) {
        throw new Error("Select at least one Provider to import");
      }
      const result = await shell.executeCredentialCommand({
        command: "import_apply",
        expectedRevision: importPreview.expectedRevision,
        importId: importPreview.importId,
        selections,
      });
      if (result.outcome === "overwrite_required") {
        throw new Error(
          "One or more Providers already have stored credentials. Confirm each overwrite to continue.",
        );
      }
      if (result.outcome !== "ok") {
        throw new Error(result.error ?? "Credential import failed");
      }
      const summary = (result.entries ?? [])
        .map((entry) => `${entry.providerId} (${entry.outcome})`)
        .join(", ");
      setImportPreview(undefined);
      setNotice(`Imported credentials: ${summary}.`);
    }, "import-apply");

  const toggleConfirmation = (providerId: string) => {
    setImportPreview((previous) =>
      previous === undefined
        ? previous
        : {
            ...previous,
            confirmations: {
              ...previous.confirmations,
              [providerId]: previous.confirmations[providerId] !== true,
            },
          },
    );
  };

  const terminalCopy = (result: AuthCommandResult): string => {
    if (result.outcome === "ok") return "Signed in.";
    if (result.outcome === "cancelled") return "Sign-in cancelled.";
    return result.error ?? `Sign-in failed (${result.outcome}).`;
  };

  return (
    <section className="credentials-page" aria-label="Credentials">
      <div className="settings-group">
        <strong>API-key credentials</strong>
        {credentials === undefined ? (
          <p>No credential status is available yet.</p>
        ) : (
          <p className="credential-file-facts">
            auth.json: {credentials.path}
            <small>
              revision {credentials.revision}
              {credentials.present ? "" : " · file absent"}
              {credentials.valid ? "" : " · invalid file"}
            </small>
          </p>
        )}
        {credentials?.valid === false && credentials.error !== undefined ? (
          <p className="credential-file-error" aria-live="polite">
            {credentials.error.message}
          </p>
        ) : null}
        <div className="settings-rows">
          {providers.map((row) => (
            <div className="settings-row credential-row" key={row.providerId}>
              <span>
                {row.providerId}
                <small>
                  {row.stored
                    ? `stored: ${row.storedType === "oauth" ? "OAuth" : "API key"}${row.expired ? " (expired)" : ""}`
                    : "no stored credential"}
                  {row.modelsJson ? " · models.json key" : ""}
                  {row.commandDerived ? " · command-derived" : ""}
                  {row.environment ? " · environment" : ""}
                </small>
              </span>
              <span className="credential-facts">
                {row.unavailable ? (
                  <em className="credential-unavailable">unavailable</em>
                ) : (
                  <em>{EFFECTIVE_SOURCE_LABEL[row.effectiveSource]}</em>
                )}
                {row.stored ? (
                  <button
                    disabled={busy !== undefined}
                    onClick={() => void logout(row.providerId)}
                    type="button"
                  >
                    Logout
                  </button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <strong>Sign in</strong>
        <p>
          <small>
            The two choices per Provider are "Use an account or
            subscription" (a Provider-owned interactive flow) and "Use an
            API key" (stored value). Only Provider metadata labels a flow
            as a true subscription.
          </small>
        </p>
        {authOptions === undefined ? (
          <p>No login options are available yet.</p>
        ) : authOptions.length === 0 ? (
          <p>No Provider offers an interactive or API-key login.</p>
        ) : (
          <div className="settings-rows">
            {authOptions.map((option) => (
              <div className="settings-row" key={option.providerId}>
                <span>
                  {option.name}
                  <small>
                    {option.subscription
                      ? "Subscription account"
                      : option.account
                        ? "Account (OAuth)"
                        : "No account flow"}
                    {option.apiKey ? " · API key available" : ""}
                  </small>
                </span>
                <span className="credential-facts">
                  {option.account ? (
                    <button
                      disabled={busy !== undefined || flowActive}
                      onClick={() => void startAccountLogin(option.providerId)}
                      type="button"
                    >
                      Use an account or subscription
                    </button>
                  ) : null}
                  {option.apiKey ? (
                    <button
                      disabled={busy !== undefined || flowActive}
                      onClick={() => {
                        setFlow(undefined);
                        setLoginProvider(option.providerId);
                      }}
                      type="button"
                    >
                      Use an API key
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {flow === undefined ? null : (
        <div
          aria-label={`Sign-in flow for ${flow.providerId}`}
          className="settings-group auth-flow-panel"
        >
          <strong>Sign in to {flow.providerId}</strong>
          {flow.events.map((event, index) => (
            <FlowEventRow
              event={event}
              key={index}
              onOpenUrl={openUrl}
              onCopy={copyText}
            />
          ))}
          {flow.pendingPrompt === undefined ? null : (
            <PromptForm
              disabled={flowBusy}
              flow={flow}
              onAnswer={answerPrompt}
              onCancel={cancelFlow}
              onPromptValueChange={changePromptValue}
            />
          )}
          {flow.terminal === undefined ? null : (
            <p
              aria-live="polite"
              className={
                flow.terminal.outcome === "ok"
                  ? "credential-notice auth-flow-terminal"
                  : "auth-flow-terminal"
              }
            >
              {terminalCopy(flow.terminal)}
            </p>
          )}
          {flow.failure === undefined ? null : (
            <p className="credential-error" aria-live="polite">
              {flow.failure}
            </p>
          )}
          {flowActive ? (
            <button
              disabled={flowBusy}
              onClick={() => void cancelFlow()}
              type="button"
            >
              Cancel sign-in
            </button>
          ) : (
            <button
              disabled={flowBusy}
              onClick={() => setFlow(undefined)}
              type="button"
            >
              Close
            </button>
          )}
        </div>
      )}

      <div className="settings-group">
        <strong>Store an API key</strong>
        <div className="settings-rows">
          <label className="settings-row">
            <span>
              Provider
              <small>One stored credential slot per Provider</small>
            </span>
            <select
              disabled={busy !== undefined || providers.length === 0}
              onChange={(event) => setLoginProvider(event.target.value)}
              value={loginProvider || (providers[0]?.providerId ?? "")}
            >
              {providers.map((row) => (
                <option key={row.providerId} value={row.providerId}>
                  {row.providerId}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-row">
            <span>
              Value
              <small>
                Literal secret, $VAR / $&#123;VAR&#125; reference or !command
                source
              </small>
            </span>
            <input
              disabled={busy !== undefined}
              onChange={(event) => setLoginValue(event.target.value)}
              placeholder="sk-... / $ENV_NAME / !command"
              type="password"
              value={loginValue}
            />
          </label>
          {providers.find(
            (row) =>
              row.providerId ===
              (loginProvider || (providers[0]?.providerId ?? "")),
          )?.stored === true ? (
            <label className="settings-row">
              <span>
                Replace existing
                <small>Confirm replacement of the stored credential</small>
              </span>
              <input
                checked={confirmOverwrite}
                disabled={busy !== undefined}
                onChange={(event) => setConfirmOverwrite(event.target.checked)}
                type="checkbox"
              />
            </label>
          ) : null}
        </div>
        <button
          disabled={busy !== undefined || loginValue.length === 0}
          onClick={() => void login()}
          type="button"
        >
          Store API key credential
        </button>
      </div>

      <div className="settings-group">
        <strong>Import auth.json</strong>
        <p>
          <small>
            Pi-compatible auth.json import, Provider by Provider. Overwrites
            require confirmation.
          </small>
        </p>
        {importPreview === undefined ? (
          <button
            disabled={busy !== undefined}
            onClick={pickImportFile}
            type="button"
          >
            Choose auth.json file
          </button>
        ) : (
          <div className="settings-rows">
            {importPreview.entries.map((entry) => (
              <label className="settings-row" key={entry.providerId}>
                <span>
                  {entry.providerId}
                  <small>
                    {entry.type === "oauth" ? "OAuth entry" : "API key entry"}
                    {entry.wouldOverwrite
                      ? " · overwrites an existing credential"
                      : ""}
                  </small>
                </span>
                {entry.wouldOverwrite ? (
                  <input
                    checked={
                      importPreview.confirmations[entry.providerId] === true
                    }
                    disabled={busy !== undefined}
                    onChange={() => toggleConfirmation(entry.providerId)}
                    type="checkbox"
                  />
                ) : (
                  <span className="credential-facts">new</span>
                )}
              </label>
            ))}
            <div className="runtime-actions">
              <button
                disabled={busy !== undefined}
                onClick={() => void applyImport()}
                type="button"
              >
                Apply confirmed imports
              </button>
              <button
                disabled={busy !== undefined}
                onClick={() => setImportPreview(undefined)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <input
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) return;
            void file.text().then(previewImport);
            event.target.value = "";
          }}
          ref={fileRef}
          type="file"
        />
      </div>

      {notice === undefined ? null : (
        <p className="credential-notice" aria-live="polite">
          {notice}
        </p>
      )}
      {error === undefined ? null : (
        <p className="credential-error" aria-live="polite">
          {error}
        </p>
      )}
    </section>
  );
}

/** One typed interaction event projected into the flow panel. URL opening
 *  is the thin shell's OS capability; every URL stays visible and
 *  copyable. Prompt events are shown as text only — answer values (which
 *  may be secrets) are never rendered back into the transcript. */
function FlowEventRow({
  event,
  onOpenUrl,
  onCopy,
}: {
  readonly event: AuthInteractionEvent;
  readonly onOpenUrl: (url: string) => void;
  readonly onCopy: (text: string) => void;
}) {
  switch (event.type) {
    case "info":
      return (
        <p className="auth-flow-info">
          {event.message}
          {event.links === undefined
            ? null
            : event.links.map((link) => (
                <button
                  key={link.url}
                  onClick={() => onOpenUrl(link.url)}
                  type="button"
                >
                  {link.label ?? "Open link"}
                </button>
              ))}
        </p>
      );
    case "auth_url":
      return (
        <div className="auth-flow-url">
          {event.instructions === undefined ? null : (
            <p>{event.instructions}</p>
          )}
          <div className="auth-url-row">
            <input readOnly value={event.url} />
            <button onClick={() => onOpenUrl(event.url)} type="button">
              Open in browser
            </button>
            <button onClick={() => onCopy(event.url)} type="button">
              Copy
            </button>
          </div>
          <p>
            <small>
              If the browser does not open, copy the URL and open it
              manually.
            </small>
          </p>
        </div>
      );
    case "device_code":
      return (
        <div className="auth-flow-device">
          <p>
            Open the verification page and enter the code:
            <button
              onClick={() => onOpenUrl(event.verificationUri)}
              type="button"
            >
              Open verification page
            </button>
          </p>
          <p className="auth-user-code">
            <code>{event.userCode}</code>
            <button onClick={() => onCopy(event.userCode)} type="button">
              Copy code
            </button>
          </p>
          {event.expiresInSeconds === undefined ? null : (
            <p>
              <small>
                The code expires in {event.expiresInSeconds} seconds; poll
                every {event.intervalSeconds ?? "?"} seconds.
              </small>
            </p>
          )}
        </div>
      );
    case "progress":
      return <p className="auth-flow-progress">{event.message}</p>;
    case "prompt":
      // The active prompt is rendered by the form below; the transcript
      // shows only the Provider's message, never an answer value.
      return <p className="auth-flow-prompt">{event.message}</p>;
  }
}

/** The active typed prompt: select options answer directly; text/secret
 *  inputs submit the entered value; cancel aborts the whole flow. */
function PromptForm({
  flow,
  disabled,
  onAnswer,
  onCancel,
  onPromptValueChange,
}: {
  readonly flow: AuthFlowState;
  readonly disabled: boolean;
  readonly onAnswer: (value: string) => void;
  readonly onCancel: () => void;
  readonly onPromptValueChange: (value: string) => void;
}) {
  const prompt = flow.pendingPrompt;
  if (prompt === undefined) return null;
  if (prompt.kind === "select") {
    return (
      <div className="auth-flow-prompt-form">
        <p>{prompt.message}</p>
        <div className="runtime-actions">
          {(prompt.options ?? []).map((option) => (
            <button
              disabled={disabled}
              key={option.id}
              onClick={() => onAnswer(option.id)}
              type="button"
            >
              {option.label}
              {option.description === undefined
                ? null
                : ` — ${option.description}`}
            </button>
          ))}
        </div>
        <button disabled={disabled} onClick={onCancel} type="button">
          Cancel sign-in
        </button>
      </div>
    );
  }
  return (
    <div className="auth-flow-prompt-form">
      <label className="settings-row">
        <span>
          {prompt.message}
          <small>
            {prompt.kind === "secret"
              ? "Secret input"
              : prompt.kind === "manual_code"
                ? "Enter the code manually"
                : "Text input"}
          </small>
        </span>
        <input
          disabled={disabled}
          onChange={(event) => onPromptValueChange(event.target.value)}
          placeholder={prompt.placeholder}
          type={prompt.kind === "secret" ? "password" : "text"}
          value={flow.promptValue}
        />
      </label>
      <div className="runtime-actions">
        <button
          disabled={disabled || flow.promptValue.length === 0}
          onClick={() => onAnswer(flow.promptValue)}
          type="button"
        >
          Submit
        </button>
        <button disabled={disabled} onClick={onCancel} type="button">
          Cancel sign-in
        </button>
      </div>
    </div>
  );
}
