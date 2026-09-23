import { MODEL } from "./wire.mjs";

export const lookup = { type: "function", name: "lookup", description: "Look up a value", parameters: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
} };
const call = { type: "function_call", call_id: "call_seed", name: "lookup", arguments: '{"query":"seed"}' };
const output = { type: "function_call_output", call_id: "call_seed", output: "SEED_RESULT" };
const reasoning = { type: "reasoning", id: "rs_seed", summary: [{ type: "summary_text", text: "VISIBLE_REASONING" }] };
const user = content => ({ role: "user", content });
const assistant = content => ({ role: "assistant", content });
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9nQAAAAASUVORK5CYII=";
const base = { model: MODEL, input: "Hello protocol", max_output_tokens: 128, store: false };

export function validateCorpus(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("Corpus must be a non-empty array of scenarios");
  const ids = new Set();
  for (const scenario of value) {
    if (!scenario || typeof scenario.id !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,119}$/u.test(scenario.id) || ids.has(scenario.id)) throw new Error("Scenario ids must be unique safe names (1-120 characters)");
    ids.add(scenario.id);
    if (!Array.isArray(scenario.tags) || scenario.tags.some(tag => typeof tag !== "string")) throw new Error(`${scenario.id}: tags must be strings`);
    if (!Array.isArray(scenario.steps) || !scenario.steps.length) throw new Error(`${scenario.id}: steps must be non-empty`);
    if (scenario.profile !== undefined && !["standard", "no-reasoning", "no-mid-system"].includes(scenario.profile)) throw new Error(`${scenario.id}: unknown profile`);
    for (const [index, step] of scenario.steps.entries()) {
      if (!step.request || typeof step.request !== "object" || Array.isArray(step.request)) throw new Error(`${scenario.id}: request must be an object`);
      if (step.replay !== undefined && (index === 0 || !["history", "previous"].includes(step.replay))) throw new Error(`${scenario.id}: invalid replay`);
      const reply = step.reply ?? {};
      if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error(`${scenario.id}: reply must be an object`);
      for (const key of ["deltaSize", "byteChunkSize"]) if (reply[key] !== undefined && (!Number.isSafeInteger(reply[key]) || reply[key] < 1)) throw new Error(`${scenario.id}: ${key} must be a positive integer`);
      if (reply.calls !== undefined && (!Array.isArray(reply.calls) || reply.calls.some(item => typeof item?.name !== "string" && (!Number.isSafeInteger(item?.toolIndex) || item.toolIndex < 0)))) throw new Error(`${scenario.id}: reply.calls require a name or nonnegative toolIndex`);
      if (reply.raw !== undefined && (!reply.raw || typeof reply.raw !== "object" || !("body" in reply.raw))) throw new Error(`${scenario.id}: raw reply requires body`);
    }
  }
  return value;
}

