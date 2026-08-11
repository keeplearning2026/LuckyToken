# 03 — Complete model-aware Anthropic validity and invocation composition

**What to build:** Requests that need model knowledge to decide whether the
Pi target can faithfully represent them — image input capability, historical
thinking, final-assistant prefill — are classified before conversion using
the resolved Pi model and the Anthropic source profile, and the final Pi
options are composed from the protocol-derived controls plus
auth/session/project facts without letting either side leak into the other.

**Blocked by:** 02 — Anthropic request → Pi invocation construction align.

**Status:** ready-for-agent

- [ ] Image input validity uses the resolved `Model.input` and a
  certified-fidelity policy; `hasImages` without capability/fidelity is
  `UnsupportedFeature`.
- [ ] Historical thinking requires a reasoning-capable model
  (`Model.reasoning`), otherwise `UnsupportedFeature`.
- [ ] Final-assistant prefill is classified by the policy as
  `allowed | forbidden | unknown`; `forbidden` → `InvalidRequest`,
  `allowed`/`unknown` → `UnsupportedFeature`; no model-name guessing.
- [ ] `composeOptions` merges protocol-derived controls (maxTokens,
  temperature, metadata.user_id) with auth-owned `sessionId`, request signal,
  and projectDir (as `metadata.projectDir`) into a single
  `ModelsSimpleStreamOptions`; protocol options and router defaults never
  own provider-only or auth-only fields.
- [ ] After composition, raw credentials/token scope/file paths/lookup
  representation are gone; only `sessionId` and `projectDir?` continue into
  Pi option composition.
- [ ] Unit tests cover each classification branch and the composition
  ownership boundaries.

**Out of scope:** request validation/construction (01/02), response
conversion (04), rendering (05).
