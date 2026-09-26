import { describe, expect, it } from "vitest";

import { rewriteModelJson } from "../../src/provider-native-responses/common.js";
import {
  projectProviderNativeBody,
  TOOL_CALL_ADJACENCY_DEFERRED_NOTICE_CODE,
  TOOL_CALL_GROUP_ABANDONED_NOTICE_CODE,
  TOOL_CALL_GROUP_UNSUPPORTED_ITEM_NOTICE_CODE,
} from "../../src/provider-native-responses/tool-call-adjacency.js";

const ALIAS = "commandcode-goat/deepseek-v4.1-flash";
const RESOLVED = "deepseek/deepseek-v4.1-flash";

function call(id: string, type = "function_call"): Record<string, unknown> {
  return { type, call_id: id, name: "exec_command", arguments: "{}" };
}

function result(id: string, type = "function_call_output"): Record<string, unknown> {
  return { type, call_id: id, output: "ok" };
}

function notice(text = "resize notice"): Record<string, unknown> {
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

function reasoning(): Record<string, unknown> {
  return { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] };
}

function bodyWith(items: readonly unknown[], model = ALIAS): string {
  return JSON.stringify({ model, input: items });
}

function project(raw: string, modelId = RESOLVED, operation: "responses" | "compact" = "responses") {
  return projectProviderNativeBody(raw, modelId, operation);
}