export function buildCorpus({ generated = 32, seed = 20260922 } = {}) {
  const cases = [];
  function add(id, tags, patch, reply = {}, profile) {
    for (const stream of [false, true]) cases.push({
      id: `${id}.${stream ? "sse" : "json"}`, tags: [...tags, stream ? "sse" : "json"],
      ...(profile ? { profile } : {}), steps: [{ request: { ...base, ...patch, stream }, reply }],
    });
  }
  add("text.string", ["messages"], {});
  add("text.parts", ["messages"], { input: [user([{ type: "input_text", text: "first" }, { type: "input_text", text: "第二段🙂" }])] });
  add("text.history", ["messages", "history"], { input: [user("ONE"), assistant("TWO"), user("THREE")] });
  add("text.instructions", ["roles"], { instructions: "TOP_LEVEL", input: [{ role: "system", content: "SYSTEM" }, { role: "developer", content: "DEVELOPER" }, user("USER")] });
  for (const role of ["system", "developer"]) {
    add(`roles.mid-${role}`, ["roles", "history"], { input: [user("ONE"), assistant("TWO"), { role, content: "MID_INSTRUCTION" }, user("THREE")] });
    add(`roles.tool-gap-${role}`, ["roles", "tools", "history"], { tools: [lookup], input: [user("LOOKUP"), call, { role, content: "MID_INSTRUCTION" }, output, user("CONTINUE")] });
  }
  add("roles.unsupported-mid-system", ["roles", "capability"], { input: [user("ONE"), { role: "system", content: "MID" }, user("TWO")] }, {}, "no-mid-system");
  add("image.inline", ["image"], { input: [user([{ type: "input_text", text: "Describe" }, { type: "input_image", image_url: image }])] });
  add("image.reference", ["image", "validation"], { input: [user([{ type: "input_image", file_id: "file_fixture" }])] });
  add("file.inline", ["file"], { input: [user([{ type: "input_file", filename: "fixture.txt", file_data: "data:text/plain;base64,SEVMTE8=" }])] });
  add("tools.function", ["tools"], { tools: [lookup] });
  add("tools.strict", ["tools", "schema"], { tools: [{ ...lookup, strict: true }] });
  add("tools.custom", ["tools", "custom"], { tools: [{ type: "custom", name: "patch", description: "Apply a patch", format: { type: "text" } }] }, { calls: [{ name: "patch", arguments: { input: "PATCH\n汉字" } }] });
  add("tools.grammar", ["tools", "custom", "schema"], { tools: [{ type: "custom", name: "patch", format: { type: "grammar", syntax: "lark", definition: 'start: "ok"' } }] });
  add("tools.namespace", ["tools", "namespace"], { tools: [{ type: "namespace", name: "alpha", description: "A", tools: [lookup] }, { type: "namespace", name: "beta", description: "B", tools: [lookup] }] });
  add("tools.hosted", ["tools", "hosted"], { tools: [{ type: "web_search" }, { type: "tool_search" }, lookup] });
  add("tools.history", ["tools", "history"], { tools: [lookup], input: [user("LOOKUP"), call, output, user("NEXT")] });
  add("tools.parallel-history", ["tools", "history", "parallel"], { tools: [lookup], input: [user("LOOKUP"), call, { ...call, call_id: "call_other" }, { ...output, call_id: "call_other", output: "OTHER" }, output, user("NEXT")] });
  for (const [name, result] of [["empty", ""], ["unicode", "汉字🙂\nline\tend"], ["parts", [{ type: "input_text", text: "RESULT_PART" }]]]) {
    add(`tools.result-${name}`, ["tools", "history"], { tools: [lookup], input: [user("LOOKUP"), call, { ...output, output: result }, user("NEXT")] });
  }
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "future-level"]) add(`reasoning.${effort}`, ["reasoning", "controls"], { reasoning: { effort } });
  add("reasoning.summary", ["reasoning", "controls"], { reasoning: { effort: "high", summary: "detailed" } });
  add("reasoning.history", ["reasoning", "history"], { tools: [lookup], input: [user("LOOKUP"), reasoning, call, output, user("NEXT")] });
  add("reasoning.after-call", ["reasoning", "history"], { tools: [lookup], input: [user("LOOKUP"), call, reasoning, output, user("NEXT")] });
  add("reasoning.nonreasoning-target", ["reasoning", "capability"], { reasoning: { effort: "high" }, input: [user("ONE"), reasoning, assistant("TWO"), user("THREE")] }, {}, "no-reasoning");
  for (const [name, choice] of [["auto", "auto"], ["none", "none"], ["required", "required"], ["named", { type: "function", name: "lookup" }], ["allowed", { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "lookup" }] }]]) {
    add(`controls.tool-choice-${name}`, ["controls", "tool-choice"], { tools: [lookup], tool_choice: choice });
  }
  for (const parallel of [true, false]) add(`controls.parallel-${parallel}`, ["controls", "parallel"], { tools: [lookup], parallel_tool_calls: parallel });
  add("controls.sampling", ["controls"], { temperature: 0.3, top_p: 0.8, stop: ["END"], presence_penalty: 0.2, frequency_penalty: 0.1 });
  add("controls.max-one", ["controls"], { max_output_tokens: 1 });
  add("controls.json-schema", ["controls", "schema"], { text: { format: { type: "json_schema", name: "answer", strict: true, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } } }, { text: '{"answer":"OK"}' });
  add("controls.json-object", ["controls", "schema"], { text: { format: { type: "json_object" } } });
  add("controls.metadata-cache", ["controls", "unconsumed"], { metadata: { fixture: "keep?" }, prompt_cache_key: "fixture-key", prompt_cache_retention: "24h", service_tier: "priority", include: ["reasoning.encrypted_content"] });
  add("controls.unconsumed-shape", ["validation", "unconsumed"], { metadata: 42, top_p: { intentionally: "unconsumed" }, future_control: [false] });
  add("validation.unknown-item", ["validation"], { input: [{ type: "future_item", text: "VISIBLE?" }, user("NEXT")] });
  add("validation.orphan-output", ["validation", "tools"], { tools: [lookup], input: [output, user("NEXT")] });
  add("validation.unresolved-call", ["validation", "tools"], { tools: [lookup], input: [user("LOOKUP"), call, user("NEXT")] });
  add("validation.bad-arguments", ["validation", "tools"], { tools: [lookup], input: [user("LOOKUP"), { ...call, arguments: "{broken" }, output, user("NEXT")] });
  add("validation.empty-input", ["validation"], { input: [] });
  add("validation.bad-input", ["validation"], { input: 42 });
  add("validation.bad-limit", ["validation"], { max_output_tokens: -1 });
  const replies = [
    ["unicode-fragments", { text: "第一行🙂\nsecond line", byteChunkSize: 1, deltaSize: 1 }],
    ["reasoning", { reasoning: "THINKING_CONTENT", text: "FINAL" }],
    ["reasoning-field", { reasoning: "THINKING_CONTENT", reasoningField: "reasoning", text: "FINAL" }],
    ["reasoning-text-field", { reasoning: "THINKING_CONTENT", reasoningField: "reasoning_text", text: "FINAL" }],
    ["tool", { calls: [{ name: "lookup", arguments: { query: "汉字🙂" } }] }],
    ["parallel-tools", { calls: [{ name: "lookup", arguments: { query: "ONE" } }, { name: "lookup", arguments: { query: "TWO" } }], deltaSize: 1 }],
    ["length", { text: "TRUNCATED", finish: "length" }],
    ["filter", { text: "", finish: "content_filter", refusal: "REFUSED" }],
    ["zero-usage", { text: "ZERO", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }],
    ["truncated-stream", { text: "PARTIAL", truncate: true }],
    ["invalid-arguments", { calls: [{ name: "lookup", arguments: "{broken" }] }],
    ["http-400", { raw: { status: 400, body: { error: { type: "invalid_request_error", message: "FIXTURE_INVALID" } } } }],
    ["http-429", { raw: { status: 429, headers: { "content-type": "application/json", "retry-after": "0" }, body: { error: { type: "rate_limit_error", message: "FIXTURE_RATE_LIMIT" } } } }],
    ["http-500", { raw: { status: 500, body: { error: { type: "server_error", message: "FIXTURE_SERVER_ERROR" } } } }],
  ];
  for (const [name, reply] of replies) add(`response.${name}`, ["response", ...(name.startsWith("http") ? ["errors"] : [])], { tools: [lookup] }, reply);
  for (const replay of ["history", "previous"]) for (const store of [true, false]) for (const stream of [true, false]) cases.push({
    id: `replay.${replay}.store-${store}.${stream ? "sse" : "json"}`, tags: ["replay", replay, "tools", "reasoning", stream ? "sse" : "json"],
    steps: [
      { request: { ...base, store, stream, tools: [lookup] }, reply: { reasoning: "TOOL_REASONING", calls: [{ name: "lookup", arguments: { query: "REPLAY" } }] } },
      { replay, request: { ...base, store, stream, tools: [lookup], input: "Continue from the result" }, reply: { text: "REPLAY_OK" } },
    ],
  });
  for (const [name, tools, argumentsValue] of [
    ["namespace", [{ type: "namespace", name: "alpha", tools: [lookup] }], { query: "NAMESPACE_REPLAY" }],
    ["custom", [{ type: "custom", name: "patch" }], { input: "PATCH_CONTENT\n汉字" }],
  ]) for (const stream of [true, false]) cases.push({
    id: `replay.${name}.${stream ? "sse" : "json"}`, tags: ["replay", "tools", name, stream ? "sse" : "json"],
    steps: [
      { request: { ...base, stream, tools }, reply: { calls: [{ toolIndex: 0, arguments: argumentsValue }] } },
      { replay: "history", request: { ...base, stream, tools, input: "Continue" }, reply: { text: "REPLAY_OK" } },
    ],
  });
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const pick = items => items[Math.floor(random() * items.length)];
  for (let i = 0; i < generated; i++) {
    const stream = pick([true, false]);
    const tools = pick([true, false]);
    const input = pick(["PLAIN", [user("START"), assistant("HISTORY"), user("END")], [user("START"), { role: "developer", content: "MID" }, user("END")]]);
    cases.push({ id: `generated.${seed}.${String(i).padStart(4, "0")}`, tags: ["generated", "controls", "messages", stream ? "sse" : "json"], steps: [{
      request: { ...base, input, stream, temperature: pick([0, 0.5, 1]), max_output_tokens: pick([1, 128, 4096]), reasoning: { effort: pick(["none", "low", "high"]) },
        ...(tools ? { tools: [lookup], tool_choice: pick(["auto", "none", "required"]), parallel_tool_calls: pick([true, false]) } : {}),
      }, reply: { text: `GENERATED_${i}_汉字🙂`, ...(pick([true, false]) ? { reasoning: "GENERATED_REASONING" } : {}), deltaSize: pick([1, 3, 100]) },
    }] });
  }
  return validateCorpus(cases);
}
