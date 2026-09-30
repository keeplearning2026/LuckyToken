import { useEffect, useMemo, useState } from "react";

import type { TokenDesktopApi } from "../../shared/desktop-api.js";
import type { AgentIntegrationControls } from "./useAgentIntegrations.js";

const CLAUDE_MODEL_SETTINGS = Object.freeze([
  { key: "integrations.claude.model", label: "Main model", aria: "Claude main model" },
  { key: "integrations.claude.opusModel", label: "Opus model", aria: "Claude Opus model" },
  { key: "integrations.claude.sonnetModel", label: "Sonnet model", aria: "Claude Sonnet model" },
  { key: "integrations.claude.haikuModel", label: "Haiku model", aria: "Claude Haiku model" },
  { key: "integrations.claude.subagentModel", label: "Subagent model", aria: "Claude subagent model" },
] as const);

type ClaudeSettingKey = (typeof CLAUDE_MODEL_SETTINGS)[number]["key"];

const settingKeys = Object.freeze(CLAUDE_MODEL_SETTINGS.map((entry) => entry.key));

export function ClaudeSettings({
  api,
  agentIntegrations,
}: {
  readonly api: TokenDesktopApi;
  readonly agentIntegrations: AgentIntegrationControls;
}) {
  const [values, setValues] = useState<Partial<Record<ClaudeSettingKey, string | null>>>({});
  const [favorites, setFavorites] = useState<readonly string[]>([]);
  const [busyKey, setBusyKey] = useState<ClaudeSettingKey>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.control.executeSettings({ command: "query", keys: settingKeys }),
      api.control.executePublicModels({ command: "query" }),
    ]).then(([settings, publicModels]) => {
      if (!active) return;
      const nextValues: Partial<Record<ClaudeSettingKey, string | null>> = {};
      for (const entry of CLAUDE_MODEL_SETTINGS) {
        const value = settings.settings[entry.key]?.value;
        nextValues[entry.key] = typeof value === "string" ? value : null;
      }
      const aliases = publicModels.state.providers.flatMap((provider) =>
        provider.models
          .filter((model) => model.favorite)
          .map((model) => model.alias),
      );
      setValues(nextValues);
      setFavorites(Object.freeze([...new Set(aliases)].sort((a, b) => a.localeCompare(b))));
    }, () => {
      if (!active) return;
      setNotice("Claude Code model settings are temporarily unavailable.");
    });
    return () => {
      active = false;
    };
  }, [api]);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const save = async (key: ClaudeSettingKey, value: string): Promise<void> => {
    setBusyKey(key);
    setNotice(undefined);
    try {
      const result = await api.control.executeSettings({
        command: "set",
        key,
        value: value.length === 0 ? null : value,
      });
      if (result.outcome !== "applied") {
        setNotice(result.error ?? "Claude Code model selection could not be saved.");
        return;
      }
      const stored = result.settings[key]?.value;
      setValues((current) => ({
        ...current,
        [key]: typeof stored === "string" ? stored : null,
      }));
      await agentIntegrations.refresh();
    } catch {
      setNotice("Claude Code model selection could not be saved.");
    } finally {
      setBusyKey(undefined);
    }
  };

  return (
    <section className="page-stack" aria-label="Claude Code model slots">
      <h4 className="settings-subsection-title">Model slots</h4>
      <p className="setting-state">
        Each slot uses a Favorite model. Models with at least 1M context are injected with the Claude Code <code>[1m]</code> suffix automatically.
      </p>
      {CLAUDE_MODEL_SETTINGS.map((entry) => {
        const current = values[entry.key] ?? null;
        return (
          <label className="field-row" key={entry.key}>
            <span>{entry.label}</span>
            <select
              aria-label={entry.aria}
              value={current ?? ""}
              disabled={busyKey !== undefined}
              onChange={(event) => void save(entry.key, event.currentTarget.value)}
            >
              <option value="">Select Favorite model</option>
              {current !== null && !favoriteSet.has(current) ? (
                <option value={current} disabled>{current} (not Favorite)</option>
              ) : null}
              {favorites.map((alias) => <option value={alias} key={alias}>{alias}</option>)}
            </select>
          </label>
        );
      })}
      {notice === undefined ? null : <p className="error-text" role="status">{notice}</p>}
    </section>
  );
}
