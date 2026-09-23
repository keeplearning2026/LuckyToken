import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCorpus, validateCorpus } from "./corpus.mjs";
import { comparisonView, differences, normalizeResponses, compareCase } from "./report.mjs";
import { BASE_URL, createChatCapture, mockChatReply, readResponse, replayRequest } from "./wire.mjs";

test("corpus is reproducible, selectable, and includes independent protocol dimensions", () => {
  const cases = buildCorpus({ generated: 20, seed: 7 });
  assert.deepEqual(cases, buildCorpus({ generated: 20, seed: 7 }));
  assert.notDeepEqual(cases, buildCorpus({ generated: 20, seed: 8 }));
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const tag of ["roles", "image", "file", "tools", "custom", "namespace", "reasoning", "controls", "schema", "validation", "response", "replay", "generated"]) assert.ok(cases.some(item => item.tags.includes(tag)), tag);
});

test("input validation rejects ambiguous ids and nonterminating chunk sizes", () => {
  const cases = buildCorpus({ generated: 0 }).slice(0, 1);
  assert.throws(() => validateCorpus([...cases, ...cases]), /unique/u);
  assert.throws(() => validateCorpus([{ ...cases[0], id: "../escape" }]), /safe/u);
  assert.throws(() => validateCorpus([{ ...cases[0], steps: [{ request: {}, reply: { byteChunkSize: 0 } }] }]), /positive/u);
});

test("Responses normalization preserves model-visible values and call identities", () => {
  const input = { json: { id: "resp_random", created_at: 999, output: [{ id: "fc_random", type: "function_call", call_id: "call_original", arguments: '{"id":"resp_random","created_at":999}' }], metadata: { id: "resp_random" } }, events: [{ type: "response.output_item.done", item: { id: "fc_random", call_id: "call_original" } }] };
  const normalized = normalizeResponses(input);
  assert.equal(normalized.json.id, "<response-id>");
  assert.equal(normalized.json.output[0].id, normalized.events[0].item.id);
  assert.equal(normalized.json.output[0].call_id, "call_original");
  assert.equal(normalized.json.output[0].arguments, input.json.output[0].arguments);
  assert.equal(normalized.json.metadata.id, "resp_random");
  assert.equal(input.json.created_at, 999);
});

test("diff distinguishes missing, null, array order and model-visible changes", () => {
  const diff = differences({ a: null, messages: ["A", "B"], flag: false }, { messages: ["B", "A"], flag: true });
  assert.equal(diff.length, 4);
  assert.deepEqual(diff[0], { path: "$.a", token: { present: true, value: null }, opencodex: { present: false } });
});

test("streaming fixture preserves UTF-8 across byte fragments and interleaved tool argument deltas", async () => {
  const response = mockChatReply({ text: "汉字🙂", byteChunkSize: 1, deltaSize: 1, calls: [{ name: "first", arguments: { value: "一" } }, { name: "second", arguments: { value: "二" } }] }, { model: "model", stream: true });
  const text = await response.text();
  const events = readResponse(text, "text/event-stream").events;
  assert.equal(events.map(event => event.choices?.[0]?.delta?.content ?? "").join(""), "汉字🙂");
  for (const index of [0, 1]) {
    const args = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? []).filter(call => call.index === index).map(call => call.function.arguments).join("");
    assert.deepEqual(JSON.parse(args), { value: index ? "二" : "一" });
  }
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("SSE reader supports CRLF/multiline data and records malformed frames and DONE", () => {
  const parsed = readResponse('event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"id":"r","output":[]}}\r\n\r\ndata: broken\r\n\r\ndata: [DONE]\r\n\r\n', "text/event-stream");
  assert.equal(parsed.json.id, "r");
  assert.equal(parsed.parseError, "Invalid SSE JSON");
  assert.equal(parsed.framing.at(-1).done, true);
});

test("capture records serialized provider requests and replies without calling the network", async () => {
  const capture = createChatCapture();
  capture.begin({ text: "OK" });
  const response = await capture.fetch(`${BASE_URL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "model", stream: false }) });
  assert.equal((await response.json()).choices[0].message.content, "OK");
  assert.equal(capture.captures[0].body.model, "model");
  await assert.rejects(capture.fetch("https://external.invalid/"), /Unexpected outbound/u);
  assert.equal(capture.violations.length, 1);
});

test("complete-history replay uses each engine's own opaque state and tool relationships", () => {
  const response = { id: "resp_actual", output: [{ type: "reasoning", token_continuity: { attachment: "opaque" } }, { type: "function_call", name: "lookup", call_id: "actual_call", arguments: "{}" }] };
  const previous = { request: { input: "FIRST" }, response: { parsed: { json: response } } };
  const request = replayRequest({ request: { input: "NEXT" }, replay: "history" }, previous);
  assert.equal(request.input[1].token_continuity.attachment, "opaque");
  assert.equal(request.input[2].call_id, request.input[3].call_id);
  assert.equal(request.input[0].content, "FIRST");
  assert.equal(request.input[4].content, "NEXT");
  const chained = replayRequest({ request: { input: "NEXT" }, replay: "previous" }, previous);
  assert.equal(chained.previous_response_id, "resp_actual");
  assert.equal(chained.input[0].call_id, "actual_call");
  assert.equal(chained.input.length, 2);
});

test("unavailable prior response ids stop only the replay step", () => {
  assert.throws(() => replayRequest({ request: { input: "NEXT" }, replay: "history" }, { response: { status: 400 } }), /prior Responses response/u);
});

test("HTTP rejection remains an observed result, while worker failures are execution errors", () => {
  const result = { engine: "token", steps: [{ providerRequests: [], response: { status: 400, parsed: { json: { error: { message: "invalid" } }, events: [] } } }] };
  assert.equal(compareCase({ id: "x", tags: [] }, result, { ...result, engine: "opencodex" }).errors.length, 0);
  assert.equal(compareCase({ id: "x", tags: [] }, { ...result, error: { message: "timeout" } }, result).errors.length, 1);
  assert.equal(comparisonView(result)[0].status, 400);
});
