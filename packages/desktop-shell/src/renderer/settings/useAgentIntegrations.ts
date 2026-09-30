import { useEffect, useRef, useState } from "react";

import type { AgentIntegrationId, AgentInjectionScope, TokenDesktopApi } from "../../shared/desktop-api.js";

type IntegrationResult = Awaited<ReturnType<TokenDesktopApi["control"]["executeAgentIntegrations"]>>;

export function useAgentIntegrations(api: TokenDesktopApi, backendAvailable: boolean, modelRevision?: number) {
  const [state, setState] = useState<IntegrationResult["state"]>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!backendAvailable) {
      setState(undefined);
      return;
    }
    let active = true;
    void api.control.executeAgentIntegrations({ command: "query" }).then(
      (result) => { if (active && !busyRef.current) setState(result.state); },
      () => { if (active) setState(undefined); },
    );
    return () => { active = false; };
  }, [api, backendAvailable, modelRevision]);

  const accept = (result: IntegrationResult): void => {
    setState(result.state);
    const effects = result.results.flatMap((entry) => entry.effect === undefined ? [] : [entry.effect]);
    setWarnings([...new Set(effects.flatMap((effect) => effect.warnings))]);
    const messages = effects.flatMap((effect) => effect.message === undefined ? [] : [effect.message]);
    setNotice(messages.length > 0
      ? messages.join(" ")
      : result.outcome === "partial"
        ? "Some Agent integrations could not be synchronized. Successful Agents were kept."
        : result.outcome === "failed"
          ? "Agent integration update failed. Existing Agent files were preserved."
          : undefined);
  };

  const execute = async (command: Parameters<TokenDesktopApi["control"]["executeAgentIntegrations"]>[0], failure: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      accept(await api.control.executeAgentIntegrations(command));
    } catch {
      setNotice(failure);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const toggle = async (agentId: AgentIntegrationId): Promise<void> => {
    const agent = state?.agents.find((entry) => entry.agentId === agentId);
    if (agent === undefined) return;
    await execute(
      { command: "set_enabled", agentId, enabled: !agent.enabled },
      `${agentId === "claude" ? "Claude Code" : agentId === "claude-desktop" ? "Claude Desktop" : agentId === "codex" ? "Codex" : agentId === "pi" ? "Pi" : "DeepSeek Harness"} integration update failed. Existing Agent files were preserved.`,
    );
  };

  const setScope = async (
    agentId: Exclude<AgentIntegrationId, "claude">,
    scope: AgentInjectionScope,
  ): Promise<void> => {
    await execute({ command: "set_scope", agentId, scope }, "The Agent injection scope could not be saved.");
  };

  const sync = async (): Promise<void> => {
    await execute({ command: "sync" }, "Agent synchronization failed. Existing Agent files were preserved.");
  };

  const refresh = async (): Promise<void> => {
    if (!backendAvailable || busyRef.current) return;
    try {
      setState((await api.control.executeAgentIntegrations({ command: "query" })).state);
    } catch {
      setState(undefined);
    }
  };

  return { state, busy, notice, warnings, toggle, setScope, sync, refresh };
}

export type AgentIntegrationControls = ReturnType<typeof useAgentIntegrations>;
