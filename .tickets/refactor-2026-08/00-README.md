# LuckyToken Protocol Conversion Refactor Tickets

**Created:** 2026-08-11
**Source of truth:**

- `doc/Spec/LuckyTokenCoreSpec.md` — core architecture spec (v5.6)
- `doc/Protocols/Anthropic-Pi AI IR Conversion Method.md` — Anthropic ↔ Pi AI IR conversion method
- `doc/Protocols/PI AI IR-Commandcode Private Conversion.md` — Pi AI IR ↔ CommandCode Private conversion method
- `doc/Protocols/Pi AI IR Protocol.md` — Pi AI IR protocol
- `doc/Protocols/CommandCode Private Protocol.md` — CommandCode Private protocol
- `pi-agent/packages/ai` — vendored Pi AI source (upstream-clean reference for Pi IR contracts)

## The two conversion sides are independent

The Pi AI IR is the single shared semantic boundary between Client Protocols
and Providers. The two conversion directions are **independent and
uncoupled**:

```text
Anthropic Wire            CommandCode Wire
     ↕                          ↕
Anthropic adapter          CommandCode adapter
     ↕                          ↕
         Pi AI IR (shared)
```

- The **Anthropic side** (tickets 01–05) only performs Anthropic Wire ↔ Pi
  conversion. It must never import, inspect, name, or make decisions from any
  concrete Provider or upstream protocol (CommandCode included).
- The **CommandCode side** (tickets 06–12) only performs Pi ↔ CommandCode
  conversion. It must never import, inspect, name, or make decisions from
  Anthropic, OpenAI Responses, or any other Client Protocol.
- Runtime/composition (ticket 13) may coordinate the two sides but must not
  absorb either side's semantic policy.

Therefore these tickets may be executed in parallel: each side's work is
blocked only by its own prerequisites, never by the other side. The only
shared surface is the Pi IR types and contracts exported by
`@earendil-works/pi-ai` (consumed as public contracts, never modified).

## How to read the tickets

Numbered `01`–`13` in dependency order within each side. Blockers are listed
per ticket. Files follow the local-ticket template from the `to-tickets`
skill.

## Note on docs vs. code naming

The current code uses files like `src/providers/commandcode-private/*.ts`
and `src/protocols/anthropic/*.ts`. The spec and conversion documents refer
to the same boundaries. When a ticket says "the CommandCode side" it means
the provider adapter under `src/providers/commandcode-private`, and when it
says "the Anthropic side" it means the client protocol adapter under
`src/protocols/anthropic`.

## Verification baseline

- `npm run typecheck` — passes
- `npm run test:unit` — passes (260 tests)
- `npm run test:integration` — passes (65 tests)
- `npm run test:certification` — **fails** because the two conversion
  documents were renamed/revised and the certification manifests still bind
  to the old names/markers (see tickets 13/14).
