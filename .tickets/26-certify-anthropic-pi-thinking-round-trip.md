# 26 — Certify Anthropic and Pi thinking round-trip

**What to build:** Extend the certified Client Protocol capability to preserve ordinary Pi `ThinkingContent` through Anthropic JSON, Atomic SSE, and the next Anthropic request after real CommandCode evidence proved the default reasoning model reaches this path.

**Blocked by:** 25 — Integrate Pi login and persistent credentials.

**Status:** complete

- [x] Update the Anthropic ↔ Pi conversion specification before widening implementation; normal thinking, opaque signature handling, unsupported redacted thinking, and explicit thinking-control policy remain distinct.
- [x] A reasoning-capable CommandCode model preserves reasoning as Pi `ThinkingContent`; a non-reasoning model still rejects unexpected reasoning.
- [x] Committed ordinary Pi `ThinkingContent` maps losslessly to an Anthropic `thinking` block in JSON, including one deterministic representation for absent Pi signature state.
- [x] Atomic SSE emits a complete thinking lifecycle consumable by the official Anthropic SDK and semantically equal to the JSON target.
- [x] A subsequent Anthropic request converts the prior assistant thinking block back to Pi and then to CommandCode reasoning without textification, omission, or Provider vocabulary entering the Client Protocol.
- [x] Redacted thinking, malformed thinking/signature state, explicit source thinking controls, and unsupported Provider-owned reasoning state fail explicitly.
- [x] Serving certification binds the new capability, real tests, and immutable conformance hash.
- [x] Full tests, typecheck, lint, build, and diff check pass.
