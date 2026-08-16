/** Effective-source label shown in the Credentials page (Ticket 12). */
import { useEffect, useRef, useState } from "react";

import type { WindowsShellHost } from "./shell-lifecycle.js";

const EFFECTIVE_SOURCE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  stored: "Stored credential",
  environment: "Environment variable",
  "models.json": "models.json API key",
  command: "Command-derived key",
  none: "No effective source",
});

/**
 * Credentials page (Ticket 12): per-Provider effective authentication
 * status from the sanitized projection, API-key login (literal, $ENV or
 * !command source, stored verbatim), logout of the stored value only, and a
 * Provider-by-Provider auth.json import with overwrite confirmation. All
 * mutations run through the single Credential Authority; results and the
 * projection never carry credential values.
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
            "stored" | "environment" | "models.json" | "command" | "none";
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
  const fileRef = useRef<HTMLInputElement | null>(null);

  const providers = credentials?.providers ?? [];
  const revision = credentials?.revision ?? 0;

  // Page-open refresh (Ticket 12 repair): query the authority so an
  // external Pi-compatible auth.json edit updates the status projection
  // through the single query path. No polling, no file watcher; the host
  // publishes the sanitized projection when the revision changes.
  useEffect(() => {
    void shell
      .executeCredentialCommand({ command: "query" })
      .catch(() => undefined);
  }, [shell]);

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
    }, `logout:${providerId}`);

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
