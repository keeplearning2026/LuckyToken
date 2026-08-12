# 04 — OpenAI Responses handler orchestration (auth, errors, cancellation)

**What to build:** `POST /v1/responses` is served end-to-end: authenticated
requests are validated, expanded, converted, executed through Pi, and answered
with JSON or SSE; failures map to correct Responses errors; cancellation
propagates cleanly. The handler is a `ClientProtocolHandler` routed by
method+pathname.

**Blocked by:** 02 — Responses wire → Pi IR request conversion; 03 — Pi IR →
Responses wire response + atomic SSE rendering.

**Status:** ready-for-agent

- [ ] `createOpenAIResponsesHandler` returns `{method: "POST", pathname:
  "/v1/responses", handle}`.
- [ ] Pipeline: Content-Type check (415) → independent `Auth.resolve` (401) →
  body read with maxRequestBytes (413) → JSON.parse (400) → validation (400) →
  `expandPreviousResponseInput` → wire → Pi conversion → `resolveModel` via
  selectorTool (404) → `composeOptions` (sessionId/signal/fetch observer/
  projectDir) → `freezePiInvocation` + `execute` → `rememberResponseState` →
  `stream ? SSE : JSON`.
- [ ] Model resolution reuses `src/model-resolution.ts` (`selectorTool`/
  `resolveModel`); no provider-specific import.
- [ ] Error mapping: `InvalidRequest` → 400, `ModelResolutionFailure` → 404,
  `ExecutionAbortedError`/request abort → `HttpRequestAbortedError`,
  `ExecutionFailure` → 502, unknown → 500; observed non-2xx upstream HTTP →
  status-mapped error.
- [ ] Cancellation: request signal abort propagates to `execute`; no state
  saved for aborted turns; no write to closed responses.
- [ ] `rememberResponseState` is called only after successful execution with a
  completed/incomplete-max_output_tokens response.
- [ ] Integration tests via a serving composition (injected fetch + fixture
  upstream): incremental expansion, multi-turn history assembly, SSE, auth
  isolation, error statuses, cancellation.

**Out of scope:** composition/config wiring (ticket 05).
