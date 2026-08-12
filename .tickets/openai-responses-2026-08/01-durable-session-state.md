# 01 — Durable session state with previous_response_id expansion

**What to build:** A Codex client that sends incremental Requests turns with
`previous_response_id` gets its conversation history expanded to the full
input, and that history **survives a LuckyToken process restart** — a client
that references a response from before the restart continues seamlessly.
Session state is owned entirely by the Responses Client Protocol adapter.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] In-memory store maps `response_id → {createdAt, items}`; `items` are raw
  wire items `[...inputItems(request.input), ...response.output]` (no Pi
  representation stored).
- [ ] `inputItems` normalizes `undefined → []`, array → itself, string → one
  user message item.
- [ ] `rememberResponseState` saves when `id` is non-empty string, `output` is
  array, and status is `completed` or `incomplete` with
  `incomplete_details.reason === "max_output_tokens"`; **ignores `store:false`**
  (unconditional save); **skips** a request whose own `previous_response_id`
  failed to expand (anti-poisoning).
- [ ] `expandPreviousResponseInput` returns the body unchanged when
  `previous_response_id` is absent or unknown (fail-open); otherwise prepends
  the stored items to the current input.
- [ ] Durable snapshot: default `<config-dir>/.luckytoken/state/openai-responses.json`
  (overridable), format `{version: 2, states: [[id, {createdAt, items}]]}`.
- [ ] Write strategy: 2s debounce (unref'd timer), single-flight gate, atomic
  tmp+rename, 0600 mode, failures swallowed, `flush()` for shutdown/tests.
- [ ] Load strategy: lazy on first access; missing → empty; >32MB → refuse;
  corrupt → backup as `<file>.corrupt` + empty start; orphan tmp cleanup (pattern,
  pid not alive, mtime >15min); never crashes the server.
- [ ] Bounds: 1000 entries FIFO eviction by createdAt; no TTL.
- [ ] Unit tests cover save conditions, expansion, fail-open, FIFO eviction,
  snapshot round-trip (save → new instance load), atomic write/tmp cleanup,
  corrupt backup, 32MB ceiling, orphan tmp cleanup, and flush.

**Out of scope:** wire ↔ Pi conversion (ticket 02), response rendering
(ticket 03), handler orchestration (ticket 04).
