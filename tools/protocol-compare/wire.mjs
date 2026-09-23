// Wire-only helpers. This module does not import either implementation.
export const BASE_URL = "https://protocol-compare.invalid/v1";
export const MODEL = "compare/model";

export function readResponse(text, contentType = "") {
  if (!contentType.includes("text/event-stream")) {
    try { return { json: JSON.parse(text), events: [] }; }
    catch { return { text, events: [], parseError: "Response is not JSON" }; }
  }
  const events = [];
  const errors = [];
  const framing = [];
  for (const block of text.replaceAll("\r\n", "\n").split(/\n\n/u)) {
    const data = block.split("\n").filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /u, "")).join("\n");
    if (!data) continue;
    const eventName = block.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim() ?? null;
    framing.push({ event: eventName, done: data === "[DONE]" });
    if (data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch { errors.push(data); }
  }
  const terminal = events.findLast(event =>
    ["response.completed", "response.incomplete", "response.failed"].includes(event.type));
  return {
    events, framing,
    ...(terminal?.response ? { json: terminal.response } : {}),
    ...(errors.length ? { parseError: "Invalid SSE JSON", invalidData: errors } : {}),
  };
}

export function replayRequest(step, previous) {
  const request = structuredClone(step.request);
  if (!step.replay) return request;
  if (!previous?.response?.parsed?.json?.id) throw new Error("Replay requires a prior Responses response with an id");
  const response = previous.response.parsed.json;
  const output = response.output ?? [];
  const results = output.flatMap(item => {
    if (item.type === "function_call") return [{ type: "function_call_output", call_id: item.call_id, output: step.toolOutput ?? "TOOL_RESULT_OK" }];
    if (item.type === "custom_tool_call") return [{ type: "custom_tool_call_output", call_id: item.call_id, output: step.toolOutput ?? "TOOL_RESULT_OK" }];
    return [];
  });
  const items = input => typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  if (step.replay === "history") {
    request.input = [...items(previous.request.input), ...output, ...results, ...items(request.input)];
  } else {
    request.previous_response_id = response.id;
    request.input = [...results, ...items(request.input)];
  }
  return request;
}

export function mockChatReply(recipe, request) {
  if (recipe.raw !== undefined) {
    const raw = recipe.raw;
    return new Response(typeof raw.body === "string" ? raw.body : JSON.stringify(raw.body), {
      status: raw.status ?? 200,
      headers: raw.headers ?? { "content-type": "application/json" },
    });
  }
  const calls = recipe.calls ?? [];
  const message = { role: "assistant", content: recipe.text ?? (calls.length ? null : "PROTOCOL_COMPARE_OK") };
  if (recipe.reasoning !== undefined) message[recipe.reasoningField ?? "reasoning_content"] = recipe.reasoning;
  if (recipe.refusal !== undefined) message.refusal = recipe.refusal;
  if (calls.length) message.tool_calls = calls.map((call, index) => ({
    id: call.id ?? `call_${index + 1}`, type: "function",
    function: { name: call.name ?? request.tools?.[call.toolIndex]?.function?.name ?? request.tools?.[call.toolIndex]?.custom?.name ?? "fixture_missing_tool", arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}) },
  }));
  const finish = recipe.finish ?? (calls.length ? "tool_calls" : "stop");
  const usage = recipe.usage ?? {
    prompt_tokens: 20, completion_tokens: 8, total_tokens: 28,
    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 },
  };
  const envelope = { id: "chatcmpl_fixture", object: "chat.completion", created: 1_700_000_000, model: request.model };
  if (!request.stream) return Response.json({ ...envelope, choices: [{ index: 0, message, finish_reason: finish }], usage });
  const chunks = [];
  const emit = (delta, finish_reason = null) => chunks.push({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
  emit({ role: "assistant" });
  const segments = value => {
    const chars = Array.from(value);
    const size = recipe.deltaSize ?? 5;
    return Array.from({ length: Math.ceil(chars.length / size) }, (_, i) => chars.slice(i * size, (i + 1) * size).join(""));
  };
  if (recipe.reasoning !== undefined) for (const part of segments(recipe.reasoning)) emit({ [recipe.reasoningField ?? "reasoning_content"]: part });
  if (message.content) for (const part of segments(message.content)) emit({ content: part });
  if (recipe.refusal !== undefined) emit({ refusal: recipe.refusal });
  const toolSegments = (message.tool_calls ?? []).map(call => segments(call.function.arguments));
  for (let index = 0; index < calls.length; index++) {
    const call = message.tool_calls[index];
    emit({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] });
  }
  // Interleave multiple calls by index to exercise streaming assembly.
  for (let part = 0; part < Math.max(0, ...toolSegments.map(parts => parts.length)); part++) {
    for (let index = 0; index < calls.length; index++) {
      if (toolSegments[index][part] !== undefined) emit({ tool_calls: [{ index, function: { arguments: toolSegments[index][part] } }] });
    }
  }
  if (!recipe.truncate) {
    emit({}, finish);
    chunks.push({ ...envelope, object: "chat.completion.chunk", choices: [], usage });
  }
  const sse = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (recipe.truncate ? "" : "data: [DONE]\n\n");
  const bytes = new TextEncoder().encode(sse);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + (recipe.byteChunkSize ?? bytes.length));
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

export function createChatCapture() {
  let recipe;
  let captures = [];
  const violations = [];
  return {
    begin(next) { recipe = next; captures = []; },
    get captures() { return captures; },
    violations,
    async fetch(input, init) {
      const request = new Request(input, init);
      if (request.url !== `${BASE_URL}/chat/completions` || request.method !== "POST") {
        violations.push({ method: request.method, url: request.url });
        throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
      }
      if (captures.length >= 8) throw new Error("Provider attempt limit exceeded (8)");
      const text = await request.text();
      const body = JSON.parse(text);
      const response = mockChatReply(recipe, body);
      const responseText = await response.clone().text();
      captures.push({
        method: request.method, url: request.url, body, bodyText: text,
        response: { status: response.status, headers: Object.fromEntries(response.headers), bodyText: responseText },
      });
      return response;
    },
  };
}
