import type { AgentIntegrationId } from "../../shared/desktop-api.js";

const icons = {
  claude: new URL("../assets/claude-code.svg", import.meta.url).href,
  "claude-desktop": new URL("../assets/claude-desktop.svg", import.meta.url).href,
  codex: new URL("../assets/codex.svg", import.meta.url).href,
  dsh: new URL("../assets/deepseek-harness.svg", import.meta.url).href,
};

export function AgentIntegrationIcon({ agentId }: { readonly agentId: AgentIntegrationId }) {
  return agentId === "pi"
    ? <span aria-hidden="true">π</span>
    : <img className={`agent-${agentId}-mark`} src={icons[agentId]} alt="" />;
}
