import { describe, expect, it } from "vitest";

import {
  deriveFunctionCallNamespaceIndex,
  repairFunctionCallNamespaces,
} from "../../src/protocols/openai-responses/function-call-namespace-repair.js";

function requestBody(tools: readonly unknown[]): string {
  return JSON.stringify({ model: "m", input: "x", tools });
}

const DECLARED_TOOLS = [
  { type: "function", name: "exec_command", parameters: { type: "object" } },
  {
    type: "namespace",
    name: "multi_agent_v1",
    description: "sub-agents",
    tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "wait_agent", parameters: { type: "object" } },
    ],
  },
  {
    type: "namespace",
    name: "mcp__cua_repl",
    tools: [{ type: "function", name: "js", parameters: { type: "object" } }],
  },
  {
    type: "namespace",
    name: "mcp__node_repl",
    tools: [{ type: "function", name: "js", parameters: { type: "object" } }],
  },
];

function indexFor() {
  const index = deriveFunctionCallNamespaceIndex(requestBody(DECLARED_TOOLS));
  if (index === undefined) throw new Error("index must exist");
  return index;
}

function sseItem(item: Readonly<Record<string, unknown>>): string {
  const event = { type: "response.output_item.done", item };
  return `event: x\ndata: ${JSON.stringify(event)}\n\n`;
}

function patchedItem(body: string): Readonly<Record<string, unknown>> {
  const dataLine = body
    .split("\n")
    .find((line) => line.startsWith("data: "))!;
  const parsed = JSON.parse(dataLine.slice(6)) as {
    item: Readonly<Record<string, unknown>>;
  };
  return parsed.item;
}

