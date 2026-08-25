# 12 — Use the effective alias everywhere clients discover and select models

**What to build:** Token exposes one consistent client-visible model identity across discovery and request paths: the generated `${providerId}/${defaultModelName}` alias when untouched, or the user's custom Model name after override.

**Blocked by:** 07 — Give every Catalog model an automatic Provider-scoped default Model name; 08 — Add model-scoped alias override and reset operations.

**Status:** ready-for-agent

- [ ] Add RED integration tests proving `/v1/models` exposes the generated default alias for every untouched effective model.
- [ ] Codex catalog generation exposes the same effective aliases as Token model discovery rather than reconstructing Provider/model names independently.
- [ ] Alias-only Anthropic/OpenAI Responses request selection resolves the generated default alias to the explicit canonical target.
- [ ] After a custom override, client discovery and request selection expose/use only the custom alias for that target; the generated default is no longer simultaneously accepted as an effective alias.
- [ ] Resetting the override restores the generated default consistently across `/v1/models`, Codex catalog generation, and request selection.
- [ ] Canonical Provider/model identity remains an internal routing fact; no new client-facing target-selection contract is introduced merely because generated defaults contain Provider/model text.
- [ ] Canonical model IDs containing `/` work end-to-end through slash-free external Model names without string-splitting assumptions.
- [ ] Existing `model_unavailable`, alias conflict, request snapshot, and in-flight resolution semantics remain fail-closed and deterministic.
