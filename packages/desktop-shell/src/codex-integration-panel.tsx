import type { CodexIntegrationProjection } from "@luckytoken/application-control-plane/control-plane";

export interface CodexIntegrationPanelProps {
  readonly state?: CodexIntegrationProjection;
  readonly busy: boolean;
  readonly error?: string;
  readonly onToggle: (enabled: boolean) => void;
  readonly onSync: () => void;
}

function observedLabel(state: CodexIntegrationProjection["observedState"]): string {
  switch (state) {
    case "native":
      return "Native";
    case "managed":
      return "Managed by LuckyToken";
    case "drifted":
      return "Configuration drift";
    case "conflict":
      return "Configuration conflict";
    case "unavailable":
      return "Unavailable";
  }
}

export function CodexIntegrationPanel({
  state,
  busy,
  error,
  onToggle,
  onSync,
}: CodexIntegrationPanelProps) {
  const enabled = state?.desiredEnabled ?? false;
  return (
    <section className="codex-integration-card" aria-label="Codex Integration">
      <div className="codex-integration-heading">
        <div>
          <h2>Codex Integration</h2>
          <p>
            LuckyToken can accept native Codex Responses requests independently
            of whether it manages your local Codex configuration.
          </p>
        </div>
      </div>

      <div className="codex-integration-status-grid">
        <div>
          <span>Native Codex request support</span>
          <strong>Supported</strong>
        </div>
        <div>
          <span>Observed routing</span>
          <strong>{state === undefined ? "Checking…" : observedLabel(state.observedState)}</strong>
        </div>
        {state?.modelCount === undefined ? null : (
          <div>
            <span>Models</span>
            <strong>{state.modelCount}</strong>
          </div>
        )}
      </div>

      <label className="codex-integration-toggle">
        <input
          checked={enabled}
          disabled={busy || state === undefined}
          onChange={(event) => onToggle(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>
          <strong>Route local Codex through LuckyToken</strong>
          <small>
            Manages only Codex routing and model catalog files. Native request
            support remains available when this is off.
          </small>
        </span>
      </label>

      {state?.message === undefined ? null : (
        <p className="codex-integration-message">{state.message}</p>
      )}
      {state?.restartRequired === true ? (
        <p className="codex-integration-restart">
          Restart Codex to load the updated routing and model catalog.
        </p>
      ) : null}
      {state === undefined || state.warnings.length === 0 ? null : (
        <ul className="codex-integration-warnings">
          {state.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {error === undefined ? null : (
        <p className="codex-integration-error" role="alert">{error}</p>
      )}

      {enabled ? (
        <div className="codex-integration-actions">
          <button disabled={busy} onClick={onSync} type="button">
            Sync Models
          </button>
        </div>
      ) : null}
    </section>
  );
}
