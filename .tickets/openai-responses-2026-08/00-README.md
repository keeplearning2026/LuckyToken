# OpenAI Responses Client Protocol Tickets

**Created:** 2026-08-12

**Source of truth:**

- `doc/Protocols/OpenAI Responses Client Protocol.md` — this protocol's spec
  (v0.1.0, Draft)
- `doc/Protocols/Pi AI IR Protocol.md` — Pi IR boundary
- `doc/OpenAIResponsesAdapter-Research.md` — opencodex research + decision record
- `pi-agent/packages/ai` — vendored Pi AI source (read-only reference for Pi IR
  contracts and the reverse Responses conversion)
- `D:\project\opencodex` — opencodex reference implementation (state.ts,
  parser.ts, responses-json-events.ts, core.ts)

## The new Client Protocol is independent

OpenAI Responses is a second Client Protocol alongside Anthropic Messages. It
performs only **Responses Wire ↔ Pi IR** conversion plus its own session state;
it never imports, inspects, names, or makes decisions from any concrete Provider
or upstream protocol. The Provider side is untouched.

```text
OpenAI Responses Wire        Anthropic Wire
        ↕                          ↕
Responses adapter            Anthropic adapter
  ├ session state                 ↕
  ├ expansion                 Pi AI IR (shared)
  └ wire ↔ Pi conversion
```

## Decision record (grilling 2026-08-12)

See `doc/Protocols/OpenAI Responses Client Protocol.md` §6 for the full table.
Highlights: durable disk snapshot (survives restart), raw wire items stored
(not Pi Context), unconditional save (ignore `store:false`), expansion-failure
turn not saved, fail-open expansion, 1000 entries + 32MB file ceiling, no TTL,
atomic tmp/rename writes, corrupt snapshot → backup + empty start, optional
protocol registration with independent auth + stateFile.

## How to read the tickets

Numbered `01`–`05` in dependency order. Blockers are listed per ticket. Files
follow the local-ticket template from the `to-tickets` skill.

## Verification baseline

- `npm run typecheck` — passes
- `npm test` — passes
- `npm run lint` — passes
- `npm run build` — passes