describe("deriveFunctionCallNamespaceIndex", () => {
  it("maps a function child claimed by exactly one namespace", () => {
    const index = indexFor();
    expect(index.childToNamespace.get("spawn_agent")).toBe("multi_agent_v1");
    expect(index.declaredNamespaceCount).toBe(3);
  });

  it("drops a child claimed by several namespaces", () => {
    const index = indexFor();
    expect(index.childToNamespace.has("js")).toBe(false);
    expect(index.ambiguousChildCount).toBe(1);
  });

  it("drops a child that is also declared as a top-level tool", () => {
    const index = deriveFunctionCallNamespaceIndex(
      requestBody([
        { type: "function", name: "read_thread", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "mcp__codex_app",
          tools: [
            { type: "function", name: "read_thread", parameters: { type: "object" } },
          ],
        },
      ]),
    )!;
    expect(index.childToNamespace.has("read_thread")).toBe(false);
    expect(index.childToNamespace.size).toBe(0);
  });

  it("ignores custom children because a repaired function_call would be fatal", () => {
    const index = deriveFunctionCallNamespaceIndex(
      requestBody([
        {
          type: "namespace",
          name: "n",
          tools: [{ type: "custom", name: "foo", format: { type: "text" } }],
        },
      ]),
    )!;
    expect(index.childToNamespace.has("foo")).toBe(false);
  });

  it("treats a same-named custom child as conflict evidence", () => {
    const index = deriveFunctionCallNamespaceIndex(
      requestBody([
        {
          type: "namespace",
          name: "n",
          tools: [
            { type: "custom", name: "f", format: { type: "text" } },
            { type: "function", name: "f", parameters: { type: "object" } },
          ],
        },
      ]),
    )!;
    expect(index.childToNamespace.has("f")).toBe(false);
    expect(index.ambiguousChildCount).toBe(1);
  });

  it("refuses a declaration whose text repeats a key", () => {
    const ambiguous =
      '{"model":"m","tools":[{"type":"namespace","name":"n","tools":[' +
      '{"type":"function","name":"f","name":"g","parameters":{}}]}]}';
    expect(deriveFunctionCallNamespaceIndex(ambiguous)).toBeUndefined();
  });

  it("ignores a repeated unrelated key and still reads the authority", () => {
    const body =
      '{"model":"m","metadata":{"x":1},"metadata":{"x":2},"tools":[' +
      '{"type":"namespace","name":"n","tools":[{"type":"function","name":"f"}]}]}';
    const index = deriveFunctionCallNamespaceIndex(body);
    expect(index?.childToNamespace.get("f")).toBe("n");
  });

  it("refuses a repeated top-level tools key", () => {
    const body =
      '{"model":"m","tools":[{"type":"namespace","name":"n","tools":[' +
      '{"type":"function","name":"f"}]}],"tools":[]}';
    expect(deriveFunctionCallNamespaceIndex(body)).toBeUndefined();
  });

  it("reads a real tool catalog whose arrays hold scalars", () => {
    const index = deriveFunctionCallNamespaceIndex(
      requestBody([
        { type: "function", name: "update_plan", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "multi_agent_v1",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              parameters: {
                type: "object",
                properties: {
                  fork_context: { type: "boolean", enum: [true] },
                  reasoning: { type: "string", enum: ["none", "low", "high"] },
                  mixed: { enum: ["a", 1, null] },
                  empty: { enum: [] },
                },
                required: ["fork_context", "reasoning"],
                additionalProperties: false,
              },
            },
          ],
        },
      ]),
    );
    expect(index?.childToNamespace.get("spawn_agent")).toBe("multi_agent_v1");
  });

  it("returns undefined when the request declares no namespace", () => {
    expect(
      deriveFunctionCallNamespaceIndex(
        requestBody([
          { type: "function", name: "exec_command", parameters: { type: "object" } },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("repairFunctionCallNamespaces", () => {
  it("fills a missing namespace on an item event", () => {
    const body = sseItem({
      type: "function_call",
      call_id: "call_1",
      name: "spawn_agent",
      arguments: '{"message":"ping"}',
      status: "completed",
    });
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    expect(repaired.patchedItemCount).toBe(1);
    expect(patchedItem(repaired.body)).toMatchObject({
      type: "function_call",
      name: "spawn_agent",
      namespace: "multi_agent_v1",
      call_id: "call_1",
    });
  });

  it("preserves every untouched byte", () => {
    const untouched = 'event: response.created\ndata: {"type":"response.created"}\n\n';
    const body = `${untouched}${sseItem({
      type: "function_call",
      name: "spawn_agent",
      arguments: "",
      call_id: "c",
    })}`;
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    expect(repaired.body.startsWith(untouched)).toBe(true);
    expect(repaired.body.replace(',"namespace":"multi_agent_v1"', "")).toBe(body);
  });

  it("leaves an already namespaced call unchanged", () => {
    const body = sseItem({
      type: "function_call",
      name: "spawn_agent",
      namespace: "multi_agent_v1",
      arguments: "{}",
      call_id: "c",
    });
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.body).toBe(body);
  });

  it("never rewrites a namespace value that is present", () => {
    for (const namespace of ["other", "", 7]) {
      const body = sseItem({
        type: "function_call",
        name: "spawn_agent",
        namespace,
        arguments: "{}",
        call_id: "c",
      });
      const repaired = repairFunctionCallNamespaces(body, indexFor());
      expect(repaired.kind, `namespace=${JSON.stringify(namespace)}`).toBe(
        "unchanged",
      );
      expect(repaired.body).toBe(body);
    }
  });

  it("leaves an ambiguous child alone", () => {
    const body = sseItem({
      type: "function_call",
      name: "js",
      arguments: "{}",
      call_id: "c",
    });
    expect(repairFunctionCallNamespaces(body, indexFor()).body).toBe(body);
  });

  it("never interprets a flattened name", () => {
    for (const name of [
      "multi_agent_v1_spawn_agent",
      "multi_agent_v1__spawn_agent",
      "mcp__multi_agent_v1__spawn_agent",
    ]) {
      const body = sseItem({
        type: "function_call",
        name,
        arguments: "{}",
        call_id: "c",
      });
      const repaired = repairFunctionCallNamespaces(body, indexFor());
      expect(repaired.kind, name).toBe("unchanged");
      expect(repaired.body).toBe(body);
    }
  });

  it("leaves an undeclared name alone", () => {
    const body = sseItem({
      type: "function_call",
      name: "not_declared",
      arguments: "{}",
      call_id: "c",
    });
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.body).toBe(body);
  });

  it("repairs the completed snapshot output array", () => {
    const body = `event: x\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [
          { type: "message", id: "msg_1" },
          { type: "function_call", name: "wait_agent", arguments: "{}", call_id: "c" },
        ],
      },
    })}\n\n`;
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    const dataLine = repaired.body
      .split("\n")
      .find((line) => line.startsWith("data: "))!;
    const parsed = JSON.parse(dataLine.slice(6)) as {
      response: { output: readonly unknown[] };
    };
    expect(parsed.response.output[1]).toMatchObject({
      name: "wait_agent",
      namespace: "multi_agent_v1",
    });
  });

  it("repairs a buffered JSON body", () => {
    const body = JSON.stringify({
      id: "resp_1",
      output: [
        { type: "function_call", name: "spawn_agent", arguments: "{}", call_id: "c" },
      ],
    });
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    expect(JSON.parse(repaired.body)).toMatchObject({
      output: [{ name: "spawn_agent", namespace: "multi_agent_v1" }],
    });
  });

  it("leaves an unparsable buffered body alone", () => {
    const body = '{"output":[{"type":"function_call","name":"spawn_agent"}],}';
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.body).toBe(body);
  });

  it("leaves an item with a duplicate key alone", () => {
    const body =
      'event: x\ndata: {"type":"response.output_item.done","item":{"type":"function_call",' +
      '"type":"message","name":"spawn_agent","arguments":"{}","call_id":"c"}}\n\n';
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.body).toBe(body);
  });

  it("fails open on an unparsable data line", () => {
    const body = 'event: x\ndata: {"type":"response.output_item.done","item":\n\n';
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.body).toBe(body);
  });

  it("ignores the [DONE] sentinel while scanning frames", () => {
    const body =
      sseItem({
        type: "function_call",
        name: "spawn_agent",
        arguments: "{}",
        call_id: "c",
      }) + "data: [DONE]\n\n";
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    expect(repaired.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("ignores a CRLF sentinel and a keep-alive frame", () => {
    const body =
      "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\"," +
      "\"name\":\"spawn_agent\",\"arguments\":\"{}\",\"call_id\":\"c\"}}\r\n\r\n" +
      "data:\r\n\r\n" +
      "data: [DONE]\r\n\r\n";
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    expect(repaired.body).toContain("data: [DONE]\r\n");
  });

  it("never rewrites an event type outside the certified carriers", () => {
    const body = `event: x\ndata: ${JSON.stringify({
      type: "response.future_event",
      item: { type: "function_call", name: "spawn_agent", arguments: "{}", call_id: "c" },
    })}\n\n`;
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.body).toBe(body);
  });

  it("repairs through a byte-order mark in a buffered JSON body", () => {
    const body = `\uFEFF${JSON.stringify({
      id: "resp_1",
      output: [
        { type: "function_call", name: "spawn_agent", arguments: "{}", call_id: "c" },
      ],
    })}`;
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    expect(repaired.body.startsWith("\uFEFF")).toBe(true);
    expect(repaired.body.replace(',"namespace":"multi_agent_v1"', "")).toBe(body);
  });

  it("repairs through a byte-order mark on the first SSE frame", () => {
    const body = `\uFEFF${sseItem({
      type: "function_call",
      name: "spawn_agent",
      arguments: "{}",
      call_id: "c",
    })}`;
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    expect(repaired.body.startsWith("\uFEFF")).toBe(true);
    expect(repaired.body.replace(',"namespace":"multi_agent_v1"', "")).toBe(body);
  });

  it("binds each certified carrier to its own event", () => {
    const call = {
      type: "function_call",
      name: "spawn_agent",
      arguments: "{}",
      call_id: "c",
    };
    const mismatches = [
      // response.completed carries response.output, never a top-level item.
      `event: x\ndata: ${JSON.stringify({ type: "response.completed", item: call })}\n\n`,
      // output_item.* carries a top-level item, never response.output.
      `event: x\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        response: { output: [call] },
      })}\n\n`,
      // A buffered response body carries a top-level output array.
      JSON.stringify({ id: "r", item: call }),
    ];
    for (const body of mismatches) {
      const repaired = repairFunctionCallNamespaces(body, indexFor());
      expect(repaired.kind, body.slice(0, 60)).toBe("unchanged");
      expect(repaired.body).toBe(body);
    }
  });

  it("abandons the body when a certified event has a malformed carrier", () => {
    const body =
      `event: x\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        item: 42,
      })}\n\n` +
      sseItem({
        type: "function_call",
        name: "spawn_agent",
        arguments: "{}",
        call_id: "c",
      });
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.patchedItemCount).toBe(0);
    expect(repaired.body).toBe(body);
  });

  it("skips a malformed frame that shows no carrier and still repairs later frames", () => {
    const body =
      'event: x\ndata: {"type":"response.output_item.done","item":\n\n' +
      sseItem({
        type: "function_call",
        name: "spawn_agent",
        arguments: "{}",
        call_id: "c",
      });
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("repaired");
    expect(repaired.patchedItemCount).toBe(1);
  });

  it("abandons the whole body when an unparsable frame looks like a carrier", () => {
    const body =
      'event: x\ndata: {"type":"response.output_item.done","item":{"type":"function_call","name":\n\n' +
      sseItem({
        type: "function_call",
        name: "spawn_agent",
        arguments: "{}",
        call_id: "c",
      });
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.patchedItemCount).toBe(0);
    expect(repaired.body).toBe(body);
  });

  it("abandons the whole snapshot when one output item is anomalous", () => {
    const body = `event: x\ndata: {"type":"response.completed","response":{"id":"r",` +
      '"output":[{"type":"function_call","type":"message","name":"spawn_agent",' +
      '"arguments":"{}","call_id":"a"},' +
      '{"type":"function_call","name":"wait_agent","arguments":"{}","call_id":"b"}]}}\n\n';
    const repaired = repairFunctionCallNamespaces(body, indexFor());
    expect(repaired.kind).toBe("unchanged");
    expect(repaired.body).toBe(body);
  });

  it("skips when the request declared no unique function child", () => {
    const repaired = repairFunctionCallNamespaces(
      sseItem({
        type: "function_call",
        name: "spawn_agent",
        arguments: "{}",
        call_id: "c",
      }),
      deriveFunctionCallNamespaceIndex(
        requestBody([{ type: "function", name: "x", parameters: { type: "object" } }]),
      ),
    );
    expect(repaired.kind).toBe("skipped");
  });
});
