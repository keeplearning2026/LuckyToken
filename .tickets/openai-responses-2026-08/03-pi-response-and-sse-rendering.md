# 03 — Pi IR → Responses wire response + atomic SSE rendering

**What to build:** A committed Pi `AssistantMessage` renders as a faithful
Responses response object, and (when `stream: true`) as the canonical atomic
SSE sequence Codex accepts. No Pi semantic is lost or misrepresented.

**Blocked by:** 02 — Responses wire → Pi IR request conversion (needs the
converted invocation shape).

**Status:** ready-for-agent

- [ ] Response object: `id` (`resp_<uuid>`), `object: "response"`, `created_at`
  (seconds), `status`, `model` (echo client selector), `output`, optional
  `previous_response_id` echo, `usage`.
- [ ] Output items: text/thinking → message item (`output_text` parts, role
  assistant); thinking additionally → reasoning item; toolCall → `function_call`
  item (`{call_id, name, arguments: JSON.stringify, status:"completed"}`).
- [ ] `status` mapping: stop → completed; length → incomplete +
  `incomplete_details.reason = "max_output_tokens"`; toolUse → completed; other
  → fidelity failure.
- [ ] `usage` mapping: `input_tokens`/`output_tokens`/`total_tokens` +
  `input_tokens_details.cached_tokens` + `output_tokens_details.reasoning_tokens`
  (omitted when zero/absent).
- [ ] Strict fidelity validation (field whitelist + lossless JSON, mirroring
  the Anthropic response converter pattern).
- [ ] Error response shape `{error: {type, message}}` with status/type table.
- [ ] SSE: atomic sequence `response.created` (status `in_progress`, output `[]`)
  → `response.output_item.done` per item (`{output_index, item}`) →
  `response.completed` (full response) → `data: [DONE]`.
- [ ] Unit tests cover field mapping, stopReason/usage branches, SSE sequence
  and `[DONE]`, and fidelity failures.

**Out of scope:** session state (ticket 01), handler orchestration (ticket 04).
