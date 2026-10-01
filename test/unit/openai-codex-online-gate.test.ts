import { expect, it } from "vitest";
import { classifyCodexOnlineLane, codexOnlineGate } from "../online/openai-codex-gate.js";

const completed = { status: 200, outcome: "completed" as const };
const healthy = { usage: "succeeded", native: completed, semantic: completed, rotation: "not_required" as const, usable: true, nonTerminal: true };

it("passes completed lanes and usage while leaving an untriggered rotation uncovered", () => {
  expect(codexOnlineGate(healthy)).toEqual({ result: "pass", rotationCoverage: "uncovered" });
});
it.each(["unavailable", "unsupported", "superseded"])("fails usage %s", (usage) => {
  expect(codexOnlineGate({ ...healthy, usage }).result).toBe("fail");
});
it.each([400, 401, 403, 404])("fails an unproven HTTP %s instead of treating it as entitlement", (status) => {
  const native = classifyCodexOnlineLane(status, '{"error":{"message":"rejected"}}');
  expect(codexOnlineGate({ ...healthy, native }).result).toBe("fail");
});
it("records documented entitlement rejection as incomplete, never pass", () => {
  const native = classifyCodexOnlineLane(403, '{"error":{"code":"codex_entitlement_missing"}}');
  expect(codexOnlineGate({ ...healthy, native }).result).toBe("incomplete");
});
it("fails a needed delegation and requires credential usability", () => {
  expect(codexOnlineGate({ ...healthy, rotation: "delegation_failed" }).result).toBe("fail");
  expect(codexOnlineGate({ ...healthy, usable: false }).result).toBe("fail");
});
it("requires a completion lifecycle, including a terminal stop reason for JSON messages", () => {
  expect(classifyCodexOnlineLane(200, '{"type":"message","stop_reason":null}').outcome).toBe("error");
  expect(classifyCodexOnlineLane(200, 'data: {"type":"response.completed"}\n\n').outcome).toBe("completed");
  expect(classifyCodexOnlineLane(200, '{"type":"message","stop_reason":"end_turn"}').outcome).toBe("completed");
});
