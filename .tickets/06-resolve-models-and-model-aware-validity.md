# 06 — Resolve models and enforce model-aware validity

**What to build:** Resolve the client model selector deterministically through Pi Models and use the resulting model plus evidence-bound Anthropic policy to decide model-dependent source validity and Pi representability before conversion.

**Blocked by:** 05 — Implement Anthropic source-profile and closed-world validation.

**Status:** ready-for-agent

- [ ] Selector resolution is deterministic and rejects unknown or ambiguous selectors without fuzzy matching, catalog-order fallback, or credential-based guessing.
- [ ] A resolved Pi `Model` becomes the authoritative model representation; selector parsing/candidate state no longer propagates.
- [ ] Model-resolution failures retain Router/model-resolution classification and are not relabeled by the conversion layer.
- [ ] Image acceptance requires both declared model input capability and a certified image-fidelity path.
- [ ] Final-assistant prefill uses the bound `allowed | forbidden | unknown` policy: forbidden is invalid, allowed is unsupported in v1, and unknown is unsupported without guessing.
- [ ] Other model-dependent restrictions use Pi capabilities or an equally narrow evidence-bound policy; model-name substrings and marketing-family heuristics are forbidden.
- [ ] Source-valid but Pi-unrepresentable semantics fail explicitly before deterministic conversion.

