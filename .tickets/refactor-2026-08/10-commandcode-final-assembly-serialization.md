# 10 — Align CommandCode final request assembly and serialization

**What to build:** The resolved CommandCode target subtrees are assembled
into one `GenerateRequest`, passed through `onPayload` exactly once, and
serialized to a JSON body that is actually sent — with preparation failing
before send on any serialization error — per `PI AI IR-Commandcode Private
Conversion.md` Part I §11.

**Blocked by:** 09 — CommandCode message sequence and synthetic tool results.

**Status:** ready-for-agent

- [ ] Final assembly composes already-constructed values only; it never
  re-reads the Pi `Model`/`Context`/`options` to re-run message/tool/
  reasoning/config/session conversion.
- [ ] `onPayload` is invoked once at request preparation with the
  constructed `GenerateRequest` (body object, not method/endpoint/headers);
  `undefined` return keeps the original payload; a replacement becomes the
  effective payload; throw/rejection → preparation error, no request sent;
  retries reuse the already-prepared payload and never re-run conversion or
  the callback.
- [ ] Serialization: `JSON.stringify(effectivePayload)` must produce a
  string; throw or `undefined` → preparation error before send; no
  stringify→parse→full re-validation pass.
- [ ] The prepared request carries endpoint, stable application headers
  (no `traceparent`), and the authoritative serialized `bodyText`.
- [ ] Execution-boundary items (attempt headers, `traceparent`, fetch,
  timeout, retry, onResponse, response decode/reconstruction, cancellation)
  stay outside the semantic conversion and are not owned by this ticket's
  scope.
- [ ] Unit tests cover `onPayload` replacement/keep/throw, serialization
  failure (BigInt/circular), and retry-reuse behavior.

**Out of scope:** response reconstruction and Pi conversion (11–12).
