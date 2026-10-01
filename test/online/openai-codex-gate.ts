export interface CodexOnlineLane {
  readonly status: number;
  readonly outcome: "completed" | "entitlement_uncovered" | "error";
  readonly detail?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function completed(value: unknown): boolean {
  const row = object(value);
  if (row?.type === "response.completed" || row?.type === "message_stop") return true;
  return row?.type === "message" && ["end_turn", "max_tokens", "stop_sequence", "tool_use"].includes(String(row.stop_reason));
}

/** Positive protocol completion or documented entitlement evidence only.
 * Denial codes are pinned to reference/opencodex/src/codex/quota-rejection.ts. */
export function classifyCodexOnlineLane(status: number, body: string): CodexOnlineLane {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { /* SSE is checked below. */ }
  if (status === 200 && (completed(parsed) || body.split(/\r?\n/u).some((line) => {
    if (!line.startsWith("data:")) return false;
    try { return completed(JSON.parse(line.slice(5).trim())); } catch { return false; }
  }))) return { status, outcome: "completed" };
  const row = object(parsed);
  const code = row?.code ?? object(row?.error)?.code ?? object(row?.detail)?.code;
  const entitlement = status === 403 && (code === "codex_entitlement_missing" || code === "entitlement_missing");
  return { status, outcome: entitlement ? "entitlement_uncovered" : "error", detail: body.replace(/\s+/gu, " ").slice(0, 240) };
}

export function codexOnlineGate(input: {
  readonly usage: string;
  readonly native: CodexOnlineLane;
  readonly semantic: CodexOnlineLane;
  readonly rotation: "observed" | "not_required" | "delegation_failed";
  readonly usable: boolean;
  readonly nonTerminal: boolean;
}): { readonly result: "pass" | "incomplete" | "fail"; readonly rotationCoverage: "covered" | "uncovered" } {
  const rotationCoverage = input.rotation === "observed" ? "covered" : "uncovered";
  if (input.usage !== "succeeded" || !input.usable || !input.nonTerminal || input.rotation === "delegation_failed" ||
      [input.native, input.semantic].some((lane) => lane.outcome === "error" || (lane.outcome === "completed" && lane.status !== 200))) {
    return { result: "fail", rotationCoverage };
  }
  return { result: [input.native, input.semantic].some((lane) => lane.outcome === "entitlement_uncovered") ? "incomplete" : "pass", rotationCoverage };
}