describe("provider native tool-call adjacency projection", () => {
  it("keeps the model-only projection byte-identical when no group is interrupted", () => {
    const raw = bodyWith([call("a"), call("b"), result("a"), result("b")]);
    const baseline = rewriteModelJson(raw, RESOLVED);
    const projection = project(raw);
    expect(projection.outcome).toBe("model-only");
    expect(projection.text).toBe(baseline.text);
  });

  it("defers an original developer message slice out of a closed group", () => {
    const raw = bodyWith([call("a"), call("b"), result("a"), notice(), result("b")]);
    const projection = project(raw);
    expect(projection.outcome).toBe("deferred");
    expect(projection.deferredMessages).toBe(1);
    expect(projection.text).toBe(
      JSON.stringify({
        model: RESOLVED,
        input: [call("a"), call("b"), result("a"), result("b"), notice()],
      }),
    );
    expect(JSON.stringify(projection.parsed.input)).toBe(
      JSON.stringify([call("a"), call("b"), result("a"), result("b"), notice()]),
    );
  });

  it("keeps unrelated bytes, escaped tokens and nested model keys untouched", () => {
    const prefix = '{\n  "model" : "alias",  "future_number":9007199254740993, "negative_zero":-0, "scientific":1e+30,';
    const raw = `${prefix} "nested":{"model":"leave-me"}, "input": [${[
      call("a"),
      call("b"),
      result("a"),
      notice(),
      result("b"),
    ]
      .map((item) => JSON.stringify(item))
      .join(", ")}]}`;
    const projection = project(raw, "alias");
    expect(projection.outcome).toBe("deferred");
    expect(projection.text.startsWith(prefix + ' "nested":{"model":"leave-me"}, "input": [')).toBe(true);
    expect(projection.text).toContain('"future_number":9007199254740993');
    expect(projection.text).toContain('"negative_zero":-0');
    expect(projection.text).toContain('"scientific":1e+30');
    expect(projection.text).toContain('"nested":{"model":"leave-me"}');
    const moved = JSON.stringify(notice());
    expect(projection.text.indexOf(moved)).toBeGreaterThan(
      projection.text.indexOf(JSON.stringify(result("b"))),
    );
  });

  it("preserves array frame and edge whitespace when the input key precedes the model key", () => {
    const items = [call("a"), call("b"), result("a"), notice(), result("b")];
    const raw = `{\n  "input": [\n    ${items.map((i) => JSON.stringify(i)).join(",\n    ")}\n  ],\n  "model": "${ALIAS}"\n}`;
    const projection = project(raw);
    expect(projection.outcome).toBe("deferred");
    expect(projection.text).toContain('"input": [\n    ');
    expect(projection.text.endsWith('\n  ],\n  "model": "deepseek/deepseek-v4.1-flash"\n}')).toBe(true);
    expect(projection.text.indexOf(JSON.stringify(notice()))).toBeGreaterThan(
      projection.text.indexOf(JSON.stringify(result("b"))),
    );
  });

  it("does not reorder compact bodies", () => {
    const raw = bodyWith([call("a"), call("b"), result("a"), notice(), result("b")]);
    const projection = project(raw, RESOLVED, "compact");
    expect(projection.outcome).toBe("model-only");
    expect(projection.text).toBe(rewriteModelJson(raw, RESOLVED).text);
  });

  it("does not reorder when input is a string", () => {
    const raw = JSON.stringify({ model: ALIAS, input: "hello" });
    const projection = project(raw);
    expect(projection.outcome).toBe("model-only");
    expect(projection.text).toBe(rewriteModelJson(raw, RESOLVED).text);
  });

  it("abandons the request when a message appears before the first result", () => {
    const raw = bodyWith([call("a"), notice(), result("a")]);
    const projection = project(raw);
    expect(projection.outcome).toBe("unsupported-item");
    expect(projection.text).toBe(rewriteModelJson(raw, RESOLVED).text);
  });

  it("abandons the request for non-developer messages and reasoning inside a group", () => {
    const userMessage = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
    for (const intruder of [userMessage, reasoning(), { type: "agent_message", encrypted_content: "x" }]) {
      const raw = bodyWith([call("a"), call("b"), result("a"), intruder, result("b")]);
      const projection = project(raw);
      expect(projection.outcome).toBe("unsupported-item");
      expect(projection.text).toBe(rewriteModelJson(raw, RESOLVED).text);
    }
  });

  it("abandons the request when an id-correlated family appears inside a group", () => {
    const raw = bodyWith([
      call("a"),
      { type: "local_shell_call_output", id: "shell_1" },
      result("a"),
    ]);
    const projection = project(raw);
    expect(projection.outcome).toBe("unsupported-item");
  });

  it("moves only the group that was interrupted", () => {
    const raw = bodyWith([
      call("a"),
      result("a"),
      call("b"),
      call("c"),
      result("b"),
      notice("second group"),
      result("c"),
    ]);
    const projection = project(raw);
    expect(projection.outcome).toBe("deferred");
    const moved = JSON.stringify(notice("second group"));
    expect(projection.text.endsWith(moved.replace(/\}$/u, "}") + "]}")).toBe(true);
    expect(projection.text.indexOf(JSON.stringify(result("a")))).toBeLessThan(
      projection.text.indexOf(JSON.stringify(call("b"))),
    );
  });

  it("keeps relative order of multiple deferred messages", () => {
    const raw = bodyWith([
      call("a"),
      call("b"),
      result("a"),
      notice("first"),
      notice("second"),
      result("b"),
    ]);
    const projection = project(raw);
    expect(projection.outcome).toBe("deferred");
    expect(projection.deferredMessages).toBe(2);
    expect(projection.text.indexOf(JSON.stringify(notice("first")))).toBeLessThan(
      projection.text.indexOf(JSON.stringify(notice("second"))),
    );
    expect(projection.text.indexOf(JSON.stringify(result("b")))).toBeLessThan(
      projection.text.indexOf(JSON.stringify(notice("first"))),
    );
  });

  it("abandons an unclosed group that contains a deferred candidate", () => {
    const raw = bodyWith([call("a"), call("b"), result("a"), notice()]);
    const projection = project(raw, RESOLVED);
    expect(projection.outcome).toBe("abandoned");
    expect(projection.text).toBe(rewriteModelJson(raw, RESOLVED).text);
  });

  it("stays silent for structural anomalies without an interrupted group", () => {
    const cases = [
      bodyWith([call("a")]),
      bodyWith([result("a")]),
      bodyWith([call("a"), result("a"), call("a"), result("a")]),
      bodyWith([call("a"), result("a", "custom_tool_call_output")]),
      bodyWith([call("a"), { type: "function_call", name: "x" }, result("a")]),
      bodyWith([call("a"), { type: "function_call", call_id: 7 }, result("a")]),
      bodyWith([call("a"), { type: "function_call", call_id: "" }, result("a")]),
    ];
    for (const raw of cases) {
      const projection = project(raw);
      expect(projection.outcome).toBe("model-only");
      expect(projection.text).toBe(rewriteModelJson(raw, RESOLVED).text);
    }
  });

  it("abandons escaped duplicate top-level keys", () => {
    const items = [call("a"), call("b"), result("a"), notice(), result("b")];
    const raw = `{"input":[${items.map((i) => JSON.stringify(i)).join(",")}],"model":"${ALIAS}","\\u0069nput":[]}`;
    const projection = project(raw);
    expect(projection.outcome).toBe("model-only");
  });

  it("abandons duplicated classification keys inside an element", () => {
    const duplicated = `{"type":"function_call","\\u0074ype":"function_call","call_id":"a","name":"exec_command","arguments":"{}"}`;
    const items = `[${duplicated},${JSON.stringify(call("b"))},${JSON.stringify(
      result("a"),
    )},${JSON.stringify(notice())},${JSON.stringify(result("b"))}]`;
    const projection = project(`{"model":"${ALIAS}","input":${items}}`);
    expect(projection.outcome).toBe("abandoned");
  });

  it("only replaces the model literal when the selector already matches", () => {
    const raw = bodyWith([call("a"), call("b"), result("a"), notice(), result("b")], RESOLVED);
    const projection = project(raw, RESOLVED);
    expect(projection.outcome).toBe("deferred");
    expect(projection.text).not.toBe(raw);
    expect(projection.text.startsWith('{"model":"deepseek/deepseek-v4.1-flash","input":')).toBe(true);
    expect(projection.text.split(JSON.stringify(call("a"))).length).toBe(raw.split(JSON.stringify(call("a"))).length);
  });

  it("exposes the notice codes used by the lane observation seam", () => {
    expect(TOOL_CALL_ADJACENCY_DEFERRED_NOTICE_CODE).toBe(
      "provider_native_tool_call_adjacency_deferred",
    );
    expect(TOOL_CALL_GROUP_ABANDONED_NOTICE_CODE).toBe(
      "provider_native_tool_call_group_abandoned",
    );
    expect(TOOL_CALL_GROUP_UNSUPPORTED_ITEM_NOTICE_CODE).toBe(
      "provider_native_tool_call_group_unsupported_item",
    );
  });
});
